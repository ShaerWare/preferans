// Клиент Mini App: рисует стол по состоянию с сервера и шлёт действия.
const tg = window.Telegram?.WebApp;
const qs = new URLSearchParams(location.search);
const DEV_NAME = qs.get('dev');

const SUIT = { S: '♠', C: '♣', D: '♦', H: '♥', N: 'БК' };
const RED = new Set(['D', 'H']);
const RANK_ORDER = '789TJQKA';
const SUIT_SENIORITY = ['S', 'C', 'D', 'H']; // ♠ ♣ ♦ ♥ — старшинство
const EMOTES = ['👍', '😂', '🔥', '😱', '🤬', '🤔', '👏', '🍺'];
const WHIST_LABEL = { WHIST: 'вист', PASS: 'пас', HALF: 'полвиста' };
const AI_LABEL = { novice: 'Новичок', amateur: 'Любитель', pro: 'Профи', master: 'Мастер' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const S = {
  ws: null, me: null, tableId: qs.get('table') || tg?.initDataUnsafe?.start_param || null,
  table: null, view: null, link: null, chat: [], unread: 0,
  discardSel: new Set(), contractSel: null, poolTarget: Number(store.get('poolTarget')) || 20, raspasExit: store.get('raspasExit') || '6', stalingrad: store.get('stalingrad') === '1', raspasPrices: store.get('raspasPrices') || '1', aiLevel: store.get('aiLevel') || 'pro',
  lastTrickShow: null, prevTrickNo: null, wasMyTurn: false, lastPhase: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Telegram ----------
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#154330'); tg.setBackgroundColor('#154330'); } catch {}
}

// ---------- соединение ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  // сервер сам вернёт в активную партию; lastTableId — запасной вариант с этого устройства
  ws.onopen = () => send({
    t: 'hello', initData: tg?.initData || '', dev: DEV_NAME,
    tableId: S.tableId, lastTableId: store.get('tableId'), noResume: S.noResume,
  });
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}
function send(obj) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(obj)); }

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      S.me = m.me;
      S.tableId = m.tableId;
      rememberTable(m.tableId);
      if (!m.tableId) render();
      break;
    case 'state': onState(m); break;
    case 'chatHistory': S.chat = m.chat; renderChat(); break;
    case 'chat':
      S.chat.push(m.msg);
      if ($('#chat-panel').hidden && !m.msg.system && m.msg.fromId !== S.me?.id) S.unread++;
      renderChat();
      break;
    case 'emote': showEmote(m.fromId, m.e); break;
    case 'error': toast(m.text); break;
    case 'stats': S.stats = m; renderStats(); break;
  }
}

function onState(m) {
  const prev = S.view;
  S.table = m.table; S.view = m.view; S.link = m.link;
  const v = S.view;
  if (v?.phase !== S.lastPhase) { S.discardSel.clear(); S.contractSel = null; S.confirmW3 = false; S.lastPhase = v?.phase; }
  if (!v?.legal?.propose) S.proposeSel = null;
  else if (S.proposeSel != null && !v.legal.proposeOptions.includes(S.proposeSel)) S.proposeSel = defaultProposal(v);
  // показать закрытую взятку ещё немного
  // сыграна новая взятка (или новая раздача) — «последнюю взятку» прячем
  if (!v?.play || (prev?.play && v.play.trickNo !== prev.play.trickNo)) { S.peekLast = false; S.peekTalon = false; }
  if (v?.play && prev?.play && v.play.trickNo > prev.play.trickNo && v.play.lastTrick) {
    S.lastTrickShow = { trick: v.play.lastTrick, until: Date.now() + 1400 };
    setTimeout(render, 1450);
  }
  const myTurn = isMyTurn();
  if (myTurn && !S.wasMyTurn) tg?.HapticFeedback?.notificationOccurred('success');
  S.wasMyTurn = myTurn;
  if (tg) { v && !['gameOver'].includes(v.phase) ? tg.enableClosingConfirmation() : tg.disableClosingConfirmation(); }
  render();
}

function isMyTurn() {
  const v = S.view;
  if (!v || v.seat == null) return false;
  const l = v.legal;
  return l.bids.length > 0 || l.contracts.length > 0 || l.whist.length > 0 || l.whistMode || l.catchChoice || l.playSeat != null;
}

// ---------- карты ----------
function cardHtml(c, { cls = '', attrs = '' } = {}) {
  const r = c[0] === 'T' ? '10' : c[0];
  const s = c.slice(-1);
  return `<div class="card ${RED.has(s) ? 'red' : ''} ${cls}" data-card="${c}" ${attrs}><span class="r">${r}</span><span class="s">${SUIT[s]}</span><span class="big">${SUIT[s]}</span></div>`;
}
// Масти идут по старшинству ♠ ♣ ♦ ♥, но на экране чередуем чёрные и красные (♠ ♦ ♣ ♥),
// считая только масти, которые есть в руке. Козырь — первым, если это не ломает чередование.
function suitDisplayOrder(present, trump) {
  const ranked = (list) => [...list].sort((a, b) => (b === trump) - (a === trump) || SUIT_SENIORITY.indexOf(a) - SUIT_SENIORITY.indexOf(b));
  const reds = ranked(present.filter((s) => RED.has(s)));
  const blacks = ranked(present.filter((s) => !RED.has(s)));
  let first = reds.length > blacks.length ? reds : blacks.length > reds.length ? blacks
    : trump && RED.has(trump) && reds.includes(trump) ? reds : blacks;
  const second = first === reds ? blacks : reds;
  const out = [];
  for (let i = 0; i < first.length; i++) out.push(first[i], ...(second[i] ? [second[i]] : []));
  return out;
}
function sortHand(h, trump) {
  const present = SUIT_SENIORITY.filter((s) => h.some((c) => c.slice(-1) === s));
  const order = suitDisplayOrder(present, trump);
  return [...h].sort((a, b) => order.indexOf(a.slice(-1)) - order.indexOf(b.slice(-1)) || RANK_ORDER.indexOf(b[0]) - RANK_ORDER.indexOf(a[0]));
}
const bidLabel = (b) => (b === 'PASS' ? 'пас' : b === 'MIS' ? 'мизер' : `${parseInt(b, 10)}${SUIT[b.slice(-1)]}`);
const bidHtml = (b) => (b === 'MIS' || b === 'PASS' ? bidLabel(b) : `${parseInt(b, 10)}<span class="${RED.has(b.slice(-1)) ? 'red' : ''}">${SUIT[b.slice(-1)]}</span>`);

// ---------- отрисовка ----------
function render() {
  const scr = $('#screen');
  $('#btn-group').hidden = !S.table?.chatLink;
  $('#call-banner').hidden = !S.table?.callActive;
  $('#title').textContent = S.table?.chatTitle ? `🃏 ${S.table.chatTitle}` : 'Преферанс · Сочи';
  renderBadge();
  if (!S.me) { scr.innerHTML = `<div class="lobby"><div class="hint">${tg?.initData || DEV_NAME ? 'Подключение…' : 'Откройте игру через Telegram-бота.'}</div></div>`; return; }
  if (!S.tableId) { scr.innerHTML = noTableHtml(); return; }
  if (!S.table) { scr.innerHTML = '<div class="lobby"><div class="hint">Загрузка стола…</div></div>'; return; }
  // нет партии или пуля закрыта и кто-то ушёл — лобби: можно позвать людей или посадить ИИ
  if (!S.view || (S.view.phase === 'gameOver' && S.table.seats.some((s) => !s))) { scr.innerHTML = lobbyHtml(); return; }
  scr.innerHTML = tableHtml();
  layoutHand();
  if (!$('#score-panel').hidden) renderScore();
}

function noTableHtml() {
  return `<div class="lobby">
    <h2>🃏 Преферанс «Сочинка»</h2>
    <div class="hint">Лучше всего играть из группы: создайте группу с двумя друзьями, добавьте туда бота и отправьте <b>/newgame</b>. Тогда рядом с игрой будут чат и видеозвонок группы.</div>
    <div>Уровень ИИ:</div>${levelSeg()}
    ${settingsHtml()}
    ${S.noResume ? '<button class="btn ghost" data-act="resume">↩️ Вернуться к игре</button>' : ''}
    <div class="row"><button class="btn" data-act="solo">🤖 Сыграть с ИИ</button><button class="btn ghost" data-act="create">Создать стол</button></div>
  </div>`;
}

function avatar(p) {
  if (!p) return '<div class="avatar">?</div>';
  return `<div class="avatar">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : esc(p.name.slice(0, 1).toUpperCase())}</div>`;
}

function lobbyHtml() {
  const t = S.table;
  const mine = t.seats.findIndex((s) => s?.id === S.me.id);
  const full = t.seats.every(Boolean);
  const seats = t.seats.map((p, i) => `<div class="seat-box">${avatar(p)}<div class="pl-name">${p ? esc(p.name) : 'Свободно'}</div>
    ${p?.bot ? `<span class="tag">🤖 ${AI_LABEL[p.ai]}</span>` : ''}
    ${!p && mine === -1 ? `<button class="btn small" data-act="sit" data-seat="${i}">Сесть</button>` : ''}
    ${!p && mine !== -1 ? `<button class="btn small ghost" data-act="addBot" data-seat="${i}">🤖 + ИИ</button>` : ''}
    ${p?.bot && mine !== -1 ? `<button class="btn small ghost" data-act="removeBot" data-seat="${i}">Убрать</button>` : ''}
    ${p && p.id === S.me.id ? '<button class="btn small ghost" data-act="stand">Встать</button>' : ''}</div>`).join('');
  return `<div class="lobby">
    <h2>Собираем пулю</h2>
    <div class="seats">${seats}</div>
    ${settingsHtml()}
    <div>Уровень ИИ:</div>${levelSeg()}
    ${full
      ? `<button class="btn" data-act="start" ${mine !== -1 ? '' : 'disabled'}>Начать игру</button>`
      : `<button class="btn" data-act="fillBots" ${mine !== -1 ? '' : 'disabled'}>Добавить ИИ на свободные места и начать</button>`}
    ${inviteHtml()}
  </div>`;
}

const RASPAS_EXIT = { 6: '6', 7: '7', prog9: '7 → 8 → 9', prog8: '7 → 8 → 8' };
const RASPAS_EXIT_HINT = {
  6: 'После распасов торгуемся как обычно, с 6♠.',
  7: 'После распасов торговля начинается с 7♠.',
  prog9: 'После 1-х распасов подряд — с 7♠, после 2-х — с 8♠, дальше — с 9♠.',
  prog8: 'После 1-х распасов подряд — с 7♠, после 2-х и дальше — с 8♠.',
};

// Настройки пули: размер и выход с распасов (мизер разрешён всегда)
const poolConfig = () => ({ poolTarget: S.poolTarget, raspasExit: S.raspasExit, stalingrad: S.stalingrad, raspasPrices: S.raspasPrices });
const RASPAS_PRICE = { 1: '1, 1, 1…', 12: '1, 2, 2…', 124: '1, 2, 4…' };
const RASPAS_PRICE_HINT = {
  1: 'Взятка на распасах всегда стоит 1.',
  12: 'Первые распасы — взятка 1, вторые подряд и дальше — 2.',
  124: 'Первые распасы — взятка 1, вторые подряд — 2, третьи и дальше — 4.',
};
// какую цену подставлять при выборе выхода с распасов (можно поменять вручную)
const PRICE_FOR_EXIT = { 6: '1', 7: '12', prog9: '124', prog8: '124' };

function settingsHtml() {
  const pool = [10, 20, 30].map((n) => `<button data-act="pool" data-n="${n}" class="${S.poolTarget === n ? 'on' : ''}">${n}</button>`).join('');
  const exit = Object.entries(RASPAS_EXIT).map(([k, l]) => `<button data-act="rexit" data-k="${k}" class="${S.raspasExit === k ? 'on' : ''}">${l}</button>`).join('');
  return `<div>Пуля до: <span class="seg">${pool}</span></div>
    <div>Выход с распасов:</div><span class="seg">${exit}</span>
    <div class="hint">${RASPAS_EXIT_HINT[S.raspasExit]} Мизер можно всегда.</div>
    <div>Цена взятки на распасах:</div>
    <span class="seg">${Object.entries(RASPAS_PRICE).map(([k, l]) => `<button data-act="rprice" data-k="${k}" class="${S.raspasPrices === k ? 'on' : ''}">${l}</button>`).join('')}</span>
    <div class="hint">${RASPAS_PRICE_HINT[S.raspasPrices]} Круг — распасы подряд; несыгранная игра их не прерывает, после сыгранной снова 1.${S.raspasPrices === '1' ? ' Без взяток в пулю: при выходе с 6 — 1, с 7 — 2, с 8 — 4.' : ''}</div>
    <div>Сталинград (обязон):</div>
    <span class="seg"><button data-act="stal" data-v="0" class="${S.stalingrad ? '' : 'on'}">Нет</button><button data-act="stal" data-v="1" class="${S.stalingrad ? 'on' : ''}">Да</button></span>
    <div class="hint">${S.stalingrad ? 'На 6♠ вистуют оба обязательно, в закрытую; за недовист отвечают как обычно.' : 'На 6♠ вистуют по желанию, как на любой игре.'}</div>`;
}

function levelSeg() {
  const btns = Object.entries(AI_LABEL).map(([k, l]) => `<button data-act="level" data-l="${k}" class="${S.aiLevel === k ? 'on' : ''}">${l}</button>`);
  return `<span class="seg">${btns.join('')}</span>`;
}

function inviteHtml() {
  if (S.table.hasChat) return '<div class="hint">Пока ждёте — включите видеочат в группе, он не прервётся во время игры.</div>';
  if (S.link) return '<button class="btn ghost" data-act="invite">Позвать друзей</button>';
  if (DEV_NAME) return `<div class="hint">DEV: откройте ещё две вкладки с <code>?dev=Имя&table=${S.table.id}</code></div>`;
  return '';
}

function rel(seat) {
  const base = S.view.seat ?? 0;
  return ['bottom', 'left', 'right'][(seat - base + 3) % 3];
}

function turnSeat() {
  const v = S.view;
  if (v.phase === 'bidding') return v.bidding.turn;
  if (v.phase === 'talon') return v.declarer;
  if (v.phase === 'whisting' || v.phase === 'whistMode') return v.whist.turn;
  if (v.phase === 'misereCatch') return v.catch.turn;
  if (v.phase === 'play') return v.play.turn;
  return null;
}

function playerTags(s) {
  const v = S.view;
  const tags = [];
  const seat = S.table.seats[s];
  if (seat?.ai) tags.push(`<span class="tag">🤖 ${AI_LABEL[seat.ai]}</span>`);
  else if (seat && !seat.online) tags.push('<span class="tag off">не в сети</span>');
  if (v.dealer === s) tags.push('<span class="tag">сдаёт</span>');
  if (v.declarer === s && v.contract) tags.push(`<span class="tag gold">${bidHtml(v.contract)}</span>`);
  else if (v.phase === 'bidding' || (v.phase === 'talon' && v.declarer !== s)) {
    const last = [...(v.bidding?.log || [])].reverse().find((x) => x.seat === s);
    if (last) tags.push(`<span class="tag">${bidHtml(last.bid)}</span>`);
  }
  if (v.whist?.answers?.[s]) tags.push(`<span class="tag">${WHIST_LABEL[v.whist.answers[s]]}</span>`);
  if (v.whist?.halfBy === s) tags.push('<span class="tag">полвиста</span>');
  if (v.catch?.catcher === s) tags.push('<span class="tag gold">ловит</span>');
  else if (v.catch?.declined.includes(s) && v.phase === 'misereCatch') tags.push('<span class="tag">не ловит</span>');
  if (v.play) tags.push(`<span class="tag">взяток: ${v.play.tricks[s]}</span>`);
  return tags.join('');
}

// Открытый мизер: все 12 карт мизериста по мастям, без пометки сноса. Ушедшие во взятку —
// бледные с номером хода, последняя сыгранная — в золотой рамке.
function misereLayoutHtml() {
  const m = S.view.misere;
  const played = new Map(m.played.map((x) => [x.card, x.trickNo]));
  const last = m.played.length ? m.played[m.played.length - 1].card : null;
  const sorted = sortHand(m.cards, null);
  const suits = [...new Set(sorted.map((c) => c.slice(-1)))];
  const rows = suits.map((suit) => `<div class="mis-row">${sorted.filter((c) => c.slice(-1) === suit).map((c) => {
    const badge = played.has(c) ? `<span class="mis-badge">${played.get(c)}</span>` : '';
    const cls = `mini ${played.has(c) ? 'gone' : ''} ${c === last ? 'last' : ''}`;
    return `<div class="mis-slot">${cardHtml(c, { cls })}${badge}</div>`;
  }).join('')}</div>`).join('');
  return `<div class="mis-layout"><div class="mis-cap">карты мизериста (12 с прикупом)</div>${rows}</div>`;
}

function oppHtml(s) {
  const v = S.view;
  const p = v.players[s];
  const side = rel(s);
  const hand = v.hands[s];
  const clickable = v.legal.playSeat === s ? new Set(v.legal.cards) : null;
  let cards;
  if (v.misere && s === v.declarer) {
    cards = misereLayoutHtml();
  } else if (hand) {
    cards = `<div class="mini-hand">${sortHand(hand, v.play?.trump).map((c) => cardHtml(c, { cls: `mini ${clickable ? (clickable.has(c) ? 'legal' : 'dim') : ''}`, attrs: clickable?.has(c) ? `data-play="${c}"` : '' })).join('')}</div>`;
  } else {
    cards = `<div class="backs">${'<div class="back"></div>'.repeat(v.handCounts[s])}</div>`;
  }
  const seat = S.table.seats[s];
  const canReplace = v.seat != null && seat && !seat.ai && !seat.online && v.phase !== 'gameOver';
  return `<div class="opp ${side} ${turnSeat() === s ? 'turn' : ''}" data-seat-el="${s}">
    <div class="pl-head">${avatar(p)}<div><div class="pl-name">${esc(p.name)}</div><div class="pl-sub">${playerTags(s)}</div></div></div>
    ${canReplace ? `<button class="btn small" data-act="takeover" data-seat="${s}">🤖 Заменить ИИ</button>` : ''}
    ${cards}</div>`;
}

function centerHtml() {
  const v = S.view;
  let info = '';
  if (v.play?.kind === 'raspas') info = `Распасы — берите поменьше${v.raspasPrice > 1 ? ` · взятка по ${v.raspasPrice}` : ''}`;
  else if (v.contract === 'MIS') info = `${esc(v.players[v.declarer].name)} играет мизер${v.catch?.catcher != null ? ` · ловит ${esc(v.players[v.catch.catcher].name)}` : ''}`;
  else if (v.contract && v.play) {
    const ws = v.whist.whisters.map((s) => esc(v.players[s].name)).join(' и ');
    info = `${esc(v.players[v.declarer].name)}: ${bidHtml(v.contract)} · вист: ${ws}${v.whist.whisters.length === 1 ? (v.whist.open ? ' (в открытую)' : ' (в закрытую)') : ''}${v.config.stalingrad && v.contract === '6S' ? ' · Сталинград' : ''}`;
  } else if (v.phase === 'bidding') info = `Раздача №${v.dealNo} · торговля${v.minLevel > 6 ? ` с ${v.minLevel}♠ (выход с распасов)` : ''}${v.raspasPrice > 1 ? ` · распасы по ${v.raspasPrice}` : ''}`;

  let inner = '';
  if (v.phase === 'bidding') {
    inner = `<div><div class="talon-label">прикуп</div><div class="talon"><div class="card mini" style="background:repeating-linear-gradient(45deg,#8b1e2b 0 3px,#a8283a 3px 6px)"></div><div class="card mini" style="background:repeating-linear-gradient(45deg,#8b1e2b 0 3px,#a8283a 3px 6px)"></div></div></div>`;
  } else if (v.phase === 'talon' || v.phase === 'whisting' || v.phase === 'whistMode' || v.phase === 'misereCatch' || (v.phase === 'dealEnd' && !v.play)) {
    const inPanel = v.phase === 'talon' && v.legal.contracts.length; // сносящему прикуп показан в панели заказа
    inner = v.talon && !inPanel ? `<div><div class="talon-label">прикуп</div><div class="talon">${v.talon.map((c) => cardHtml(c)).join('')}</div></div>` : '';
  } else if (v.play && S.peekTalon && v.talon) {
    // «Прикуп»: какие карты лежали в прикупе
    inner = `<div><div class="talon-label">прикуп</div><div class="talon">${v.talon.map((c) => cardHtml(c)).join('')}</div></div>`;
  } else if (v.play && S.peekLast && v.play.lastTrick) {
    // «Последняя взятка»: кто чем сходил и кто взял
    const lt = v.play.lastTrick;
    inner = `<div class="trick peek">
      ${lt.talonCard ? cardHtml(lt.talonCard, { cls: 'pos-top' }) : ''}
      ${lt.cards.map((t, i) => `<div class="peek-card pos-${rel(t.seat)}">${cardHtml(t.card, { cls: lt.winner === t.seat ? 'winner' : '' })}<span class="who">${i + 1}. ${esc(v.players[t.seat].name)}</span></div>`).join('')}
    </div>
    <div class="peek-cap">Взятка №${v.play.trickNo}: ${lt.winner == null ? 'никто не взял' : `взял <b>${esc(v.players[lt.winner].name)}</b>`}</div>`;
  } else if (v.play) {
    const show = S.lastTrickShow && S.lastTrickShow.until > Date.now() ? S.lastTrickShow.trick : null;
    const trick = show ? show.cards : v.play.trick.length ? v.play.trick : (v.phase !== 'play' && v.play.lastTrick ? v.play.lastTrick.cards : []);
    const winner = show ? show.winner : null;
    const talonCard = show ? show.talonCard : v.play.talonLead;
    inner = `<div class="trick">
      ${talonCard ? cardHtml(talonCard, { cls: 'pos-top' }) : ''}
      ${trick.map((t) => cardHtml(t.card, { cls: `pos-${rel(t.seat)} ${winner === t.seat ? 'winner' : ''}` })).join('')}
    </div>`;
  }
  const talonBtn = v.phase === 'play' && v.talon
    ? `<button class="peek-btn ${S.peekTalon ? 'on' : ''}" data-act="peekTalon">${S.peekTalon ? '✕ К столу' : '🂠 Прикуп'}</button>`
    : '';
  const peekBtn = v.phase === 'play' && v.play?.lastTrick
    ? `<button class="peek-btn ${S.peekLast ? 'on' : ''}" data-act="peek">${S.peekLast ? '✕ К столу' : '👁 Последняя взятка'}</button>`
    : '';
  const peekBar = talonBtn || peekBtn ? `<div class="peek-bar">${talonBtn}${peekBtn}</div>` : '';
  return `<div class="center"><div class="contract-info">${info}</div>${inner}${peekBar}</div>`;
}

function actionsHtml() {
  const v = S.view;
  const name = (s) => esc(v.players[s].name);
  const l = v.legal;
  const t = turnSeat();
  const wait = (txt) => `<div class="msg">${txt}</div>`;

  switch (v.phase) {
    case 'bidding': {
      const log = v.bidding.log.map((x) => `${name(x.seat)}: ${bidHtml(x.bid)}`).join(' · ');
      if (!l.bids.length) return wait(`Торгуется <b>${name(t)}</b>…`) + (log ? `<div class="bid-log">${log}</div>` : '');
      return `<div class="bid-head"><b>Ваше слово</b><button class="btn small pass" data-act="bid" data-b="PASS">Пас</button></div>${bidGrid(l.bids, 'bid')}${log ? `<div class="bid-log">${log}</div>` : ''}`;
    }
    case 'talon': {
      if (!l.contracts.length) return wait(`<b>${name(v.declarer)}</b> взял прикуп и сносит…`);
      const mis = l.contracts[0] === 'MIS';
      const ready = S.discardSel.size === 2 && (mis || S.contractSel);
      // прикуп и выбранный снос — прямо в панели, чтобы сетка заказов их не закрывала
      const sel = [...S.discardSel];
      const talonRow = `<div class="talon-strip">
        ${v.talon ? `<span class="ts-label">прикуп</span>${v.talon.map((c) => cardHtml(c, { cls: 'mini' })).join('')}` : ''}
        <span class="ts-label">в снос</span>${[0, 1].map((i) => (sel[i] ? cardHtml(sel[i], { cls: 'mini' }) : '<div class="card mini ts-empty"></div>')).join('')}
      </div>`;
      return `${talonRow}<div class="msg">Выберите 2 карты в снос${mis ? '' : ' и игру'}</div>
        ${mis ? '' : bidGrid(l.contracts, 'contract', S.contractSel)}
        <div class="row"><button class="btn" data-act="discard" ${ready ? '' : 'disabled'}>Снести и заказать${mis ? ' мизер' : S.contractSel ? ' ' + bidHtml(S.contractSel) : ''}</button>
        ${l.withoutThree ? `<button class="btn ${S.confirmW3 ? 'danger' : 'ghost'}" data-act="w3">${S.confirmW3 ? 'Точно без трёх?' : '🏳️ Без трёх'}</button>` : ''}</div>
        ${S.confirmW3 ? `<div class="hint">Сдаётесь без розыгрыша: гора ${3 * gameValue(v.bidding.highest.bid)}, противникам — висты. Нажмите ещё раз для подтверждения.</div>` : ''}`;
    }
    case 'whisting':
      if (!l.whist.length) return wait(`<b>${name(t)}</b> решает: вист или пас`);
      return `<div class="msg">${name(v.declarer)} играет <b>${bidHtml(v.contract)}</b>${v.whist.halfBy != null ? ` · ${name(v.whist.halfBy)} сказал полвиста` : ''}</div>
        <div class="row">${l.whist.map((c) => `<button class="btn ${c === 'PASS' ? 'ghost' : ''}" data-act="whist" data-c="${c}">${c === 'HALF' ? 'Уйти за полвиста' : WHIST_LABEL[c]}</button>`).join('')}</div>
        ${l.whist.includes('HALF') ? '<div class="hint">Полвиста: без розыгрыша, вам — висты за половину обязательства. Первый вистующий ещё может передумать и вистовать.</div>' : ''}`;
    case 'misereCatch': {
      const [a, b] = v.catch.order;
      if (!l.catchChoice) return wait(`<b>${name(t)}</b> решает, кто ловит мизер`);
      const other = v.seat === a ? b : a;
      const second = v.seat === b;
      return `<div class="msg">${name(v.declarer)} играет <b>мизер</b>. Кто ловит?${second ? `<br>${name(a)} отказался` : ''}</div>
        <div class="row"><button class="btn" data-act="catch" data-take="1">🎯 Ловлю сам</button><button class="btn ghost" data-act="catch" data-take="0">Пусть ловит ${name(other)}</button></div>
        <div class="hint">Ловящий ходит за обе руки и сразу видит карты напарника.${second ? ` Если откажетесь, ловит ${name(a)}.` : ''}</div>`;
    }
    case 'whistMode':
      if (!l.whistMode) return wait(`<b>${name(t)}</b> выбирает, как вистовать`);
      return `<div class="msg">Вистуете один. Как играем?</div>
        <div class="row"><button class="btn" data-act="wmode" data-open="1">В открытую</button><button class="btn ghost" data-act="wmode" data-open="0">В закрытую</button></div>`;
    case 'play': {
      const pr = v.play.proposal;
      if (pr) {
        const head = `<div class="msg">🤝 ${pr.by === v.seat ? 'Вы предлагаете' : `<b>${name(pr.by)}</b> предлагает (карты открыты)`}:<br><b>${esc(pr.text)}</b></div>`;
        if (l.answerProposal) return head + '<div class="row"><button class="btn" data-act="answer" data-a="1">✅ Согласен</button><button class="btn ghost" data-act="answer" data-a="0">❌ Играем</button></div>';
        if (pr.by === v.seat) return head + '<div class="msg hint">Ждём ответа…</div><button class="btn small ghost" data-act="unpropose">Отозвать</button>';
        return head + '<div class="msg hint">Ждём остальных…</div>';
      }
      if (S.proposeSel != null) return proposeHtml();
      const ctl = v.play.controller?.[v.play.turn] ?? v.play.turn;
      const turn = l.playSeat == null
        ? (v.play.turn === v.seat && ctl !== v.seat ? `За вас ходит <b>${name(ctl)}</b>` : `Ходит <b>${name(v.play.turn)}</b>${ctl !== v.play.turn ? ` (за него — ${name(ctl)})` : ''}`)
        : l.playSeat === v.seat ? '<b>Ваш ход</b>' : `<b>Ходите за ${name(l.playSeat)}</b>`;
      const rest = l.takeRest
        ? `<button class="btn small ${S.confirmRest ? 'danger' : 'ghost'}" data-act="takeRest">${S.confirmRest ? `Точно все ${v.play.remaining} мои?` : '🙋 Остальные мои'}</button>`
        : '';
      return `<div class="row" style="align-items:center"><div class="msg">${turn}</div>${l.propose ? '<button class="btn small ghost" data-act="propose">🤝 Предложить</button>' : ''}${rest}</div>`;
    }
    case 'dealEnd': {
      const r = v.lastResult;
      return `<div class="result"><h3>${esc(r.title)}</h3>${r.lines.map((x) => `<div>${esc(x)}</div>`).join('')}</div>
        ${v.seat != null ? '<button class="btn" data-act="next">Следующая раздача</button>' : ''}`;
    }
    case 'gameOver': {
      const rows = v.players.map((p, s) => `<div>${esc(p.name)}: <b class="${v.final[s] >= 0 ? 'pos' : 'neg'}">${v.final[s] > 0 ? '+' : ''}${v.final[s]}</b></div>`).join('');
      return `<div class="result"><h3>🏁 Пуля закрыта</h3>${rows}</div>
        ${v.seat != null ? settingsHtml() + '<button class="btn" data-act="start">Новая пуля</button>' : ''}`;
    }
  }
  return '';
}

// Предложение — одно число: сколько всего возьмёт играющий
function proposalLabel(v, n) {
  if (v.play.kind === 'misere') return n === 0 ? 'чистый' : `поймали`;
  const L = parseInt(v.contract, 10);
  return n === L ? 'своя игра' : n < L ? `без ${L - n}` : `+${n - L}`;
}

function defaultProposal(v) {
  const opts = v.legal.proposeOptions;
  const want = v.play.kind === 'misere' ? 0 : parseInt(v.contract, 10);
  return opts.includes(want) ? want : want < opts[0] ? opts[0] : opts[opts.length - 1];
}

function proposeHtml() {
  const v = S.view;
  const who = v.declarer === v.seat ? 'Вы' : esc(v.players[v.declarer].name);
  const btns = v.legal.proposeOptions.map((n) => `<button class="prop-opt ${S.proposeSel === n ? 'on' : ''}" data-act="psel" data-n="${n}"><b>${n}</b><small>${proposalLabel(v, n)}</small></button>`).join('');
  return `<div class="msg">🤝 Сколько всего возьмёт ${v.declarer === v.seat ? '(вы)' : `<b>${who}</b>`}?</div>
    <div class="prop-grid">${btns}</div>
    <div class="hint">Ваши карты откроются остальным, пока они решают. Взятки защиты делятся поровну.</div>
    <div class="row"><button class="btn" data-act="psend">Предложить: ${S.proposeSel} — ${proposalLabel(v, S.proposeSel)}</button><button class="btn ghost" data-act="pcancel">Отмена</button></div>`;
}

const GAME_VALUE = { 6: 2, 7: 4, 8: 6, 9: 8, 10: 10 };
const gameValue = (bid) => GAME_VALUE[parseInt(bid, 10)] || 0;

function bidGrid(legal, kind, selected) {
  const ok = new Set(legal);
  const btn = (b) => `<button data-act="${kind}" data-b="${b}" class="${b !== 'MIS' && RED.has(b.slice(-1)) ? 'red' : ''} ${selected === b ? 'on' : ''} ${b === 'MIS' ? 'wide' : ''}" ${ok.has(b) ? '' : 'disabled'}>${b === 'MIS' ? 'мизер' : bidHtml(b)}</button>`;
  let html = '';
  for (const lvl of [6, 7, 8, 9, 10]) {
    if (lvl === 9 && ok.has('MIS')) html += btn('MIS');
    const row = ['S', 'C', 'D', 'H', 'N'].map((s) => `${lvl}${s}`);
    if (row.some((b) => ok.has(b))) html += row.map(btn).join(''); // недоступные уровни не показываем
  }
  return `<div class="bid-grid">${html}</div>`;
}

// После раздачи и в конце пули — весь лист пульки, свежие записи выделены
function resultHtml() {
  const v = S.view;
  const r = v.lastResult;
  const over = v.phase === 'gameOver';
  const finals = over ? `<div class="row">${v.players.map((p, s) => `<span>${esc(p.name)}: <b class="${v.final[s] >= 0 ? 'pos' : 'neg'}">${v.final[s] > 0 ? '+' : ''}${v.final[s]}</b></span>`).join('')}</div>` : '';
  const details = r ? `<details class="result-lines"><summary>Подробнее о раздаче</summary>${r.lines.map((x) => `<div>${esc(x)}</div>`).join('')}</details>` : '';
  const btn = v.seat == null ? ''
    : over ? `<div class="row"><button class="btn" data-act="leave">🏠 В общее меню</button><button class="btn ghost" data-act="start">🔁 Ещё пулю этим же составом</button></div>
      <details class="result-lines"><summary>Настройки новой пули</summary><div class="lobby" style="margin:0">${settingsHtml()}</div></details>`
    : '<button class="btn" data-act="next">Следующая раздача</button>';
  return `<div class="deal-end">
    <div class="result-title">${over ? '🏁 Пуля закрыта' : `№${v.dealNo} · ${esc(r?.title || '')}`}</div>
    ${finals}
    <div class="sheet-fit">${sheetSvg(v)}</div>
    <div class="hint">Красным — записи последней раздачи.</div>
    ${btn}
    ${details}
  </div>`;
}

function tableHtml() {
  const v = S.view;
  if (v.phase === 'dealEnd' || v.phase === 'gameOver') return resultHtml();
  const me = v.seat ?? 0;
  const autoPilot = v.seat != null && !!S.table.seats[v.seat]?.ai && !['dealEnd', 'gameOver'].includes(v.phase);
  const left = (me + 1) % 3;
  const right = (me + 2) % 3;
  const myHand = v.hands[me] || [];
  const legal = new Set(v.legal.playSeat === me ? v.legal.cards : []);
  const selecting = v.phase === 'talon' && v.legal.contracts.length;
  const handCards = sortHand(myHand, v.play?.trump || (v.contract && v.contract !== 'MIS' ? v.contract.slice(-1).replace('N', '') : null)).map((c) => {
    let cls = '';
    let attrs = '';
    if (selecting) { cls = `legal ${S.discardSel.has(c) ? 'sel' : ''} ${v.talon?.includes(c) ? 'from-talon' : ''}`; attrs = `data-pick="${c}"`; }
    else if (v.phase === 'play' && v.legal.playSeat === me) { cls = legal.has(c) ? 'legal' : 'dim'; if (legal.has(c)) attrs = `data-play="${c}"`; }
    return cardHtml(c, { cls, attrs });
  }).join('');
  const p = v.players[me];
  const discard = v.discard?.length && v.phase !== 'talon' ? ` · снос: ${v.discard.map((c) => `${c[0] === 'T' ? '10' : c[0]}${SUIT[c.slice(-1)]}`).join(' ')}` : '';
  return `<div class="table">
    <div class="opponents">${oppHtml(left)}${oppHtml(right)}</div>
    ${centerHtml()}
    <div class="actions">${autoPilot ? `<div class="msg">🤖 За вас играет ИИ</div><button class="btn" data-act="reclaim">Вернуть управление</button>` : actionsHtml()}</div>
    <div class="hand-wrap">
      <div class="me-bar ${turnSeat() === me ? 'turn' : ''}" data-seat-el="${me}">
        <div class="pl-head">${avatar(p)}<div><div class="pl-name">${esc(p.name)}${v.seat == null ? ' (вы зритель)' : ''}</div><div class="pl-sub">${playerTags(me)}${esc(discard)}</div></div></div>
        ${v.seat != null && !autoPilot && !['dealEnd', 'gameOver'].includes(v.phase) ? `<button class="btn small ghost" data-act="takeover" data-seat="${me}" title="ИИ доиграет за вас, пока вы не вернётесь">☕ Отойти</button>` : ''}
      </div>
      <div class="hand" id="hand">${handCards}</div>
    </div>
  </div>`;
}

function layoutHand() {
  const hand = $('#hand');
  if (!hand) return;
  const cards = hand.children;
  const n = cards.length;
  if (n < 2) return;
  const w = cards[0].getBoundingClientRect().width;
  const avail = hand.getBoundingClientRect().width;
  const step = Math.min(w + 4, (avail - w) / (n - 1));
  for (let i = 1; i < n; i++) cards[i].style.marginLeft = `${step - w}px`;
}
window.addEventListener('resize', layoutHand);

// Стол запоминается в адресе (переживает перезагрузку) и на устройстве.
// Хеш с данными Telegram (#tgWebAppData…) не трогаем.
function rememberTable(id) {
  if (id) store.set('tableId', id); else store.del('tableId');
  try {
    const u = new URL(location.href);
    if (id) u.searchParams.set('table', id); else u.searchParams.delete('table');
    history.replaceState(null, '', u.toString());
  } catch {}
}

// ---------- пулька ----------
// Кнопки внизу пульки: уйти в меню (партия останется) и досрочно закончить игру против ИИ
function tableMenuHtml() {
  if (!S.table) return '';
  const v = S.view;
  const me = S.table.seats.findIndex((s) => s?.id === S.me?.id);
  const solo = me !== -1 && S.table.seats.every((s, i) => i === me || s?.bot);
  const canFinish = solo && v && v.phase !== 'gameOver';
  return `<button class="btn ghost small" data-act="leave">🚪 В меню</button>
    ${canFinish ? `<button class="btn small ${S.confirmFinish ? 'danger' : 'ghost'}" data-act="finish">${S.confirmFinish ? 'Точно закончить?' : '🏳️ Закончить пулю'}</button>` : ''}`;
}

// Лист пульки как на бумаге: кружок с размером пули в центре, сектор каждого игрока
// у его края (я — снизу, партнёры — слева и справа). Снаружи висты, дальше пуля, у центра гора.
const fmtNum = (x) => String(Math.round(x * 100) / 100);
// Запись через точку «2.4.6.10»; если не влезает — оставляем хвост с «…», последнее число жирным.
// fresh — последнее число записано в последней раздаче: выделяем красным.
function seqSvg(vals, maxPx, fs, fresh = false) {
  if (!vals.length) return '';
  const parts = vals.map(fmtNum);
  const fits = (k) => (parts.slice(k).join('.').length + (k ? 1 : 0)) * fs * 0.56 <= maxPx;
  let k = 0;
  while (k < parts.length - 1 && !fits(k)) k++;
  const head = parts.slice(k, -1).join('.');
  return `${k ? '…' : ''}${head}${head ? '.' : ''}<tspan font-weight="700"${fresh ? ' class="fresh"' : ''}>${parts.at(-1)}</tspan>`;
}

function sheetSvg(v) {
  const W = 340, H = 420, cx = W / 2, cy = H / 2, B1 = 40, B2 = 78, M = 22;
  const me = v.seat ?? 0, L = (me + 1) % 3, R = (me + 2) % 3;
  const sc = v.score, tr = v.scoreTrail;
  // Старые партии без записей: показываем хотя бы текущее значение
  const seq = (kind, i, j) => {
    const t = j == null ? tr?.[kind]?.[i] : tr?.[kind]?.[i]?.[j];
    if (t?.length) return t;
    const cur = j == null ? sc[kind][i] : sc[kind][i][j];
    return cur ? [cur] : [];
  };
  const last = tr?.last;
  const fresh = (kind, i, j) => !!last && (j == null ? last[kind]?.includes(i) : last[kind]?.includes(`${i}-${j}`));
  const bal = v.final || v.balance;
  const name = (s) => `${esc(v.players[s].name)} <tspan class="${bal[s] >= 0 ? 'pos' : 'neg'}">${bal[s] > 0 ? '+' : ''}${fmtNum(bal[s])}</tspan>`;
  const txt = (x, y, rot, body, cls = 'ink', fs = 13) =>
    body ? `<text class="${cls}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" transform="translate(${x} ${y}) rotate(${rot})">${body}</text>` : '';
  // ширина нижней полосы между диагоналями на высоте y
  const span = (y) => 2 * ((cx * (y - cy)) / (H - cy));
  const out = [];
  // нижний — я
  out.push(txt(cx / 2 + 6, H - B1 / 2, 0, seqSvg(seq('whists', me, L), cx - 24, 13, fresh('whists', me, L))));
  out.push(txt(cx + cx / 2 - 6, H - B1 / 2, 0, seqSvg(seq('whists', me, R), cx - 24, 13, fresh('whists', me, R))));
  out.push(txt(cx, H - (B1 + B2) / 2, 0, seqSvg(seq('pool', me), span(H - B2) - 16, 14, fresh('pool', me))));
  out.push(txt(cx, H - B2 - 16, 0, seqSvg(seq('mountain', me), span(H - B2 - 30) - 16, 14, fresh('mountain', me))));
  // боковые: текст повёрнут к игроку (левый читает сверху вниз, правый — снизу вверх)
  for (const [s, other, side] of [[L, R, -1], [R, L, 1]]) {
    const X = (x) => (side < 0 ? x : W - x), rot = side < 0 ? 90 : -90;
    const len = (x) => cy + (cx - x) * ((H - cy) / cx) - B1; // вертикальная длина полосы до диагонали
    out.push(txt(X(B1 / 2), (B1 + cy + (cx - B1 / 2) * ((H - cy) / cx)) / 2, rot, seqSvg(seq('whists', s, me), len(B1 / 2) - 16, 13, fresh('whists', s, me))));
    out.push(txt(side < 0 ? (B1 + cx) / 2 : W - (B1 + cx) / 2, B1 / 2, 0, seqSvg(seq('whists', s, other), cx - B1 - 12, 12, fresh('whists', s, other))));
    out.push(txt(X((B1 + B2) / 2), (B1 + cy + (cx - (B1 + B2) / 2) * ((H - cy) / cx)) / 2, rot, seqSvg(seq('pool', s), len((B1 + B2) / 2) - 30, 14, fresh('pool', s))));
    out.push(txt(X(B2 + 16), (B2 + cy + (cx - B2 - 16) * ((H - cy) / cx)) / 2, rot, seqSvg(seq('mountain', s), len(B2 + 16) - 60, 14, fresh('mountain', s))));
  }
  const ln = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  return `<svg class="pulka" viewBox="${-M} ${-M} ${W + 2 * M} ${H + 2 * M}" role="img" aria-label="Лист пульки">
    <rect class="paper" x="0" y="0" width="${W}" height="${H}" rx="3"/>
    <g class="grid">
      <rect x="${B1}" y="${B1}" width="${W - 2 * B1}" height="${H - 2 * B1}" fill="none"/>
      <rect x="${B2}" y="${B2}" width="${W - 2 * B2}" height="${H - 2 * B2}" fill="none"/>
      ${ln(cx, 0, cx, cy)}${ln(0, H, cx, cy)}${ln(W, H, cx, cy)}
      ${ln(cx, H - B1, cx, H)}${ln(0, 0, B1, B1)}${ln(W, 0, W - B1, B1)}
    </g>
    <circle class="paper grid" cx="${cx}" cy="${cy}" r="26"/>
    <text class="ink" x="${cx}" y="${cy}" font-size="18" font-weight="700" text-anchor="middle" dominant-baseline="central">${v.config.poolTarget}</text>
    ${out.join('')}
    ${txt(cx, H + M / 2 + 1, 0, name(me), 'nm', 13)}
    ${txt(-M / 2, cy, 90, name(L), 'nm', 13)}
    ${txt(W + M / 2, cy, -90, name(R), 'nm', 13)}
  </svg>`;
}

function renderScore() {
  const v = S.view;
  if (!v) { $('#score-body').innerHTML = '<div class="hint">Партия ещё не началась</div>'; return; }
  const hist = [...v.history].reverse().map((h) => `<div><b>№${h.dealNo} ${esc(h.title)}</b> — ${esc(h.lines.join('; '))}</div>`).join('');
  $('#score-body').innerHTML = `<div class="hint">Пуля до ${v.config.poolTarget} · выход с распасов: ${RASPAS_EXIT[v.config.raspasExit] || '6'} · цена на распасах: ${RASPAS_PRICE[v.config.raspasPrices] || '1, 1, 1…'}${v.config.stalingrad ? ' · Сталинград' : ''}${v.raspasStreak ? ` · распасов подряд: ${v.raspasStreak}, следующие — по ${v.raspasPrice}` : ''}</div>
    ${sheetSvg(v)}
    <div class="hint">Снаружи — висты (каждая половина — на соседа с той стороны), дальше пуля, у кружка — гора. Красным — записи последней раздачи.
      Число у имени — ${v.final ? 'итог в вистах' : 'сколько выиграл бы, если расписать сейчас'}.</div>
    <div class="history">${hist}</div>
    <div class="row" style="margin-top:12px">${tableMenuHtml()}</div>`;
}

// ---------- статистика игроков ----------
const signed = (x) => `<b class="${x >= 0 ? 'pos' : 'neg'}">${x > 0 ? '+' : ''}${Math.round(x * 100) / 100}</b>`;

function statsRow(p, rank) {
  const mine = p.id === S.me?.id;
  return `<tr class="${mine ? 'me' : ''}"><td>${rank ? `${rank}. ` : ''}${esc(p.name)}${mine ? ' (вы)' : ''}</td>
    <td>${p.finished}</td><td>${p.unfinished}${p.finishRate != null && p.unfinished ? ` <small>(${100 - p.finishRate}%)</small>` : ''}</td><td>${signed(p.whists)}</td></tr>`;
}

function renderStats() {
  const body = $('#stats-body');
  if (!S.stats) { body.innerHTML = '<div class="hint">Загрузка…</div>'; return; }
  const head = '<tr><th></th><th>Доиграно</th><th>Брошено</th><th>Висты</th></tr>';
  const title = S.tableId ? 'За этим столом' : 'Ваша статистика';
  const top = S.stats.top.length
    ? `<table class="sheet-table">${head}${S.stats.top.map((p, i) => statsRow(p, i + 1)).join('')}</table>`
    : '<div class="hint">Пока никто не доиграл ни одной пули.</div>';
  body.innerHTML = `<div class="stats-sec">${title}</div>
    <div style="overflow-x:auto"><table class="sheet-table">${head}${S.stats.table.map((p) => statsRow(p)).join('')}</table></div>
    <div class="stats-sec">🏆 Рейтинг по вистам</div>
    <div style="overflow-x:auto">${top}</div>
    <div class="hint" style="margin-top:8px">Пуля — одна игра до закрытия. «Брошено» — закончил досрочно, ушёл и за него доиграл ИИ, или пуля простояла больше суток. Висты — сумма итогов всех пуль: выигрыш прибавляется, проигрыш вычитается. Боты в статистику не входят.</div>`;
}

// ---------- чат ----------
function renderBadge() {
  const b = $('#chat-badge');
  b.hidden = !S.unread;
  b.textContent = S.unread;
}
function renderChat() {
  renderBadge();
  const list = $('#chat-list');
  list.innerHTML = S.chat.map((m) => {
    if (m.system) return `<div class="cmsg sys">${esc(m.text)}</div>`;
    const mine = m.fromId === S.me?.id;
    return `<div class="cmsg ${mine ? 'mine' : ''}">${mine ? '' : `<div class="who">${esc(m.from)}${m.viaTelegram ? ' ✈' : ''}</div>`}${esc(m.text)}</div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}
$('#emote-bar').innerHTML = EMOTES.map((e) => `<button data-emote="${e}">${e}</button>`).join('');

function showEmote(fromId, e) {
  const seat = S.view?.players.findIndex((p) => p.id === fromId);
  const el = seat != null && seat >= 0 ? document.querySelector(`[data-seat-el="${seat}"]`) : null;
  const target = el || $('#screen');
  const r = target.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'emote-float';
  f.textContent = e;
  f.style.left = `${r.left + Math.min(r.width / 2, 60)}px`;
  f.style.top = `${r.top + 10}px`;
  f.style.position = 'fixed';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 2300);
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
  tg?.HapticFeedback?.notificationOccurred('error');
}

// ---------- события ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-play],[data-pick],[data-emote],[data-close]');
  if (!el) return;
  if (el.dataset.close != null) { el.closest('.sheet').hidden = true; return; }
  if (el.dataset.emote) { send({ t: 'emote', e: el.dataset.emote }); return; }
  if (el.dataset.play) { tg?.HapticFeedback?.impactOccurred('light'); send({ t: 'act', action: { type: 'play', card: el.dataset.play } }); return; }
  if (el.dataset.pick) {
    const c = el.dataset.pick;
    if (S.discardSel.has(c)) S.discardSel.delete(c);
    else if (S.discardSel.size < 2) S.discardSel.add(c);
    render();
    return;
  }
  const d = el.dataset;
  switch (d.act) {
    case 'create': S.noResume = false; send({ t: 'create' }); break;
    case 'sit': send({ t: 'sit', seat: Number(d.seat) }); break;
    case 'stand': send({ t: 'stand' }); break;
    case 'pool': S.poolTarget = Number(d.n); store.set('poolTarget', d.n); render(); break;
    case 'stal': S.stalingrad = d.v === '1'; store.set('stalingrad', d.v); render(); break;
    case 'rexit':
      S.raspasExit = d.k; store.set('raspasExit', d.k);
      S.raspasPrices = PRICE_FOR_EXIT[d.k]; store.set('raspasPrices', S.raspasPrices);
      render();
      break;
    case 'rprice': S.raspasPrices = d.k; store.set('raspasPrices', d.k); render(); break;
    case 'start': send({ t: 'start', config: poolConfig() }); break;
    case 'level': S.aiLevel = d.l; store.set('aiLevel', d.l); render(); break;
    case 'solo': S.noResume = false; send({ t: 'create', bots: S.aiLevel, config: poolConfig() }); break;
    case 'resume':
      S.noResume = false;
      send({ t: 'hello', initData: tg?.initData || '', dev: DEV_NAME, lastTableId: store.get('tableId') });
      break;
    case 'leave':
      // из идущей партии — не возвращать автоматически, пока сам не выберет; после конца пули возвращаться некуда
      S.noResume = !!S.view && S.view.phase !== 'gameOver';
      S.table = null; S.view = null; S.chat = [];
      rememberTable(null);
      $('#score-panel').hidden = true;
      send({ t: 'leave' });
      render();
      break;
    case 'finish':
      if (!S.confirmFinish) { S.confirmFinish = true; renderScore(); break; }
      S.confirmFinish = false;
      $('#score-panel').hidden = true;
      send({ t: 'finish' });
      break;
    case 'addBot': send({ t: 'addBot', seat: Number(d.seat), level: S.aiLevel }); break;
    case 'removeBot': send({ t: 'removeBot', seat: Number(d.seat) }); break;
    case 'fillBots': send({ t: 'fillBots', level: S.aiLevel, config: poolConfig() }); break;
    case 'takeover': send({ t: 'takeover', seat: Number(d.seat), level: S.aiLevel }); break;
    case 'reclaim': send({ t: 'reclaim' }); break;
    case 'bid': send({ t: 'act', action: { type: 'bid', bid: d.b } }); break;
    case 'contract': S.contractSel = d.b; render(); break;
    case 'discard': {
      const contract = S.view.legal.contracts[0] === 'MIS' ? 'MIS' : S.contractSel;
      send({ t: 'act', action: { type: 'discard', cards: [...S.discardSel], contract } });
      break;
    }
    case 'whist': send({ t: 'act', action: { type: 'whist', choice: d.c } }); break;
    case 'wmode': send({ t: 'act', action: { type: 'whistMode', open: d.open === '1' } }); break;
    case 'next': send({ t: 'act', action: { type: 'nextDeal' } }); break;
    case 'takeRest':
      if (!S.confirmRest) { S.confirmRest = true; render(); setTimeout(() => { S.confirmRest = false; render(); }, 4000); break; }
      S.confirmRest = false;
      send({ t: 'act', action: { type: 'takeRest' } });
      break;
    case 'peek': S.peekLast = !S.peekLast; S.peekTalon = false; render(); break;
    case 'peekTalon': S.peekTalon = !S.peekTalon; S.peekLast = false; render(); break;
    case 'catch': send({ t: 'act', action: { type: 'catch', take: d.take === '1' } }); break;
    case 'w3':
      if (!S.confirmW3) { S.confirmW3 = true; render(); break; }
      S.confirmW3 = false;
      send({ t: 'act', action: { type: 'withoutThree' } });
      break;
    case 'propose': S.proposeSel = defaultProposal(S.view); render(); break;
    case 'psel': S.proposeSel = Number(d.n); render(); break;
    case 'pcancel': S.proposeSel = null; render(); break;
    case 'psend': send({ t: 'act', action: { type: 'propose', declTricks: S.proposeSel } }); S.proposeSel = null; break;
    case 'answer': send({ t: 'act', action: { type: 'answerProposal', accept: d.a === '1' } }); break;
    case 'unpropose': send({ t: 'act', action: { type: 'cancelProposal' } }); break;
    case 'invite': {
      const url = `https://t.me/share/url?url=${encodeURIComponent(S.link)}&text=${encodeURIComponent('Садись за пулю!')}`;
      tg ? tg.openTelegramLink(url) : window.open(url);
      break;
    }
  }
});

$('#btn-chat').onclick = () => { $('#score-panel').hidden = true; const p = $('#chat-panel'); p.hidden = !p.hidden; S.unread = 0; renderChat(); };
$('#btn-score').onclick = () => { $('#chat-panel').hidden = true; $('#stats-panel').hidden = true; const p = $('#score-panel'); p.hidden = !p.hidden; renderScore(); };
$('#btn-stats').onclick = () => {
  $('#chat-panel').hidden = true; $('#score-panel').hidden = true;
  const p = $('#stats-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) { renderStats(); send({ t: 'stats' }); }
};
const openGroup = (e) => { e?.preventDefault(); if (S.table?.chatLink) tg ? tg.openTelegramLink(S.table.chatLink) : window.open(S.table.chatLink); };
$('#btn-group').onclick = openGroup;
$('#call-join').onclick = openGroup;
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const i = $('#chat-input');
  if (i.value.trim()) send({ t: 'chat', text: i.value });
  i.value = '';
};

render();
connect();
