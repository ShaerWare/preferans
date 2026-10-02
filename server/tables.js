// Столы: посадка, партия, чат, сохранение на диск.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGame, act, viewFor, finishEarly } from './engine.js';
import { decide, actingSeats, AI_LEVELS, AI_NAMES } from './ai.js';
import { bidLabel, RASPAS_EXIT } from './rules.js';

const CHAT_LIMIT = 200;

export class Tables {
  constructor(file) {
    this.file = file;
    this.tables = new Map();
    this.saveTimer = null;
    this.listeners = new Set(); // (table, event) => void
    this.aiTimers = new Map(); // tableId → таймер хода бота
    this.aiDelay = 1; // множитель пауз ботов (в тестах 0)
    this.presence = { offlineSince: () => null }; // подменяется сервером
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of data) this.tables.set(t.id, t);
      console.log(`[tables] загружено столов: ${this.tables.size}`);
    } catch { /* файла ещё нет */ }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.tables.values()]));
      fs.renameSync(tmp, this.file);
    }, 500);
  }

  emit(table, event) {
    if (event.type === 'update') table.updatedAt = Date.now();
    for (const fn of this.listeners) fn(table, event);
    if (event.type === 'update') this.scheduleAI(table);
  }

  // ---------- боты ----------

  scheduleAll() { for (const t of this.tables.values()) this.scheduleAI(t); }

  scheduleAI(t) {
    const g = t.game;
    const seat = actingSeats(g).find((s) => t.seats[s]?.ai);
    if (seat == null || this.aiTimers.has(t.id)) return;
    const base = g.phase === 'play' ? 650 : 1100;
    const delay = (base + Math.random() * base * 0.8) * this.aiDelay;
    this.aiTimers.set(t.id, setTimeout(() => {
      this.aiTimers.delete(t.id);
      this.runAI(t, seat);
    }, delay));
  }

  runAI(t, seat) {
    const g = t.game;
    if (!actingSeats(g).includes(seat) || !t.seats[seat]?.ai) return this.scheduleAI(t);
    try {
      this.actSeat(t, seat, decide(g, seat, t.seats[seat].ai));
    } catch (e) {
      // бот не должен останавливать игру: делаем любой допустимый ход
      console.error('[ai]', e);
      const l = viewFor(g, seat).legal;
      const fallback = l.answerProposal ? { type: 'answerProposal', accept: false }
        : l.bids.length ? { type: 'bid', bid: 'PASS' }
        : l.contracts.length ? { type: 'discard', cards: g.hands[seat].slice(0, 2), contract: l.contracts[0] }
        : l.whist.length ? { type: 'whist', choice: 'PASS' }
        : l.whistMode ? { type: 'whistMode', open: true }
        : { type: 'play', card: l.cards[0] };
      this.actSeat(t, seat, fallback);
    }
  }

  botSeat(level) {
    const lvl = AI_LEVELS[level] ? level : 'amateur';
    const name = AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)];
    return { id: `ai:${crypto.randomBytes(3).toString('hex')}`, name, photo: null, ai: lvl, bot: true };
  }

  requireSeated(t, user) {
    const s = this.seatOf(t, user.id);
    if (s === -1) throw new Error('Сначала сядьте за стол');
    return s;
  }

  addBot(t, user, seat, level) {
    this.requireSeated(t, user);
    if (t.game && t.game.phase !== 'gameOver') throw new Error('Партия уже идёт');
    if (seat == null) seat = t.seats.findIndex((s) => !s);
    if (seat < 0 || seat > 2 || t.seats[seat]) throw new Error('Место занято');
    const taken = new Set(t.seats.filter(Boolean).map((s) => s.name));
    let bot = this.botSeat(level);
    while (taken.has(bot.name)) bot = this.botSeat(level);
    t.seats[seat] = bot;
    this.save();
    this.emit(t, { type: 'update' });
  }

  removeBot(t, user, seat) {
    this.requireSeated(t, user);
    if (t.game && t.game.phase !== 'gameOver') throw new Error('Партия уже идёт');
    if (!t.seats[seat]?.bot) throw new Error('Там не бот');
    t.seats[seat] = null;
    this.save();
    this.emit(t, { type: 'update' });
  }

  // Посадить ИИ вместо игрока посреди партии: за себя — всегда, за другого — если он не в сети
  takeover(t, user, seat, level) {
    const mine = this.requireSeated(t, user);
    const s = t.seats[seat];
    if (!t.game || !s || s.bot || s.ai) throw new Error('Здесь нельзя');
    if (seat !== mine) {
      const since = this.presence.offlineSince(t.id, s.id);
      if (since == null) throw new Error(`${s.name} в сети`);
      const wait = Math.ceil(20 - (Date.now() - since) / 1000);
      if (wait > 0) throw new Error(`Подождите ещё ${wait} с — вдруг вернётся`);
    }
    s.ai = AI_LEVELS[level] ? level : 'pro';
    this.pushChat(t, { system: true, text: `🤖 За ${s.name} играет ИИ (${AI_LEVELS[s.ai].label})` });
    this.save();
    this.emit(t, { type: 'update' });
  }

  reclaim(t, user) {
    const seat = this.requireSeated(t, user);
    const s = t.seats[seat];
    if (!s.ai) return;
    s.ai = null;
    this.pushChat(t, { system: true, text: `${s.name} вернулся в игру` });
    this.save();
    this.emit(t, { type: 'update' });
  }

  create({ chatId = null, chatTitle = null, chatUsername = null } = {}) {
    const id = crypto.randomBytes(5).toString('base64url');
    const t = {
      id, chatId, chatTitle, chatUsername, chatLinkMsgId: null, callActive: false,
      seats: [null, null, null], game: null, chat: [], createdAt: Date.now(),
    };
    this.tables.set(id, t);
    this.save();
    return t;
  }

  get(id) { return this.tables.get(id) || null; }

  byChat(chatId) {
    let found = null;
    for (const t of this.tables.values()) if (t.chatId === chatId && (!found || t.createdAt > found.createdAt)) found = t;
    return found;
  }

// Куда вернуть игрока, открывшего игру без ссылки на стол: идущая партия, затем лобби
  activeFor(userId) {
    let best = null;
    const rank = (t) => (t.game && t.game.phase !== 'gameOver' ? 2 : !t.game ? 1 : 0);
    for (const t of this.tables.values()) {
      if (this.seatOf(t, userId) === -1 || rank(t) === 0) continue;
      const key = [rank(t), t.updatedAt || t.createdAt];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { t, key };
    }
    return best?.t || null;
  }

  // Какой стол открыть при входе
  resolveTable(userId, explicitId, lastId) {
    const explicit = explicitId && this.get(explicitId);
    // по свежей ссылке — туда, если стол ещё живой
    if (explicit && explicit.game?.phase !== 'gameOver') return explicit;
    const active = this.activeFor(userId);
    if (active) return active;
    if (explicit) return explicit;
    const last = lastId && this.get(lastId);
    return last && this.seatOf(last, userId) !== -1 ? last : null;
  }

  // Против одних ботов пулю можно закончить в любой момент
  finish(t, user) {
    const seat = this.requireSeated(t, user);
    if (!t.game) throw new Error('Партия не началась');
    if (t.seats.some((s, i) => i !== seat && !s.bot)) throw new Error('Досрочно закончить можно только игру против ИИ');
    finishEarly(t.game);
    const g = t.game;
    const lines = g.players.map((p, s) => `${p.name}: ${g.final[s] > 0 ? '+' : ''}${g.final[s]}`);
    this.pushChat(t, { system: true, text: `🏁 Пуля закончена досрочно\n${lines.join('\n')}` });
    this.save();
    this.emit(t, { type: 'update' });
  }

  seatOf(t, userId) { return t.seats.findIndex((s) => s && s.id === userId); }

  sit(t, user, seat) {
    if (t.game) throw new Error('Партия уже идёт');
    if (this.seatOf(t, user.id) !== -1) throw new Error('Вы уже за столом');
    if (seat == null) seat = t.seats.findIndex((s) => !s);
    if (seat < 0 || seat > 2 || t.seats[seat]) throw new Error('Место занято');
    t.seats[seat] = { id: user.id, name: user.name, photo: user.photo || null };
    this.save();
    this.emit(t, { type: 'update' });
  }

  stand(t, user) {
    if (t.game && t.game.phase !== 'gameOver') throw new Error('Нельзя встать во время партии');
    const s = this.seatOf(t, user.id);
    if (s === -1) return;
    t.seats[s] = null;
    this.save();
    this.emit(t, { type: 'update' });
  }

  start(t, user, config = {}) {
    if (this.seatOf(t, user.id) === -1) throw new Error('Начать может только игрок за столом');
    if (t.seats.some((s) => !s)) throw new Error('Нужно три игрока — посадите ИИ на свободные места');
    // игроков, отдавших место ИИ в прошлой пуле, возвращаем
    for (const s of t.seats) if (!s.bot) s.ai = null;
    if (t.game && t.game.phase !== 'gameOver') throw new Error('Партия уже идёт');
    const poolTarget = [10, 20, 30, 50].includes(Number(config.poolTarget)) ? Number(config.poolTarget) : 20;
    const raspasExit = RASPAS_EXIT[config.raspasExit] ? String(config.raspasExit) : '6';
    t.game = createGame({ players: t.seats, config: { poolTarget, raspasExit }, dealer: Math.floor(Math.random() * 3) });
    const exitText = raspasExit === '6' ? '' : `, выход с распасов ${RASPAS_EXIT[raspasExit].label}`;
    this.pushChat(t, { system: true, text: `Новая пуля до ${poolTarget}${exitText}. ${t.game.log.at(-1)}` });
    this.save();
    this.emit(t, { type: 'update' });
    this.emit(t, { type: 'announce', text: `🃏 Пуля до ${poolTarget}${exitText} началась: ${t.seats.map((s) => s.name).join(', ')}` });
  }

  act(t, user, action) {
    const seat = this.seatOf(t, user.id);
    if (!t.game || seat === -1) throw new Error('Вы не играете за этим столом');
    if (t.seats[seat].ai && action?.type !== 'nextDeal') throw new Error('За вас играет ИИ — нажмите «Вернуть управление»');
    this.actSeat(t, seat, action);
  }

  actSeat(t, seat, action) {
    const g = t.game;
    const before = { phase: g.phase, contract: g.contract };
    act(g, seat, action);
    // короткие анонсы в групповой чат: заказ, итог раздачи, конец пули
    if (!before.contract && g.contract) {
      this.emit(t, { type: 'announce', text: `🎯 ${g.players[g.declarer].name} играет ${bidLabel(g.contract)}` });
    }
    if (before.phase !== g.phase && (g.phase === 'dealEnd' || g.phase === 'gameOver')) {
      const r = g.lastResult;
      this.emit(t, { type: 'announce', text: `📋 ${r.title}\n${r.lines.join('\n')}` });
    }
    if (g.phase === 'gameOver' && before.phase !== 'gameOver') {
      const lines = g.players.map((p, s) => `${p.name}: ${g.final[s] > 0 ? '+' : ''}${g.final[s]}`);
      this.emit(t, { type: 'announce', text: `🏁 Пуля закрыта!\n${lines.join('\n')}` });
    }
    this.save();
    this.emit(t, { type: 'update' });
  }

  pushChat(t, msg) {
    const m = { ts: Date.now(), ...msg };
    t.chat.push(m);
    if (t.chat.length > CHAT_LIMIT) t.chat.splice(0, t.chat.length - CHAT_LIMIT);
    this.save();
    this.emit(t, { type: 'chat', msg: m });
    return m;
  }

  publicInfo(t) {
    return {
      id: t.id,
      seats: t.seats.map((s) => s && { ...s, online: s.bot || this.presence.offlineSince(t.id, s.id) == null }),
      chatTitle: t.chatTitle,
      hasChat: t.chatId != null,
      chatLink: chatLink(t),
      callActive: t.callActive,
      started: !!t.game,
    };
  }

  viewFor(t, userId) {
    const seat = this.seatOf(t, userId);
    if (!t.game) return null;
    const v = viewFor(t.game, seat === -1 ? null : seat);
    // пока за игрока играет ИИ, ходить ему нечем
    if (seat !== -1 && t.seats[seat].ai) v.legal = { bids: [], contracts: [], whist: [], whistMode: false, cards: [], playSeat: null, controls: [] };
    return v;
  }
}

// Ссылка, чтобы прыгнуть из Mini App в групповой чат (и звонок)
function chatLink(t) {
  if (t.chatUsername) return `https://t.me/${t.chatUsername}`;
  if (t.chatId && String(t.chatId).startsWith('-100')) {
    return `https://t.me/c/${String(t.chatId).slice(4)}/${t.chatLinkMsgId || 1}`;
  }
  return null;
}
