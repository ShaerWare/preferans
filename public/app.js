// Клиент Mini App: рисует стол по состоянию с сервера и шлёт действия.
const tg = window.Telegram?.WebApp;
const qs = new URLSearchParams(location.search);
const DEV_NAME = qs.get('dev');

const SUIT = { S: '♠', C: '♣', D: '♦', H: '♥', N: 'БК' };
const RED = new Set(['D', 'H']);
const RANK_ORDER = '789TJQKA';
const HAND_SUIT_ORDER = ['S', 'D', 'C', 'H']; // чередуем цвета
const EMOTES = ['👍', '😂', '🔥', '😱', '🤬', '🤔', '👏', '🍺'];
const WHIST_LABEL = { WHIST: 'вист', PASS: 'пас', HALF: 'полвиста' };
const AI_LABEL = { novice: 'Новичок', amateur: 'Любитель', pro: 'Профи', master: 'Мастер' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  ws: null, me: null, tableId: qs.get('table') || tg?.initDataUnsafe?.start_param || null,
  table: null, view: null, link: null, chat: [], unread: 0,
  discardSel: new Set(), contractSel: null, poolTarget: Number(store.get('poolTarget')) || 20, raspasExit: store.get('raspasExit') || '6', aiLevel: store.get('aiLevel') || 'pro',
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
  ws.onopen = () => send({ t: 'hello', initData: tg?.initData || '', dev: DEV_NAME, tableId: S.tableId });
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}
function send(obj) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(obj)); }

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      S.me = m.me;
      S.tableId = m.tableId;
      if (DEV_NAME && m.tableId) history.replaceState(null, '', `?dev=${encodeURIComponent(DEV_NAME)}&table=${m.tableId}`);
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
  }
}

function onState(m) {
  const prev = S.view;
  S.table = m.table; S.view = m.view; S.link = m.link;
  const v = S.view;
  if (v?.phase !== S.lastPhase) { S.discardSel.clear(); S.contractSel = null; S.confirmW3 = false; S.lastPhase = v?.phase; }
  if (!v?.legal?.propose) S.proposeDraft = null;
  // показать закрытую взятку ещё немного
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
  return l.bids.length > 0 || l.contracts.length > 0 || l.whist.length > 0 || l.whistMode || l.playSeat != null;
}

// ---------- карты ----------
function cardHtml(c, { cls = '', attrs = '' } = {}) {
  const r = c[0] === 'T' ? '10' : c[0];
  const s = c.slice(-1);
  return `<div class="card ${RED.has(s) ? 'red' : ''} ${cls}" data-card="${c}" ${attrs}><span class="r">${r}</span><span class="s">${SUIT[s]}</span><span class="big">${SUIT[s]}</span></div>`;
}
function sortHand(h, trump) {
  const order = trump ? [trump, ...HAND_SUIT_ORDER.filter((s) => s !== trump)] : HAND_SUIT_ORDER;
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
  if (!S.view) { scr.innerHTML = lobbyHtml(); return; }
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
const poolConfig = () => ({ poolTarget: S.poolTarget, raspasExit: S.raspasExit });

function settingsHtml() {
  const pool = [10, 20, 30].map((n) => `<button data-act="pool" data-n="${n}" class="${S.poolTarget === n ? 'on' : ''}">${n}</button>`).join('');
  const exit = Object.entries(RASPAS_EXIT).map(([k, l]) => `<button data-act="rexit" data-k="${k}" class="${S.raspasExit === k ? 'on' : ''}">${l}</button>`).join('');
  return `<div>Пуля до: <span class="seg">${pool}</span></div>
    <div>Выход с распасов:</div><span class="seg">${exit}</span>
    <div class="hint">${RASPAS_EXIT_HINT[S.raspasExit]} Мизер можно всегда.</div>`;
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
  if (v.play) tags.push(`<span class="tag">взяток: ${v.play.tricks[s]}</span>`);
  return tags.join('');
}

function oppHtml(s) {
  const v = S.view;
  const p = v.players[s];
  const side = rel(s);
  const hand = v.hands[s];
  const clickable = v.legal.playSeat === s ? new Set(v.legal.cards) : null;
  let cards;
  if (hand) {
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
  if (v.play?.kind === 'raspas') info = 'Распасы — берите поменьше';
  else if (v.contract === 'MIS') info = `${esc(v.players[v.declarer].name)} играет мизер`;
  else if (v.contract && v.play) {
    const ws = v.whist.whisters.map((s) => esc(v.players[s].name)).join(' и ');
    info = `${esc(v.players[v.declarer].name)}: ${bidHtml(v.contract)} · вист: ${ws}${v.whist.whisters.length === 1 ? (v.whist.open ? ' (в открытую)' : ' (в закрытую)') : ''}`;
  } else if (v.phase === 'bidding') info = `Раздача №${v.dealNo} · торговля${v.minLevel > 6 ? ` с ${v.minLevel}♠ (выход с распасов)` : ''}`;

  let inner = '';
  if (v.phase === 'bidding') {
    inner = `<div><div class="talon-label">прикуп</div><div class="talon"><div class="card mini" style="background:repeating-linear-gradient(45deg,#8b1e2b 0 3px,#a8283a 3px 6px)"></div><div class="card mini" style="background:repeating-linear-gradient(45deg,#8b1e2b 0 3px,#a8283a 3px 6px)"></div></div></div>`;
  } else if (v.phase === 'talon' || v.phase === 'whisting' || v.phase === 'whistMode' || (v.phase === 'dealEnd' && !v.play)) {
    inner = v.talon ? `<div><div class="talon-label">прикуп</div><div class="talon">${v.talon.map((c) => cardHtml(c)).join('')}</div></div>` : '';
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
  return `<div class="center"><div class="contract-info">${info}</div>${inner}</div>`;
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
      return `<div class="msg">Выберите 2 карты в снос${mis ? '' : ' и игру'}</div>
        ${mis ? '' : bidGrid(l.contracts, 'contract', S.contractSel)}
        <div class="row"><button class="btn" data-act="discard" ${ready ? '' : 'disabled'}>Снести и заказать${mis ? ' мизер' : S.contractSel ? ' ' + bidHtml(S.contractSel) : ''}</button>
        ${l.withoutThree ? `<button class="btn ${S.confirmW3 ? 'danger' : 'ghost'}" data-act="w3">${S.confirmW3 ? 'Точно без трёх?' : '🏳️ Без трёх'}</button>` : ''}</div>
        ${S.confirmW3 ? `<div class="hint">Сдаётесь без розыгрыша: гора ${3 * gameValue(v.bidding.highest.bid)}, противникам — висты. Нажмите ещё раз для подтверждения.</div>` : ''}`;
    }
    case 'whisting':
      if (!l.whist.length) return wait(`<b>${name(t)}</b> решает: вист или пас`);
      return `<div class="msg">${name(v.declarer)} играет <b>${bidHtml(v.contract)}</b>${v.whist.halfBy != null ? ` · ${name(v.whist.halfBy)} сказал полвиста` : ''}</div>
        <div class="row">${l.whist.map((c) => `<button class="btn ${c === 'PASS' ? 'ghost' : ''}" data-act="whist" data-c="${c}">${WHIST_LABEL[c]}</button>`).join('')}</div>`;
    case 'whistMode':
      if (!l.whistMode) return wait(`<b>${name(t)}</b> выбирает, как вистовать`);
      return `<div class="msg">Вистуете один. Как играем?</div>
        <div class="row"><button class="btn" data-act="wmode" data-open="1">В открытую</button><button class="btn ghost" data-act="wmode" data-open="0">В закрытую</button></div>`;
    case 'play': {
      const pr = v.play.proposal;
      if (pr) {
        const list = v.players.map((p, s) => `${name(s)} <b>+${pr.tricks[s]}</b>`).join(' · ');
        const head = `<div class="msg">🤝 ${pr.by === v.seat ? 'Вы предлагаете' : `<b>${name(pr.by)}</b> предлагает (карты открыты)`}:<br>${list}</div>`;
        if (l.answerProposal) return head + '<div class="row"><button class="btn" data-act="answer" data-a="1">✅ Согласен</button><button class="btn ghost" data-act="answer" data-a="0">❌ Играем</button></div>';
        if (pr.by === v.seat) return head + '<div class="msg hint">Ждём ответа…</div><button class="btn small ghost" data-act="unpropose">Отозвать</button>';
        return head + '<div class="msg hint">Ждём остальных…</div>';
      }
      if (S.proposeDraft) return proposeHtml();
      const turn = l.playSeat == null ? `Ходит <b>${name(v.play.turn)}</b>` : l.playSeat === v.seat ? '<b>Ваш ход</b>' : `<b>Ходите за ${name(l.playSeat)}</b>`;
      return `<div class="row" style="align-items:center"><div class="msg">${turn}</div>${l.propose ? '<button class="btn small ghost" data-act="propose">🤝 Предложить</button>' : ''}</div>`;
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

// Редактор предложения: сколько из оставшихся взяток получит каждый
function proposeHtml() {
  const v = S.view;
  const d = S.proposeDraft;
  // пока набирали, кто-то доиграл взятку — начинаем заново
  if (d.reduce((a, b) => a + b, 0) > v.play.remaining) { d.fill(0); d[v.seat] = v.play.remaining; }
  const left = v.play.remaining - d.reduce((a, b) => a + b, 0);
  const rows = v.players.map((p, s) => `<div class="prop-row"><span>${esc(p.name)}${s === v.seat ? ' (вы)' : ''}</span>
    <button class="btn small ghost" data-act="pstep" data-s="${s}" data-d="-1" ${d[s] ? '' : 'disabled'}>−</button>
    <b>${d[s]}</b>
    <button class="btn small ghost" data-act="pstep" data-s="${s}" data-d="1" ${left ? '' : 'disabled'}>+</button></div>`).join('');
  return `<div class="msg">🤝 Как разойтись по оставшимся <b>${v.play.remaining}</b> взяткам?</div>${rows}
    <div class="hint">${left ? `Осталось распределить: ${left}` : 'Ваши карты откроются остальным, пока они решают.'}</div>
    <div class="row"><button class="btn" data-act="psend" ${left ? 'disabled' : ''}>Предложить</button><button class="btn ghost" data-act="pcancel">Отмена</button></div>`;
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

function tableHtml() {
  const v = S.view;
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
    if (selecting) { cls = `legal ${S.discardSel.has(c) ? 'sel' : ''}`; attrs = `data-pick="${c}"`; }
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

// ---------- пулька ----------
function renderScore() {
  const v = S.view;
  if (!v) { $('#score-body').innerHTML = '<div class="hint">Партия ещё не началась</div>'; return; }
  const sc = v.score;
  const names = v.players.map((p) => esc(p.name));
  const bal = v.final || v.balance;
  const whistCols = [0, 1, 2].map((j) => `<th>вист на ${names[j]}</th>`).join('');
  const rows = [0, 1, 2].map((i) => `<tr><td><b>${names[i]}</b></td><td>${sc.pool[i]}/${v.config.poolTarget}</td><td>${sc.mountain[i]}</td>
    ${[0, 1, 2].map((j) => `<td>${i === j ? '—' : sc.whists[i][j]}</td>`).join('')}
    <td class="${bal[i] >= 0 ? 'pos' : 'neg'}"><b>${bal[i] > 0 ? '+' : ''}${bal[i]}</b></td></tr>`).join('');
  const hist = [...v.history].reverse().map((h) => `<div><b>№${h.dealNo} ${esc(h.title)}</b> — ${esc(h.lines.join('; '))}</div>`).join('');
  $('#score-body').innerHTML = `<div style="overflow-x:auto"><table class="sheet-table">
    <tr><td colspan="9" class="hint" style="text-align:left">Пуля до ${v.config.poolTarget} · выход с распасов: ${RASPAS_EXIT[v.config.raspasExit] || '6'}${v.raspasStreak ? ` · распасов подряд: ${v.raspasStreak}` : ''}</td></tr>
    <tr><th></th><th>Пуля</th><th>Гора</th>${whistCols}<th>${v.final ? 'Итог' : 'Сейчас'}</th></tr>${rows}</table></div>
    <div class="hint" style="margin-top:6px">«Сейчас» — сколько вистов каждый выиграл бы, если расписать прямо сейчас.</div>
    <div class="history">${hist}</div>`;
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
    case 'create': send({ t: 'create' }); break;
    case 'sit': send({ t: 'sit', seat: Number(d.seat) }); break;
    case 'stand': send({ t: 'stand' }); break;
    case 'pool': S.poolTarget = Number(d.n); store.set('poolTarget', d.n); render(); break;
    case 'rexit': S.raspasExit = d.k; store.set('raspasExit', d.k); render(); break;
    case 'start': send({ t: 'start', config: poolConfig() }); break;
    case 'level': S.aiLevel = d.l; store.set('aiLevel', d.l); render(); break;
    case 'solo': send({ t: 'create', bots: S.aiLevel, config: poolConfig() }); break;
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
    case 'w3':
      if (!S.confirmW3) { S.confirmW3 = true; render(); break; }
      S.confirmW3 = false;
      send({ t: 'act', action: { type: 'withoutThree' } });
      break;
    case 'propose': {
      // по умолчанию все оставшиеся взятки — себе, дальше подвинуть кнопками
      const draft = [0, 0, 0];
      draft[S.view.seat] = S.view.play.remaining;
      S.proposeDraft = draft;
      render();
      break;
    }
    case 'pstep': S.proposeDraft[Number(d.s)] += Number(d.d); render(); break;
    case 'pcancel': S.proposeDraft = null; render(); break;
    case 'psend': send({ t: 'act', action: { type: 'propose', tricks: S.proposeDraft } }); S.proposeDraft = null; break;
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
$('#btn-score').onclick = () => { $('#chat-panel').hidden = true; const p = $('#score-panel'); p.hidden = !p.hidden; renderScore(); };
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
