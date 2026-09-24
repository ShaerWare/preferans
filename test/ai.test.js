import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, newDeck } from '../server/engine.js';
import { decide, actorSeat } from '../server/ai.js';

function seeded(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}
const players = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];

// Боты играют пулю сами с собой; любое недопустимое действие бросит исключение в act()
function playPool(levels, seed, poolTarget = 10) {
  const rng = seeded(seed);
  const g = createGame({ players, config: { poolTarget }, dealer: seed % 3, rng });
  let guard = 0;
  while (g.phase !== 'gameOver') {
    if (++guard > 5000) throw new Error('пуля не закончилась');
    if (g.phase === 'dealEnd') { act(g, 0, { type: 'nextDeal' }); continue; }
    const seat = actorSeat(g);
    act(g, seat, decide(g, seat, levels[seat], rng));
  }
  return g;
}

test('боты всех уровней доигрывают пулю без ошибок', () => {
  for (const [i, lv] of [['novice', 'novice', 'novice'], ['amateur', 'pro', 'master'], ['master', 'master', 'novice']].entries()) {
    const g = playPool(lv, 7 + i);
    assert.deepEqual(g.score.pool, [10, 10, 10]);
  }
});

test('с сильной рукой бот заказывает игру, со слабой — пасует', () => {
  const g = createGame({ players, dealer: 2, rng: seeded(3) });
  g.hands[0] = ['AS', 'KS', 'QS', 'JS', 'TS', 'AH', 'KH', 'AD', 'KD', 'AC'];
  // мелочь с «дырками» — ни игры, ни мизера
  g.hands[1] = ['7S', '9S', 'TH', 'JH', '8D', 'TD', 'QD', '8C', 'TC', 'KC'];
  const rest = newDeck().filter((c) => !g.hands[0].includes(c) && !g.hands[1].includes(c));
  g.hands[2] = rest.slice(0, 10);
  g.talon = rest.slice(10);
  assert.notEqual(decide(g, 0, 'pro', seeded(1)).bid, 'PASS');
  act(g, 0, { type: 'bid', bid: '6S' });
  assert.equal(decide(g, 1, 'pro', seeded(1)).bid, 'PASS');
});

test('с «чистой» рукой бот объявляет мизер', () => {
  const g = createGame({ players, dealer: 2, rng: seeded(4) });
  g.hands[0] = ['7S', '9S', '7H', '9H', 'JH', '7D', '9D', '7C', '9C', 'JC'];
  const others = ['8S', 'TS', 'JS', 'QS', 'KS', 'AS', '8H', 'TH', 'QH', 'KH', 'AH', '8D', 'TD', 'JD', 'QD', 'KD', 'AD', '8C', 'TC', 'QC', 'KC', 'AC'];
  g.hands[1] = others.slice(0, 10);
  g.hands[2] = others.slice(10, 20);
  g.talon = others.slice(20);
  assert.equal(decide(g, 0, 'master', seeded(2)).bid, 'MIS');
});

test('мастер обыгрывает новичков', () => {
  const total = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const g = playPool(['master', 'novice', 'novice'], 100 + i, 10);
    g.final.forEach((x, s) => { total[s] += x; });
  }
  assert.ok(total[0] > total[1] && total[0] > total[2], `итог: ${total.join(' / ')}`);
});
