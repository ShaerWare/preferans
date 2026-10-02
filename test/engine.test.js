import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, viewFor, legalBids, legalCards, finalBalance, GameError } from '../server/engine.js';

const players = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];

function seeded(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

function game(cfg = {}) {
  return createGame({ players, config: cfg, dealer: 0, rng: seeded(42) });
}

test('первым торгуется старшая рука (слева от сдающего)', () => {
  const s = game();
  assert.equal(s.dealer, 0);
  assert.equal(s.bidding.turn, 1);
});

test('все пас → распасы, первая взятка в масть прикупа', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: 'PASS' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  assert.equal(s.phase, 'play');
  assert.equal(s.play.kind, 'raspas');
  assert.equal(s.play.leadSuit, s.talon[0].slice(-1));
});

test('мизер только первым словом, после мизера — только девятерные', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: '6S' });
  act(s, 2, { type: 'bid', bid: 'MIS' });
  assert.ok(!legalBids(s, 0).includes('8N'));
  assert.ok(legalBids(s, 0).includes('9S'));
  act(s, 0, { type: 'bid', bid: 'PASS' });
  // 1 уже заявлялся — мизер ему недоступен, может только перебить девяткой
  assert.ok(!legalBids(s, 1).includes('MIS'));
  act(s, 1, { type: 'bid', bid: 'PASS' });
  assert.equal(s.phase, 'talon');
  assert.equal(s.declarer, 2);
  assert.equal(s.hands[2].length, 12);
});

test('мизерист выбывает, если его перебили', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: 'MIS' });
  act(s, 2, { type: 'bid', bid: '9S' });
  assert.equal(s.bidding.passed[1], true);
  assert.equal(s.bidding.turn, 0);
  act(s, 0, { type: 'bid', bid: 'PASS' });
  assert.equal(s.declarer, 2);
});

test('нельзя торговаться не в свою очередь', () => {
  const s = game();
  assert.throws(() => act(s, 0, { type: 'bid', bid: '6S' }), GameError);
});

test('игра без виста: пуля играющему', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: '6S' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  const h = s.hands[1];
  act(s, 1, { type: 'discard', cards: [h[0], h[1]], contract: '6H' });
  assert.equal(s.phase, 'whisting');
  assert.equal(s.whist.turn, 2);
  act(s, 2, { type: 'whist', choice: 'PASS' });
  act(s, 0, { type: 'whist', choice: 'PASS' });
  assert.equal(s.phase, 'dealEnd');
  assert.equal(s.score.pool[1], 2);
});

test('полвиста на шестерной и возможность первого передумать', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: '6S' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  const h = s.hands[1];
  act(s, 1, { type: 'discard', cards: [h[0], h[1]], contract: '6S' });
  act(s, 2, { type: 'whist', choice: 'PASS' });
  assert.deepEqual(viewFor(s, 0).legal.whist, ['WHIST', 'PASS', 'HALF']);
  act(s, 0, { type: 'whist', choice: 'HALF' });
  assert.equal(s.whist.turn, 2);
  act(s, 2, { type: 'whist', choice: 'PASS' });
  assert.equal(s.phase, 'dealEnd');
  assert.equal(s.score.pool[1], 2);
  assert.equal(s.score.whists[0][1], 4); // 2 × (4/2)
});

test('обязан ходить в масть, иначе козырем', () => {
  const s = game();
  s.phase = 'play';
  s.hands = [['7S', 'AH', '8C'], ['KS', '9D'], ['7D', 'QC']];
  s.play = { kind: 'game', trump: 'H', turn: 0, trick: [{ seat: 2, card: 'AS' }], leadSuit: 'S', tricks: [0, 0, 0], trickNo: 0, open: [], controller: [0, 1, 2] };
  assert.deepEqual(legalCards(s, 0), ['7S']);
  s.hands[0] = ['AH', '8C'];
  assert.deepEqual(legalCards(s, 0), ['AH']);
  s.hands[0] = ['8C', '9C'];
  assert.deepEqual(legalCards(s, 0), ['8C', '9C']);
});

test('итоговый баланс сходится в ноль', () => {
  const s = game();
  s.score = { pool: [20, 20, 20], mountain: [10, 0, 4], whists: [[0, 30, 5], [12, 0, 0], [8, 40, 0]] };
  const f = finalBalance(s);
  assert.ok(Math.abs(f[0] + f[1] + f[2]) < 0.05);
});

// Случайные партии до закрытия пули: движок не должен ломаться и терять карты.
test('случайные партии доигрываются до конца', () => {
  for (let g = 0; g < 30; g++) {
    const rng = seeded(1000 + g);
    const s = createGame({ players, config: { poolTarget: 10 }, dealer: g % 3, rng });
    let steps = 0;
    while (s.phase !== 'gameOver') {
      if (++steps > 20000) assert.fail('партия зациклилась');
      const pick = (arr) => arr[Math.floor(rng() * arr.length)];
      if (s.phase === 'bidding') {
        const seat = s.bidding.turn;
        const bids = legalBids(s, seat);
        // чаще пасуем, чтобы партии были реалистичнее
        act(s, seat, { type: 'bid', bid: rng() < 0.6 ? 'PASS' : pick(bids.slice(1, 6).concat(['PASS'])) });
      } else if (s.phase === 'talon') {
        const v = viewFor(s, s.declarer);
        const h = s.hands[s.declarer];
        if (v.legal.withoutThree && rng() < 0.1) act(s, s.declarer, { type: 'withoutThree' });
        else act(s, s.declarer, { type: 'discard', cards: [h[0], h[5]], contract: v.legal.contracts[0] });
      } else if (s.phase === 'whisting') {
        const seat = s.whist.turn;
        const v = viewFor(s, seat);
        act(s, seat, { type: 'whist', choice: pick(v.legal.whist) });
      } else if (s.phase === 'whistMode') {
        act(s, s.whist.turn, { type: 'whistMode', open: rng() < 0.5 });
      } else if (s.phase === 'play' && s.play.proposal) {
        const who = [0, 1, 2].find((x) => viewFor(s, x).legal.answerProposal);
        act(s, who, { type: 'answerProposal', accept: rng() < 0.5 });
      } else if (s.phase === 'play' && rng() < 0.03) {
        // кто-нибудь предлагает случайный расклад оставшихся взяток
        const rem = 10 - s.play.trickNo;
        const a = Math.floor(rng() * (rem + 1));
        const b = Math.floor(rng() * (rem - a + 1));
        act(s, Math.floor(rng() * 3), { type: 'propose', tricks: [a, b, rem - a - b] });
      } else if (s.phase === 'play') {
        const seat = s.play.controller[s.play.turn];
        const v = viewFor(s, seat);
        assert.ok(v.legal.cards.length > 0);
        act(s, seat, { type: 'play', card: pick(v.legal.cards) });
      } else if (s.phase === 'dealEnd') {
        if (s.play) assert.ok(s.play.tricks.reduce((x, y) => x + y) <= 10);
        act(s, 0, { type: 'nextDeal' });
      }
      if (s.phase === 'bidding') {
        const all = [...s.hands.flat(), ...s.talon];
        assert.equal(new Set(all).size, 32);
      }
    }
    const f = s.final;
    assert.ok(Math.abs(f[0] + f[1] + f[2]) < 0.05, `баланс не ноль: ${f}`);
    assert.deepEqual(s.score.pool, [10, 10, 10]);
  }
});

test('«без трёх» после прикупа: гора и висты противникам', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: '7S' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  assert.equal(viewFor(s, 1).legal.withoutThree, true);
  assert.equal(viewFor(s, 2).legal.withoutThree, false);
  act(s, 1, { type: 'withoutThree' });
  assert.equal(s.phase, 'dealEnd');
  assert.equal(s.score.mountain[1], 12); // 3 × 4
  // 3×4 за «без трёх» + 4 × (10 − 4) / 2 за взятки защиты
  assert.equal(s.score.whists[2][1], 24);
  assert.equal(s.score.whists[0][1], 24);
});

test('мизер «без трёх» не сдают', () => {
  const s = game();
  act(s, 1, { type: 'bid', bid: 'MIS' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  assert.equal(viewFor(s, 1).legal.withoutThree, false);
  assert.throws(() => act(s, 1, { type: 'withoutThree' }), GameError);
});

function toPlay() {
  const s = game();
  act(s, 1, { type: 'bid', bid: '6S' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  const h = s.hands[1];
  act(s, 1, { type: 'discard', cards: [h[0], h[1]], contract: '6S' });
  act(s, 2, { type: 'whist', choice: 'WHIST' });
  act(s, 0, { type: 'whist', choice: 'WHIST' });
  return s;
}

test('«предложить»: все согласны — раздача считается сразу', () => {
  const s = toPlay();
  assert.equal(s.phase, 'play');
  assert.throws(() => act(s, 1, { type: 'propose', tricks: [1, 1, 1] }), GameError); // не 10
  act(s, 1, { type: 'propose', tricks: [2, 6, 2] });
  assert.deepEqual(viewFor(s, 1).legal.cards, []); // пока ждём ответа — не ходим
  assert.throws(() => act(s, 1, { type: 'answerProposal', accept: true }), GameError); // сам себе не отвечает
  act(s, 2, { type: 'answerProposal', accept: true });
  assert.equal(s.phase, 'play');
  act(s, 0, { type: 'answerProposal', accept: true });
  assert.equal(s.phase, 'dealEnd');
  assert.deepEqual(s.lastResult.tricks, [2, 6, 2]);
  assert.equal(s.score.pool[1], 2);
  assert.equal(s.score.whists[0][1], 4);
});

test('«предложить»: отказ — играем дальше', () => {
  const s = toPlay();
  act(s, 0, { type: 'propose', tricks: [5, 3, 2] });
  act(s, 1, { type: 'answerProposal', accept: false });
  assert.equal(s.play.proposal, null);
  assert.ok(viewFor(s, s.play.controller[s.play.turn]).legal.cards.length > 0);
  act(s, 2, { type: 'propose', tricks: [5, 3, 2] });
  act(s, 2, { type: 'cancelProposal' });
  assert.equal(s.play.proposal, null);
});
