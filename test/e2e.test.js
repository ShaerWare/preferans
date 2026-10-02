// Сквозной тест: поднимаем сервер в DEV-режиме, трое клиентов по WebSocket играют несколько раздач.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, name, state: null, chat: [], errors: [], waiters: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (process.env.E2E_DEBUG) console.log(name, m.t, m.view?.phase ?? '', m.text ?? '');
    if (m.t === 'welcome') c.me = m.me, c.tableId = m.tableId;
    if (m.t === 'state') c.state = m;
    if (m.t === 'chat') c.chat.push(m.msg);
    if (m.t === 'error') c.errors.push(m.text);
    c.waiters = c.waiters.filter((w) => !w(m));
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred) => new Promise((res) => c.waiters.push((m) => (pred(m) ? (res(m), true) : false)));
  c.open = new Promise((res) => ws.on('open', res));
  return c;
}

test('трое играют через сервер', { timeout: 30000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DEV: '1', BOT_TOKEN: '', DATA_FILE: path.join(os.tmpdir(), `pref-e2e-${PORT}.json`) },
    stdio: 'pipe',
  });
  try {
    await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('[http]') && res()));
    const [a, b, c] = ['Аня', 'Боря', 'Вика'].map(client);
    await Promise.all([a.open, b.open, c.open]);

    a.send({ t: 'hello', dev: a.name });
    await a.wait((m) => m.t === 'welcome');
    a.send({ t: 'create' });
    const id = (await a.wait((m) => m.t === 'state')).table.id;
    for (const x of [b, c]) {
      x.send({ t: 'hello', dev: x.name, tableId: id });
      await x.wait((m) => m.t === 'state');
      x.send({ t: 'sit' });
    }
    await a.wait((m) => m.t === 'state' && m.table.seats.every(Boolean));
    a.send({ t: 'start', config: { poolTarget: 10 } });
    await a.wait((m) => m.t === 'state' && m.view);

    b.send({ t: 'chat', text: 'Привет!' });
    await c.wait((m) => m.t === 'chat' && m.msg.text === 'Привет!');

    // Каждый клиент ходит сам, как только сервер говорит, что его очередь.
    const players = [a, b, c];
    let deals = 0;
    const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
    await new Promise((resolve, reject) => {
      const tick = (x) => {
        const v = x.state?.view;
        if (!v || x.actedOn === x.state) return;
        x.actedOn = x.state; // на одно состояние — одно действие
        const l = v.legal;
        if (v.phase === 'gameOver' || deals >= 6) return resolve();
        if (l.bids.length) x.send({ t: 'act', action: { type: 'bid', bid: Math.random() < 0.7 ? 'PASS' : rnd(l.bids.slice(0, 4)) } });
        else if (l.contracts.length) x.send({ t: 'act', action: { type: 'discard', cards: v.hands[v.seat].slice(0, 2), contract: l.contracts[0] } });
        else if (l.whist.length) x.send({ t: 'act', action: { type: 'whist', choice: rnd(l.whist) } });
        else if (l.whistMode) x.send({ t: 'act', action: { type: 'whistMode', open: true } });
        else if (l.catchChoice) x.send({ t: 'act', action: { type: 'catch', take: Math.random() < 0.5 } });
        else if (l.cards.length) x.send({ t: 'act', action: { type: 'play', card: rnd(l.cards) } });
        else if (v.phase === 'dealEnd' && x === a) { deals++; x.send({ t: 'act', action: { type: 'nextDeal' } }); }
      };
      for (const x of players) x.ws.on('message', () => setImmediate(() => tick(x)));
      for (const x of players) tick(x);
      setTimeout(() => reject(new Error(`застряли: ${JSON.stringify(a.state?.view?.phase)}`)), 25000);
    });
    for (const x of players) assert.deepEqual(x.errors, []);
    // чужие карты не утекают
    const v = b.state.view;
    if (v.phase === 'bidding') assert.equal(v.hands.filter(Boolean).length, 1);
    for (const x of players) x.ws.close();
  } finally {
    srv.kill();
  }
});
