// HTTP (статика Mini App) + WebSocket (игра и чат) + Telegram-бот.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Tables } from './tables.js';
import { Bot, validateInitData } from './telegram.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8080);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_SHORT_NAME = process.env.APP_SHORT_NAME || ''; // из BotFather /newapp; пусто — Main Mini App
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const DEV = process.env.DEV === '1'; // вход без Telegram: ?dev=Имя

const tables = new Tables(process.env.DATA_FILE || path.join(ROOT, 'data', 'tables.json'));
const clients = new Set(); // { ws, user, tableId }

// Кто из игроков сейчас подключён: нужно, чтобы заменять ушедших ИИ
const offlineAt = new Map(); // `${tableId}|${userId}` → время ухода
tables.presence.offlineSince = (tableId, userId) => {
  for (const c of clients) if (c.tableId === tableId && c.user?.id === userId) return null;
  return offlineAt.get(`${tableId}|${userId}`) ?? 0;
};
function presenceChanged(client) {
  const t = client.tableId && tables.get(client.tableId);
  if (t && client.user) {
    offlineAt.set(`${t.id}|${client.user.id}`, Date.now());
    tables.emit(t, { type: 'update' });
  }
}
let bot = null;

// ---------- статика ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = path.join(ROOT, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client = { ws, user: null, tableId: null };
  clients.add(client);
  ws.on('close', () => { clients.delete(client); presenceChanged(client); });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(client, msg); } catch (e) { send(ws, { t: 'error', text: e.message }); }
  });
});

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function appLink(tableId) {
  if (!bot?.me) return null;
  if (APP_SHORT_NAME) return `https://t.me/${bot.me.username}/${APP_SHORT_NAME}?startapp=${tableId}`;
  // без Mini App в BotFather: ссылка в личку боту, он пришлёт кнопку с этим столом
  return `https://t.me/${bot.me.username}?start=t_${tableId}`;
}

function tableUrl(tableId) {
  const u = new URL(WEBAPP_URL);
  u.searchParams.set('table', tableId);
  return u.toString();
}

function sendState(client) {
  const t = tables.get(client.tableId);
  if (!t) return;
  send(client.ws, { t: 'state', table: tables.publicInfo(t), view: tables.viewFor(t, client.user.id), link: appLink(t.id) });
}

function handle(client, msg) {
  if (msg.t === 'hello') {
    let auth = validateInitData(msg.initData, BOT_TOKEN);
    if (!auth && DEV && msg.dev) {
      const name = String(msg.dev).slice(0, 24);
      auth = { user: { id: `dev:${name}`, name }, startParam: msg.tableId || null };
    }
    if (!auth) throw new Error('Не удалось проверить вход через Telegram');
    client.user = auth.user;
    const tableId = msg.tableId || auth.startParam;
    client.tableId = tableId && tables.get(tableId) ? tableId : null;
    send(client.ws, { t: 'welcome', me: client.user, tableId: client.tableId });
    if (client.tableId) {
      const t = tables.get(client.tableId);
      send(client.ws, { t: 'chatHistory', chat: t.chat.slice(-100) });
      presenceChanged(client);
    }
    return;
  }
  if (!client.user) throw new Error('Сначала hello');

  if (msg.t === 'create') {
    const t = tables.create();
    client.tableId = t.id;
    tables.sit(t, client.user);
    send(client.ws, { t: 'welcome', me: client.user, tableId: t.id });
    send(client.ws, { t: 'chatHistory', chat: [] });
    if (msg.bots) { // «Сыграть с ИИ» — сразу двое ботов и старт
      tables.addBot(t, client.user, null, msg.bots);
      tables.addBot(t, client.user, null, msg.bots);
      tables.start(t, client.user, msg.config);
    }
    sendState(client);
    return;
  }

  const t = tables.get(client.tableId);
  if (!t) throw new Error('Стол не найден');
  switch (msg.t) {
    case 'sit': tables.sit(t, client.user, msg.seat); break;
    case 'stand': tables.stand(t, client.user); break;
    case 'start': tables.start(t, client.user, msg.config); break;
    case 'addBot': tables.addBot(t, client.user, msg.seat, msg.level); break;
    case 'fillBots': {
      for (let i = 0; i < 3; i++) if (!t.seats[i]) tables.addBot(t, client.user, i, msg.level);
      tables.start(t, client.user, msg.config);
      break;
    }
    case 'removeBot': tables.removeBot(t, client.user, msg.seat); break;
    case 'takeover': tables.takeover(t, client.user, msg.seat, msg.level); break;
    case 'reclaim': tables.reclaim(t, client.user); break;
    case 'act': tables.act(t, client.user, msg.action); break;
    case 'chat': {
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) return;
      tables.pushChat(t, { from: client.user.name, fromId: client.user.id, text });
      if (t.chatId && bot) bot.send(t.chatId, `💬 ${client.user.name}: ${text}`);
      break;
    }
    case 'emote': {
      const e = String(msg.e || '').slice(0, 8);
      for (const c of clients) if (c.tableId === t.id) send(c.ws, { t: 'emote', fromId: client.user.id, e });
      break;
    }
    default: throw new Error('Неизвестная команда');
  }
}

tables.listeners.add((t, ev) => {
  if (ev.type === 'update') for (const c of clients) if (c.tableId === t.id) sendState(c);
  if (ev.type === 'chat') for (const c of clients) if (c.tableId === t.id) send(c.ws, { t: 'chat', msg: ev.msg });
  if (ev.type === 'announce') {
    tables.pushChat(t, { system: true, text: ev.text });
    if (t.chatId && bot) bot.send(t.chatId, ev.text);
  }
});

// ---------- Бот ----------
async function onUpdate(u) {
  const m = u.message;
  if (!m) return;
  const chat = m.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const text = m.text || '';
  const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : null;

  // /start t_<id> — пришли по кнопке «Играть» из группы
  const startTable = cmd === '/start' && !isGroup && WEBAPP_URL ? text.split(/\s+/)[1]?.match(/^t_([\w-]+)$/)?.[1] : null;
  if (startTable) {
    const t = tables.get(startTable);
    if (!t) return bot.send(chat.id, 'Этот стол уже не найден. Попросите в группе новый: /newgame');
    return bot.send(chat.id, `🃏 Стол${t.chatTitle ? ` группы «${t.chatTitle}»` : ''} готов. Жмите, чтобы сесть:`, {
      reply_markup: { inline_keyboard: [[{ text: '▶️ Открыть стол', web_app: { url: tableUrl(t.id) } }]] },
    });
  }

  if (cmd === '/start' || cmd === '/help') {
    const help = [
      'Преферанс «Сочинка» на троих.',
      '1. Создайте группу с двумя друзьями и добавьте меня.',
      '2. В группе отправьте /newgame — появится кнопка «Играть».',
      '3. Запустите видеочат группы: звонок продолжается, пока открыта игра, а чат — рядом.',
    ].join('\n');
    const extra = !isGroup && WEBAPP_URL ? { reply_markup: { inline_keyboard: [[{ text: '🃏 Открыть игру', web_app: { url: WEBAPP_URL } }]] } } : {};
    return bot.send(chat.id, help, extra);
  }

  if (cmd === '/newgame') {
    if (!isGroup) return bot.send(chat.id, 'Команда работает в группе с тремя игроками.');
    const t = tables.create({ chatId: chat.id, chatTitle: chat.title, chatUsername: chat.username || null });
    const sent = await bot.send(chat.id, '🃏 Новый стол для пули. Жмите «Играть» — первые трое садятся за стол.\nЗвонок в группе можно не выключать.', {
      reply_markup: { inline_keyboard: [[{ text: '▶️ Играть', url: appLink(t.id) }]] },
    });
    if (sent) { t.chatLinkMsgId = sent.message_id; tables.save(); }
    return;
  }

  const t = isGroup ? tables.byChat(chat.id) : null;
  if (!t) return;

  if (cmd === '/score') {
    const g = t.game;
    if (!g) return bot.send(chat.id, 'Партия ещё не началась.');
    const lines = g.players.map((p, s) => `${p.name}: пуля ${g.score.pool[s]}, гора ${g.score.mountain[s]}`);
    return bot.send(chat.id, `📊 Раздача ${g.dealNo}\n${lines.join('\n')}`);
  }

  // звонок в группе → баннер в игре
  if (m.video_chat_started || m.video_chat_ended) {
    t.callActive = !!m.video_chat_started;
    tables.save();
    tables.emit(t, { type: 'update' });
    return;
  }

  // сообщения из группы видны в чате внутри игры (нужен выключенный privacy mode или бот-админ)
  if (text && !cmd && !m.from?.is_bot) {
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ');
    tables.pushChat(t, { from: name, fromId: String(m.from?.id), text: text.slice(0, 500), viaTelegram: true });
  }
}

if (BOT_TOKEN) {
  bot = new Bot(BOT_TOKEN, { onUpdate, webAppUrl: WEBAPP_URL });
  bot.start().catch((e) => console.error('[bot] не запустился:', e.message));
} else {
  console.warn('[bot] BOT_TOKEN не задан — бот выключен');
}

tables.aiDelay = Number(process.env.AI_DELAY ?? 1); // пауза «на подумать» у ботов
tables.scheduleAll();
server.listen(PORT, () => console.log(`[http] http://localhost:${PORT}${DEV ? '  (DEV: /?dev=Имя&table=ID)' : ''}`));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
