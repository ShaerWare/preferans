import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Tables } from '../server/tables.js';

const tmp = () => path.join(os.tmpdir(), `pref-stats-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
const ann = { id: 'u1', name: 'Аня' };
const bob = { id: 'u2', name: 'Боря' };
const vic = { id: 'u3', name: 'Вика' };

function table3(tables) {
  const t = tables.create();
  tables.sit(t, ann);
  tables.sit(t, bob);
  tables.sit(t, vic);
  tables.start(t, ann, { poolTarget: 10 });
  return t;
}

test('пуля закрыта: доиграли все, висты суммируются', () => {
  const tables = new Tables(tmp());
  const t = table3(tables);
  t.game.final = [30, -10, -20];
  tables.recordEnd(t, 'normal');
  tables.recordEnd(t, 'normal'); // повторно не считается
  assert.deepEqual(tables.stats.view('u1'), { ...tables.stats.view('u1'), finished: 1, unfinished: 0, whists: 30, games: 1, finishRate: 100 });
  assert.equal(tables.stats.view('u3').whists, -20);
  assert.deepEqual(tables.stats.top().map((p) => p.id), ['u1', 'u2', 'u3']);
});

test('к концу пули за игрока играл ИИ — пуля у него недоиграна', () => {
  const tables = new Tables(tmp());
  const t = table3(tables);
  t.seats[1].ai = 'pro'; // Боря ушёл, его заменили
  t.game.final = [5, 5, -10];
  tables.recordEnd(t, 'normal');
  assert.equal(tables.stats.view('u1').finished, 1);
  assert.equal(tables.stats.view('u2').finished, 0);
  assert.equal(tables.stats.view('u2').unfinished, 1);
  assert.equal(tables.stats.view('u2').whists, 5);
});

test('досрочно закончил игру с ИИ — недоиграна, висты по текущему счёту', () => {
  const tables = new Tables(tmp());
  const t = tables.create();
  tables.sit(t, ann);
  tables.addBot(t, ann, null, 'novice');
  tables.addBot(t, ann, null, 'novice');
  tables.start(t, ann, { poolTarget: 10 });
  clearTimeout(tables.aiTimers.get(t.id));
  tables.aiTimers.clear();
  tables.finish(t, ann);
  const s = tables.stats.view('u1');
  assert.equal(s.unfinished, 1);
  assert.equal(s.whists, t.game.final[0]);
  assert.equal(tables.stats.view(t.seats[1].id), null); // ботов в статистике нет
});

test('сутки без ходов — пуля брошена у всех, висты не пишем', () => {
  const tables = new Tables(tmp());
  const t = table3(tables);
  t.updatedAt = Date.now() - 25 * 3600 * 1000;
  tables.sweepStale();
  assert.equal(t.game.phase, 'gameOver');
  for (const id of ['u1', 'u2', 'u3']) {
    assert.equal(tables.stats.view(id).unfinished, 1);
    assert.equal(tables.stats.view(id).whists, 0);
  }
});

test('статистика стола: свои и чужие', () => {
  const tables = new Tables(tmp());
  const t = table3(tables);
  t.game.final = [1, 2, -3];
  tables.recordEnd(t, 'normal');
  const s = tables.statsFor(t, 'u2');
  assert.deepEqual(s.table.map((p) => p.id).sort(), ['u1', 'u2', 'u3']);
  // без стола — только свои
  assert.deepEqual(tables.statsFor(null, 'u9').table.map((p) => p.id), ['u9']);
});
