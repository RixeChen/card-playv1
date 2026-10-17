/* 端到端冒烟测试（需先启动服务）：node scripts/e2e.js
 * 用 3 个真实 socket 客户端建一个唬牌房，走完
 * 「建房 → 加入 → 开局 → 喊牌 → 跟牌 → 质疑 → 放弃 → 出完手牌获胜」。
 */
'use strict';
var io = require('socket.io-client');
var Cards = require('../public/shared/cards.js');
var URL = process.env.URL || 'http://127.0.0.1:3000';

function client(name) {
  var s = io(URL, { transports: ['websocket'] });
  var box = { sock: s, name: name, snap: null, meId: null };
  s.on('state', function (snap) { box.snap = snap; box.meId = snap.room.meId; });
  return new Promise(function (res) { s.on('connect', function () { res(box); }); });
}
function call(b, evt, data) { return new Promise(function (res) { b.sock.emit(evt, data, function (r) { res(r || {}); }); }); }
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 200); }); }
function must(r, what) { if (!r.ok) throw new Error(what + '失败：' + r.error); }
function rankLabel(r) { return r === 'BJ' ? '小王' : (r === 'RJ' ? '大王' : r); }

(async function () {
  var A = await client('小明'), B = await client('小红'), C = await client('小刚');
  var all = [A, B, C];

  var r = await call(A, 'createRoom', { gameId: 'cheat', name: '小明' });
  must(r, '建房');
  console.log('✓ 建房成功，房间号 =', r.roomId);

  must(await call(B, 'joinRoom', { roomId: r.roomId, name: '小红' }), 'B 加入');
  must(await call(C, 'joinRoom', { roomId: r.roomId, name: '小刚' }), 'C 加入');
  await tick();
  console.log('✓ 3 人入座，人数 =', A.snap.room.players.length);

  must(await call(A, 'startGame', {}), '开局');
  await tick();
  var v = A.snap.view;
  console.log('✓ 开局，阶段 =', v.stage, '，总手牌 =', v.players.reduce(function (n, p) { return n + p.handCount; }, 0), '张');
  if (v.players.reduce(function (n, p) { return n + p.handCount; }, 0) !== 52) throw new Error('发牌数不是 52');

  /* ---- 第一手：当前玩家喊牌 ---- */
  var cur = all.filter(function (x) { return x.snap.view.myTurn; })[0];
  if (!cur) throw new Error('找不到当前出牌者');
  var cv = cur.snap.view;
  console.log('✓ 当前出牌者 =', cur.name, '，手牌', cv.myHand.length, '张，必须领出 =', cv.mustLead);
  // 随机挑一张（不要总是挑最小的，否则测不到「更小点数被拒绝」）
  var lead = cv.myHand[Math.floor(Math.random() * cv.myHand.length)];
  must(await call(cur, 'gameAction', { action: { type: 'play', cardIds: [lead.id], rank: lead.rank } }), '喊牌');
  await tick();
  v = A.snap.view;
  console.log('✓ 喊牌成功：' + cur.name + ' 喊「' + v.lastPlay.label + '」，圈内', v.pileCount, '张');

  /* ---- 跟牌合法性：同张数更小点数应被拒绝 ---- */
  var next = all.filter(function (x) { return x.snap.view.myTurn; })[0];
  if (!next) throw new Error('找不到下一位玩家');
  var nv = next.snap.view;
  var lowerRanks = Cards.BS_RANKS.filter(function (rk) {
    return Cards.rankValue(rk) < Cards.rankValue(v.lastPlay.rank);
  });
  var anyCard = nv.myHand[0];
  if (lowerRanks.length) {
    var bad = await call(next, 'gameAction', { action: { type: 'play', cardIds: [anyCard.id], rank: lowerRanks[lowerRanks.length - 1] } });
    console.log((bad.ok ? '✗' : '✓') + ' 同张数更小点数被拒绝：', bad.error || '(未被拒绝)');
    if (bad.ok) throw new Error('非法跟牌竟然通过了');
    if (!/压不过/.test(bad.error || '')) throw new Error('拒绝理由不符合预期：' + bad.error);
  } else {
    console.log('- 上家已喊最小点数，跳过「更小点数」用例');
  }

  /* ---- 合法跟牌：同张数更大点数，或张数更多 ---- */
  var higherRanks = Cards.BS_RANKS.filter(function (rk) {
    return Cards.rankValue(rk) > Cards.rankValue(v.lastPlay.rank);
  });
  if (higherRanks.length) {
    must(await call(next, 'gameAction', { action: { type: 'play', cardIds: [anyCard.id], rank: higherRanks[higherRanks.length - 1] } }), '合法跟牌');
    await tick();
    console.log('✓ 跟牌成功（同张数点数更大），新喊牌 =', A.snap.view.lastPlay.label);
  } else if (nv.myHand.length > v.lastPlay.count) {
    var two = nv.myHand.slice(0, v.lastPlay.count + 1);
    must(await call(next, 'gameAction', { action: { type: 'play', cardIds: two.map(function (x) { return x.id; }), rank: two[0].rank } }), '合法跟牌');
    await tick();
    console.log('✓ 跟牌成功（张数更多），新喊牌 =', A.snap.view.lastPlay.label);
  } else {
    console.log('- 无法构造合法跟牌，跳过');
  }

  /* ---- 其他玩家质疑 ---- */
  var challenger = all.filter(function (x) {
    return x.snap.view.canChallenge && x.snap.view.lastPlay && x.snap.view.lastPlay.playerId !== x.meId;
  })[0];
  if (challenger) {
    must(await call(challenger, 'gameAction', { action: { type: 'challenge' } }), '质疑');
    await tick();
    var rv = A.snap.view.reveal;
    console.log('✓ 质疑成功，掀牌', rv ? rv.cards.length + ' 张，真假 = ' + (rv.fake ? '假' : '真') : '(无)',
      '，收牌方 =', rv ? (all.filter(function (x) { return x.meId === rv.winnerId; })[0] || {}).name : '?');
  } else {
    console.log('- 当前无人可质疑，跳过');
  }

  /* ---- 一路打到结束 ---- */
  var guard = 0;
  while (A.snap.view.stage !== 'ended' && guard++ < 4000) {
    var st = A.snap.view;
    if (st.stage === 'play') {
      var who = all.filter(function (x) { return x.snap.view.myTurn; })[0];
      if (!who) break;
      var wv = who.snap.view;
      if (wv.mustLead) {
        var c = wv.myHand.reduce(function (a, b) {
          return Cards.rankValue(b.rank) < Cards.rankValue(a.rank) ? b : a;
        });
        var rr = await call(who, 'gameAction', { action: { type: 'play', cardIds: [c.id], rank: c.rank } });
        if (!rr.ok) await call(who, 'gameAction', { action: { type: 'pass' } });
      } else {
        // 30% 质疑，40% 尝试跟牌，否则放弃
        var roll = Math.random();
        if (roll < 0.3 && wv.canChallenge) {
          await call(who, 'gameAction', { action: { type: 'challenge' } });
        } else {
          var pick = wv.myHand[0];
          var higher = Cards.BS_RANKS.filter(function (rk) {
            return Cards.rankValue(rk) > Cards.rankValue(wv.lastPlay.rank);
          }).pop();
          var canFollow = (pick && (1 > wv.lastPlay.count || (1 === wv.lastPlay.count && higher)));
          if (roll < 0.7 && canFollow) {
            var rr2 = await call(who, 'gameAction', { action: { type: 'play', cardIds: [pick.id], rank: higher } });
            if (!rr2.ok) await call(who, 'gameAction', { action: { type: 'pass' } });
          } else {
            await call(who, 'gameAction', { action: { type: 'pass' } });
          }
        }
      }
      await tick(40);
    } else if (st.stage === 'challenge' && st.winPendingId) {
      // 出完手牌的质疑窗口：为了快点，直接质疑
      var ch = all.filter(function (x) { return x.meId !== st.winPendingId; })[0];
      await call(ch, 'gameAction', { action: { type: 'challenge' } });
      await tick(40);
    } else break;
  }

  var fin = A.snap.view;
  console.log('✓ 对局结束，阶段 =', fin.stage);
  if (fin.stage !== 'ended') throw new Error('对局未能结束');
  console.log('✓ 赢家 =', fin.result.winnerName, '，通吃', fin.result.total, '分');
  var sum = 0;
  fin.result.ranking.forEach(function (x) { sum += x.score; });
  if (Math.abs(sum) > 0.001) throw new Error('分数总和不为 0：' + sum);
  console.log('✓ 分数守恒（总和 = 0），排名', fin.result.ranking.length, '人');

  /* ---- 掉线重连 ---- */
  var seat = B.meId;
  B.sock.disconnect();
  await tick(300);
  var B2 = await client('小红');
  var rj = await call(B2, 'joinRoom', { roomId: r.roomId, name: '小红', playerId: seat });
  must(rj, '重连');
  await tick();
  console.log('✓ 掉线重连成功，座位恢复 =', B2.meId === seat);

  must(await call(A, 'dissolveRoom', {}), '解散');
  console.log('✓ 房主解散房间');

  console.log('\n唬牌端到端冒烟测试全部通过 🎉');
  process.exit(0);
})().catch(function (e) { console.error('✗ ' + e.message); process.exit(1); });
