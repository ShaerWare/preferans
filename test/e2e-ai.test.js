// Сквозной тест: один человек против двух ботов, «Отойти» и возврат управления.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 19000 + Math.floor(Math.random() * 1000);

test('игра с ИИ через сервер', { timeout: 180000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DEV: '1', BOT_TOKEN: '', AI_DELAY: '0.02', DATA_FILE: path.join(os.tmpdir(), `pref-e2e-ai-${PORT}.json`) },
    stdio: 'pipe',
  });
  try {
    await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('[http]') && res()));
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise((r) => ws.on('open', r));
    const send = (o) => ws.send(JSON.stringify(o));
    const errors = [];
    let state = null;
    const listeners = new Set();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'state') state = m;
      if (m.t === 'error') errors.push(m.text);
      for (const fn of listeners) fn(m);
    });
    const until = (pred) => new Promise((res) => {
      const fn = () => { if (state && pred(state)) { listeners.delete(fn); res(state); } };
      listeners.add(fn);
      fn();
    });

    send({ t: 'hello', dev: 'Соло' });
    send({ t: 'create', bots: 'master', config: { poolTarget: 10 } });
    const s0 = await until((s) => s.view);
    assert.equal(s0.table.seats.filter((x) => x.bot).length, 2);
    assert.ok(s0.table.seats.every((x) => !x.bot || x.ai === 'master'));

    // человек играет сам: всегда первый допустимый вариант; боты ходят за себя
    let acted = null;
    const me = (s) => s.view.seat;
    listeners.add(() => {
      const v = state?.view;
      if (!v) return;
      // одно действие на одну позицию (сервер может прислать одинаковое состояние дважды)
      const key = JSON.stringify([v.dealNo, v.phase, v.bidding?.log.length, v.whist?.answers, v.play?.trickNo, v.play?.trick.length]);
      if (acted === key) return;
      acted = key;
      const l = v.legal;
      if (l.bids.length) send({ t: 'act', action: { type: 'bid', bid: 'PASS' } });
      else if (l.contracts.length) send({ t: 'act', action: { type: 'discard', cards: v.hands[me(state)].slice(0, 2), contract: l.contracts[0] } });
      else if (l.whist.length) send({ t: 'act', action: { type: 'whist', choice: 'WHIST' } });
      else if (l.whistMode) send({ t: 'act', action: { type: 'whistMode', open: true } });
      else if (l.catchChoice) send({ t: 'act', action: { type: 'catch', take: true } });
      else if (l.cards.length) send({ t: 'act', action: { type: 'play', card: l.cards[0] } });
    });
    await until((s) => s.view.phase === 'dealEnd' || s.view.phase === 'gameOver');
    assert.deepEqual(errors, []);

    // «Отойти»: ИИ доигрывает раздачу за человека
    send({ t: 'act', action: { type: 'nextDeal' } });
    await until((s) => s.view.phase === 'bidding');
    send({ t: 'takeover', seat: me(state), level: 'pro' });
    await until((s) => s.table.seats[me(s)].ai === 'pro');
    await until((s) => s.view.phase === 'dealEnd' || s.view.phase === 'gameOver');
    send({ t: 'reclaim' });
    await until((s) => !s.table.seats[me(s)].ai);
    assert.deepEqual(errors, []);
    ws.close();
  } finally {
    srv.kill();
  }
});

test('после перезагрузки возвращает в активную партию', { timeout: 60000 }, async () => {
  const port = PORT + 1;
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DEV: '1', BOT_TOKEN: '', AI_DELAY: '5', DATA_FILE: path.join(os.tmpdir(), `pref-e2e-resume-${port}.json`) },
    stdio: 'pipe',
  });
  // одно «открытие» Mini App: соединяемся, шлём hello, ждём welcome (и state, если есть стол)
  const open = async (hello) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const msgs = [];
    const waiters = new Set();
    ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); for (const w of waiters) w(m); });
    await new Promise((r) => ws.on('open', r));
    const next = (pred) => new Promise((res) => {
      const found = msgs.find(pred);
      if (found) return res(found);
      const w = (m) => { if (pred(m)) { waiters.delete(w); res(m); } };
      waiters.add(w);
    });
    ws.send(JSON.stringify({ t: 'hello', dev: 'Перезагрузка', ...hello }));
    const welcome = await next((m) => m.t === 'welcome');
    return { ws, welcome, next, send: (o) => ws.send(JSON.stringify(o)) };
  };
  try {
    await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('[http]') && res()));
    const a = await open({});
    assert.equal(a.welcome.tableId, null);
    a.send({ t: 'create', bots: 'novice' });
    const s1 = await a.next((m) => m.t === 'state' && m.view);
    const id = s1.table.id;
    a.ws.close();

    // открыли из меню бота — без номера стола
    const b = await open({});
    assert.equal(b.welcome.tableId, id);
    const s2 = await b.next((m) => m.t === 'state');
    assert.ok(s2.view && s2.view.phase !== 'gameOver');

    // «В меню» — не возвращаем, пока сам не попросит
    b.send({ t: 'leave' });
    await b.next((m) => m.t === 'welcome' && m.tableId === null);
    b.ws.close();
    const c = await open({ noResume: true });
    assert.equal(c.welcome.tableId, null);
    c.ws.close();

    // «Вернуться к игре» / новое открытие — снова в партию; досрочно заканчиваем
    const d = await open({});
    assert.equal(d.welcome.tableId, id);
    d.send({ t: 'finish' });
    await d.next((m) => m.t === 'state' && m.view?.phase === 'gameOver');
    d.ws.close();

    // закрытая пуля не держит: открываем — попадаем в меню
    const e = await open({});
    assert.equal(e.welcome.tableId, null);
    e.ws.close();
  } finally {
    srv.kill();
  }
});
