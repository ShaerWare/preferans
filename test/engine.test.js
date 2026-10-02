import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, viewFor, legalBids, legalCards, finalBalance, whistShortfall, GameError } from '../server/engine.js';

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
      } else if (s.phase === 'misereCatch') {
        act(s, s.catch.turn, { type: 'catch', take: rng() < 0.5 });
      } else if (s.phase === 'whistMode') {
        act(s, s.whist.turn, { type: 'whistMode', open: rng() < 0.5 });
      } else if (s.phase === 'play' && s.play.proposal) {
        const who = [0, 1, 2].find((x) => viewFor(s, x).legal.answerProposal);
        act(s, who, { type: 'answerProposal', accept: rng() < 0.5 });
      } else if (s.phase === 'play' && s.play.kind !== 'raspas' && rng() < 0.03) {
        // кто-нибудь предлагает, сколько возьмёт играющий
        const opts = viewFor(s, 0).legal.proposeOptions;
        act(s, Math.floor(rng() * 3), { type: 'propose', declTricks: pick(opts) });
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
  assert.deepEqual(viewFor(s, 1).legal.proposeOptions, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.throws(() => act(s, 1, { type: 'propose', declTricks: 11 }), GameError);
  act(s, 1, { type: 'propose', declTricks: 6 });
  assert.match(viewFor(s, 0).play.proposal.text, /берёт 6 — своя игра/);
  assert.deepEqual(viewFor(s, 1).legal.cards, []); // пока ждём ответа — не ходим
  assert.throws(() => act(s, 1, { type: 'answerProposal', accept: true }), GameError); // сам себе не отвечает
  act(s, 2, { type: 'answerProposal', accept: true });
  assert.equal(s.phase, 'play');
  act(s, 0, { type: 'answerProposal', accept: true });
  assert.equal(s.phase, 'dealEnd');
  // защите 4 взятки — поровну
  assert.deepEqual(s.lastResult.tricks, [2, 6, 2]);
  assert.equal(s.score.pool[1], 2);
  assert.equal(s.score.whists[0][1], 4);
});

test('«предложить»: отказ — играем дальше', () => {
  const s = toPlay();
  act(s, 0, { type: 'propose', declTricks: 5 });
  assert.match(viewFor(s, 1).play.proposal.text, /берёт 5 — без 1/);
  // 5 взяток защиты: по 2, лишняя тому, у кого меньше (пока у обоих 0 — первому)
  assert.deepEqual(s.play.proposal.tricks, [2, 5, 3]);
  act(s, 1, { type: 'answerProposal', accept: false });
  assert.equal(s.play.proposal, null);
  assert.ok(viewFor(s, s.play.controller[s.play.turn]).legal.cards.length > 0);
  act(s, 2, { type: 'propose', declTricks: 7 });
  assert.ok(viewFor(s, 0).play.proposal.text.endsWith('берёт 7 — 7 (+1)'));
  act(s, 2, { type: 'cancelProposal' });
  assert.equal(s.play.proposal, null);
});

test('«предложить»: на распасах нет, на мизере — «чистый»', () => {
  const s = game();
  for (let k = 0; k < 3; k++) act(s, s.bidding.turn, { type: 'bid', bid: 'PASS' });
  assert.equal(viewFor(s, 0).legal.propose, false);
  assert.throws(() => act(s, 0, { type: 'propose', declTricks: 0 }), GameError);

  const m = game();
  act(m, 1, { type: 'bid', bid: 'MIS' });
  act(m, 2, { type: 'bid', bid: 'PASS' });
  act(m, 0, { type: 'bid', bid: 'PASS' });
  act(m, 1, { type: 'discard', cards: m.hands[1].slice(0, 2), contract: 'MIS' });
  act(m, 2, { type: 'catch', take: true });
  act(m, 1, { type: 'propose', declTricks: 0 });
  assert.match(viewFor(m, 0).play.proposal.text, /чистый мизер/);
});

// Сыграть текущую раздачу распасами (все пас, ходим первой допустимой картой)
function raspasDeal(s) {
  for (let k = 0; k < 3; k++) act(s, s.bidding.turn, { type: 'bid', bid: 'PASS' });
  while (s.phase === 'play') act(s, s.play.turn, { type: 'play', card: legalCards(s, s.play.turn)[0] });
  act(s, 0, { type: 'nextDeal' });
}
const minBid = (s) => legalBids(s, s.bidding.turn).find((b) => b !== 'PASS' && b !== 'MIS');

test('выход с распасов: 6 — без ограничений', () => {
  const s = game();
  raspasDeal(s);
  assert.equal(minBid(s), '6S');
});

test('выход с распасов: 7 — после распасов с 7♠, мизер можно', () => {
  const s = game({ raspasExit: '7' });
  assert.equal(minBid(s), '6S');
  raspasDeal(s);
  assert.equal(minBid(s), '7S');
  assert.ok(legalBids(s, s.bidding.turn).includes('MIS'));
  raspasDeal(s);
  assert.equal(minBid(s), '7S');
});

test('выход с распасов: прогрессия 7 → 8 → 9 и сброс после игры', () => {
  const s = game({ raspasExit: 'prog9' });
  const seen = [];
  for (let k = 0; k < 4; k++) { raspasDeal(s); seen.push(minBid(s)); }
  assert.deepEqual(seen, ['7S', '8S', '9S', '9S']);
  // кто-то играет девятерную — счётчик распасов сбрасывается
  act(s, s.bidding.turn, { type: 'bid', bid: '9S' });
  act(s, s.bidding.turn, { type: 'bid', bid: 'PASS' });
  act(s, s.bidding.turn, { type: 'bid', bid: 'PASS' });
  const d = s.declarer;
  act(s, d, { type: 'discard', cards: s.hands[d].slice(0, 2), contract: '9S' });
  act(s, s.whist.turn, { type: 'whist', choice: 'PASS' });
  act(s, s.whist.turn, { type: 'whist', choice: 'PASS' });
  act(s, 0, { type: 'nextDeal' });
  assert.equal(minBid(s), '6S');
});

test('выход с распасов: прогрессия 7 → 8 → 8', () => {
  const s = game({ raspasExit: 'prog8' });
  const seen = [];
  for (let k = 0; k < 4; k++) { raspasDeal(s); seen.push(minBid(s)); }
  assert.deepEqual(seen, ['7S', '8S', '8S', '8S']);
});

function orderGame(s, contract) {
  act(s, 1, { type: 'bid', bid: contract });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  act(s, 1, { type: 'discard', cards: s.hands[1].slice(0, 2), contract });
}

test('Сталинград: на 6♠ оба вистуют сразу, в закрытую', () => {
  const s = game({ stalingrad: true });
  orderGame(s, '6S');
  assert.equal(s.phase, 'play');
  assert.deepEqual(s.whist.whisters, [2, 0]);
  assert.equal(s.whist.open, false);
  assert.deepEqual(s.play.open, []);
  // играющий забирает все взятки — за недовист обязательные вистующие не отвечают
  act(s, 1, { type: 'propose', declTricks: 10 });
  act(s, 2, { type: 'answerProposal', accept: true });
  act(s, 0, { type: 'answerProposal', accept: true });
  assert.deepEqual(s.score.mountain, [0, 0, 0]);
  assert.equal(s.score.pool[1], 2);
});

test('Сталинград касается только 6♠', () => {
  const s = game({ stalingrad: true });
  orderGame(s, '6C');
  assert.equal(s.phase, 'whisting');
});

test('без Сталинграда на 6♠ — обычный вист', () => {
  const s = game();
  orderGame(s, '6S');
  assert.equal(s.phase, 'whisting');
});

test('уйти за полвиста можно и на семерной', () => {
  const s = game();
  orderGame(s, '7S');
  act(s, 2, { type: 'whist', choice: 'PASS' });
  assert.ok(viewFor(s, 0).legal.whist.includes('HALF'));
  act(s, 0, { type: 'whist', choice: 'HALF' });
  act(s, 2, { type: 'whist', choice: 'PASS' });
  assert.equal(s.score.pool[1], 4);
  assert.equal(s.score.whists[0][1], 4); // 4 × (2 / 2)
});

test('на восьмерной полвиста нет', () => {
  const s = game();
  orderGame(s, '8S');
  act(s, 2, { type: 'whist', choice: 'PASS' });
  assert.ok(!viewFor(s, 0).legal.whist.includes('HALF'));
});

test('недобор виста: вместе взяли обязательное — в гору никому', () => {
  assert.deepEqual(whistShortfall(4, 1, 2, 3, 1), []); // шестерная: 3+1 = 4
  assert.deepEqual(whistShortfall(4, 1, 2, 4, 0), []);
  assert.deepEqual(whistShortfall(2, 1, 2, 2, 0), []); // семерная: 2 на двоих
  assert.deepEqual(whistShortfall(1, 1, 2, 1, 0), []); // восьмерная: 1 на двоих
});

test('недобор виста: в гору тот, кто не взял свою долю', () => {
  assert.deepEqual(whistShortfall(4, 1, 2, 2, 1), [[2, 1]]);
  assert.deepEqual(whistShortfall(4, 1, 2, 0, 3), [[1, 1]]); // не больше общего недобора
  assert.deepEqual(whistShortfall(4, 1, 2, 1, 1), [[1, 1], [2, 1]]);
  assert.deepEqual(whistShortfall(2, 1, 2, 0, 1), [[1, 1]]);
  assert.deepEqual(whistShortfall(1, 1, 2, 0, 0), [[2, 1]]);
});

function misereDeal() {
  const s = game();
  act(s, 1, { type: 'bid', bid: 'MIS' });
  act(s, 2, { type: 'bid', bid: 'PASS' });
  act(s, 0, { type: 'bid', bid: 'PASS' });
  act(s, 1, { type: 'discard', cards: s.hands[1].slice(0, 2), contract: 'MIS' });
  return s;
}

test('мизер: ловящие по очереди решают, кто ловит', () => {
  const s = misereDeal();
  assert.equal(s.phase, 'misereCatch');
  assert.equal(viewFor(s, 2).legal.catchChoice, true); // первый — слева от играющего
  assert.equal(viewFor(s, 0).legal.catchChoice, false);
  assert.throws(() => act(s, 0, { type: 'catch', take: true }), GameError);
  act(s, 2, { type: 'catch', take: false });
  assert.equal(viewFor(s, 0).legal.catchChoice, true);
  act(s, 0, { type: 'catch', take: true });
  assert.equal(s.phase, 'play');
  assert.equal(s.catch.catcher, 0);
  assert.deepEqual(s.play.controller, [0, 1, 0]); // ловящий ходит и за напарника
  // ловящий видит руку напарника сразу, играющий — только после первой взятки
  assert.ok(viewFor(s, 0).hands[2]);
  assert.equal(viewFor(s, 1).hands[2], null);
  assert.equal(viewFor(s, 2).hands[0], null); // напарник руку ловящего не видит
});

test('мизер: отказались оба — ловит первый', () => {
  const s = misereDeal();
  act(s, 2, { type: 'catch', take: false });
  act(s, 0, { type: 'catch', take: false });
  assert.equal(s.catch.catcher, 2);
  assert.deepEqual(s.play.controller, [2, 1, 2]);
});

test('мизер: первый ловит сам — второй не спрашивается', () => {
  const s = misereDeal();
  act(s, 2, { type: 'catch', take: true });
  assert.equal(s.phase, 'play');
  assert.deepEqual(s.play.controller, [2, 1, 2]);
  assert.deepEqual(viewFor(s, 2).legal.controls, [0, 2]);
  assert.deepEqual(viewFor(s, 0).legal.controls, []); // напарник сам не ходит
});
