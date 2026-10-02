// Игровой движок преферанса «Сочинка» на троих. Чистая логика без сети:
// createGame → act(state, seat, action) → viewFor(state, seat).
import {
  SUITS, RANKS, BIDS, SUIT_SYMBOL, DEFAULT_CONFIG,
  bidIndex, bidLevel, bidTrump, bidLabel, minBidLevel,
} from './rules.js';

export class GameError extends Error {}

const next = (s) => (s + 1) % 3;
const suitOf = (c) => c.slice(-1);
const rankOf = (c) => RANKS.indexOf(c.slice(0, -1));
export const cardLabel = (c) => `${c[0] === 'T' ? '10' : c[0]}${SUIT_SYMBOL[suitOf(c)]}`;

export function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createGame({ players, config = {}, dealer = 0, rng }) {
  if (players.length !== 3) throw new GameError('Нужно ровно 3 игрока');
  const state = {
    config: { ...DEFAULT_CONFIG, ...config },
    players: players.map((p) => ({ id: p.id, name: p.name })),
    dealer: dealer - 1, // startDeal сдвинет на следующего
    dealNo: 0,
    score: {
      pool: [0, 0, 0],
      mountain: [0, 0, 0],
      whists: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], // whists[i][j] — висты i на j
    },
    history: [],
    raspasStreak: 0, // сколько распасов подряд — для «выхода с распасов»
    log: [],
  };
  startDeal(state, rng);
  return state;
}

function say(state, text) {
  state.log.push(text);
  if (state.log.length > 200) state.log.shift();
  state._events.push(text);
}

export function startDeal(state, rng) {
  state._events = state._events || [];
  state.dealer = next(state.dealer);
  state.dealNo += 1;
  const deck = shuffle(newDeck(), rng);
  state.hands = [deck.slice(0, 10), deck.slice(10, 20), deck.slice(20, 30)];
  state.talon = deck.slice(30);
  state.talonOpen = false;
  state.discard = [];
  state.declarer = null;
  state.contract = null;
  state.whist = null;
  state.play = null;
  state.lastResult = null;
  state.phase = 'bidding';
  const first = next(state.dealer);
  state.bidding = {
    turn: first,
    passed: [false, false, false],
    hasBid: [false, false, false],
    highest: null,
    log: [],
  };
  say(state, `Раздача №${state.dealNo}. Сдаёт ${state.players[state.dealer].name}, первый ход у ${state.players[first].name}.`);
  const min = minLevel(state);
  if (min > 6) say(state, `Выход с распасов: торгуемся с ${min}♠ (мизер можно).`);
}

// ---------- Торговля ----------

export const minLevel = (state) => minBidLevel(state.config.raspasExit, state.raspasStreak || 0);

export function legalBids(state, seat) {
  const b = state.bidding;
  if (state.phase !== 'bidding' || b.turn !== seat) return [];
  const res = ['PASS'];
  const hi = b.highest ? bidIndex(b.highest.bid) : -1;
  const min = minLevel(state);
  for (const bid of BIDS) {
    const i = bidIndex(bid);
    if (i <= hi) continue;
    if (bid !== 'MIS' && bidLevel(bid) < min) continue; // выход с распасов
    if (bid === 'MIS' && b.hasBid[seat]) continue; // мизер — только первым словом
    res.push(bid);
  }
  return res;
}

function nextBidder(state, from) {
  const b = state.bidding;
  let s = from;
  for (let k = 0; k < 3; k++) {
    s = next(s);
    if (b.passed[s]) continue;
    if (b.highest && b.highest.bid === 'MIS' && b.highest.seat === s) continue; // мизерист «стоит»
    return s;
  }
  return null;
}

function doBid(state, seat, bid) {
  const b = state.bidding;
  if (!legalBids(state, seat).includes(bid)) throw new GameError('Недопустимая заявка');
  b.log.push({ seat, bid });
  say(state, `${state.players[seat].name}: ${bidLabel(bid)}`);
  if (bid === 'PASS') {
    b.passed[seat] = true;
  } else {
    // перебили мизер — мизерист выбывает
    if (b.highest && b.highest.bid === 'MIS') b.passed[b.highest.seat] = true;
    b.highest = { seat, bid };
    b.hasBid[seat] = true;
  }
  const active = [0, 1, 2].filter((s) => !b.passed[s]);
  if (active.length === 0) return startRaspas(state);
  if (b.highest && active.length === 1 && active[0] === b.highest.seat) return winBidding(state);
  b.turn = nextBidder(state, seat);
}

function winBidding(state) {
  const { seat, bid } = state.bidding.highest;
  state.declarer = seat;
  state.bidding.turn = null;
  state.talonOpen = true;
  state.hands[seat] = [...state.hands[seat], ...state.talon];
  state.phase = 'talon';
  say(state, `Торговлю выиграл ${state.players[seat].name} (${bidLabel(bid)}). Прикуп: ${state.talon.map(cardLabel).join(' ')}.`);
}

// ---------- Прикуп, снос и объявление игры ----------

export function legalContracts(state) {
  const bid = state.bidding.highest.bid;
  if (bid === 'MIS') return ['MIS'];
  return BIDS.filter((b) => b !== 'MIS' && bidIndex(b) >= bidIndex(bid));
}

// «Без трёх»: после прикупа играющий отказывается от игры, которую выиграл в торговле
function doWithoutThree(state, seat) {
  if (state.phase !== 'talon' || seat !== state.declarer) throw new GameError('Сдаться может только играющий после прикупа');
  if (state.config.allowWithoutThree === false) throw new GameError('«Без трёх» отключено в правилах');
  const bid = state.bidding.highest.bid;
  if (bid === 'MIS') throw new GameError('Мизер не сдают «без трёх»');
  state.contract = bid;
  say(state, `${state.players[seat].name}: ${bidLabel(bid)} — без трёх.`);
  settle(state, { kind: 'w3' });
}

function doDiscard(state, seat, cards, contract) {
  if (seat !== state.declarer) throw new GameError('Сносит только играющий');
  if (!Array.isArray(cards) || cards.length !== 2 || cards[0] === cards[1]) throw new GameError('Нужно снести ровно 2 карты');
  const hand = state.hands[seat];
  if (!cards.every((c) => hand.includes(c))) throw new GameError('Таких карт нет на руке');
  if (!legalContracts(state).includes(contract)) throw new GameError('Нельзя заказать меньше, чем выиграно в торговле');
  state.hands[seat] = hand.filter((c) => !cards.includes(c));
  state.discard = cards;
  state.contract = contract;
  say(state, `${state.players[seat].name} заказал ${bidLabel(contract)}.`);
  if (contract === 'MIS') return startPlay(state, 'misere');
  const a = next(seat);
  state.whist = { order: [a, next(a)], answers: {}, turn: a, halfBy: null, whisters: [], open: null };
  state.phase = 'whisting';
}

// ---------- Вист ----------

export function legalWhist(state, seat) {
  const w = state.whist;
  if (state.phase !== 'whisting' || w.turn !== seat) return [];
  const [a, b] = w.order;
  const level = bidLevel(state.contract);
  if (seat === b && !w.halfBy && w.answers[a] === 'PASS' && state.config.halfWhistLevels.includes(level)) {
    return ['WHIST', 'PASS', 'HALF'];
  }
  return ['WHIST', 'PASS'];
}

const whistLabel = { WHIST: 'вист', PASS: 'пас', HALF: 'полвиста' };

function doWhist(state, seat, choice) {
  const w = state.whist;
  if (!legalWhist(state, seat).includes(choice)) throw new GameError('Недопустимый ответ');
  const [a, b] = w.order;
  say(state, `${state.players[seat].name}: ${whistLabel[choice]}`);

  if (w.halfBy != null) {
    // первый вистующий передумывает после «полвиста»
    if (choice === 'WHIST') {
      w.answers[a] = 'WHIST';
      w.answers[b] = 'PASS';
      w.halfBy = null;
      return resolveWhist(state);
    }
    return settle(state, { kind: 'half' });
  }

  w.answers[seat] = choice;
  if (seat === a) { w.turn = b; return; }
  if (choice === 'HALF') { w.halfBy = b; w.turn = a; return; }
  return resolveWhist(state);
}

function resolveWhist(state) {
  const w = state.whist;
  w.turn = null;
  w.whisters = w.order.filter((s) => w.answers[s] === 'WHIST');
  if (w.whisters.length === 0) return settle(state, { kind: 'nowhist' });
  if (w.whisters.length === 2) { w.open = false; return startPlay(state, 'game'); }
  state.phase = 'whistMode';
  w.turn = w.whisters[0];
}

function doWhistMode(state, seat, open) {
  const w = state.whist;
  if (state.phase !== 'whistMode' || w.turn !== seat) throw new GameError('Не ваш выбор');
  w.open = !!open;
  w.turn = null;
  say(state, `${state.players[seat].name} вистует ${open ? 'в открытую' : 'в закрытую'}.`);
  startPlay(state, 'game');
}

// ---------- Розыгрыш ----------

function startRaspas(state) {
  say(state, 'Все спасовали — распасы.');
  state.bidding.turn = null;
  state.talonOpen = state.config.raspasTalonLeads;
  startPlay(state, 'raspas');
}

function startPlay(state, kind) {
  const trump = kind === 'game' ? bidTrump(state.contract) : 'N';
  const controller = [0, 1, 2];
  const open = [];
  if (kind === 'game' && state.whist.whisters.length === 1 && state.whist.open) {
    const whister = state.whist.whisters[0];
    const passer = state.whist.order.find((s) => s !== whister);
    controller[passer] = whister;
    open.push(whister, passer);
  }
  state.play = {
    kind,
    trump: trump === 'N' ? null : trump,
    leader: next(state.dealer), // первый ход всегда у старшей руки
    turn: next(state.dealer),
    trick: [],
    leadSuit: null,
    lastTrick: null,
    history: [], // сыгранные взятки: { cards, leadSuit, winner }
    tricks: [0, 0, 0],
    trickNo: 0,
    open,
    controller,
  };
  state.phase = 'play';
  beginTrick(state);
}

function beginTrick(state) {
  const p = state.play;
  p.trick = [];
  p.leadSuit = null;
  p.turn = p.leader;
  if (p.kind === 'raspas' && state.config.raspasTalonLeads && p.trickNo < 2) {
    p.leadSuit = suitOf(state.talon[p.trickNo]);
  }
}

export function legalCards(state, seat) {
  const p = state.play;
  if (state.phase !== 'play' || p.turn !== seat) return [];
  const hand = state.hands[seat];
  if (!p.leadSuit) return [...hand];
  const follow = hand.filter((c) => suitOf(c) === p.leadSuit);
  if (follow.length) return follow;
  if (p.trump) {
    const trumps = hand.filter((c) => suitOf(c) === p.trump);
    if (trumps.length) return trumps;
  }
  return [...hand];
}

function trickWinner(p) {
  const best = (suit) => p.trick
    .filter((t) => suitOf(t.card) === suit)
    .sort((x, y) => rankOf(y.card) - rankOf(x.card))[0];
  const w = (p.trump && best(p.trump)) || best(p.leadSuit);
  return w ? w.seat : null; // null — на распасах никто не поддержал масть прикупа
}

function doPlay(state, userSeat, card) {
  const p = state.play;
  if (state.phase !== 'play') throw new GameError('Сейчас не розыгрыш');
  if (p.proposal) throw new GameError('Сначала ответьте на предложение');
  if (p.controller[p.turn] !== userSeat) throw new GameError('Не ваш ход');
  const seat = p.turn;
  if (!legalCards(state, seat).includes(card)) throw new GameError('Так ходить нельзя');
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  if (!p.leadSuit) p.leadSuit = suitOf(card);
  p.trick.push({ seat, card });
  if (p.trick.length < 3) { p.turn = next(seat); return; }

  const w = trickWinner(p);
  if (w != null) p.tricks[w] += 1;
  p.history.push({ cards: p.trick, leadSuit: p.leadSuit, winner: w });
  p.lastTrick = { cards: p.trick, winner: w, talonCard: p.kind === 'raspas' && p.trickNo < 2 && state.config.raspasTalonLeads ? state.talon[p.trickNo] : null };
  p.trickNo += 1;
  if (w != null) p.leader = w;
  // на мизере ловящие открывают карты после первого хода
  if (p.kind === 'misere' && p.trickNo === 1) {
    p.open = [0, 1, 2].filter((s) => s !== state.declarer);
  }
  if (p.trickNo === 10) return settle(state, { kind: p.kind });
  beginTrick(state);
}

// ---------- «Предложить»: договориться об оставшихся взятках ----------

export const remainingTricks = (state) => 10 - state.play.trickNo;

// Кто ещё должен ответить на предложение
export function proposalPending(state) {
  const pr = state?.phase === 'play' && state.play.proposal;
  if (!pr) return [];
  return [0, 1, 2].filter((s) => s !== pr.by && pr.answers[s] == null);
}

// Предлагают только итог играющего: сколько всего он возьмёт («своя игра», «без одной», …).
// Остальные взятки — защите: при двух вистующих поровну, лишняя тому, у кого пока меньше.
export function proposeOptions(state) {
  const p = state.play;
  if (state.phase !== 'play' || p.kind === 'raspas') return [];
  const have = p.tricks[state.declarer];
  return Array.from({ length: remainingTricks(state) + 1 }, (_, i) => have + i);
}

function doPropose(state, seat, declTotal) {
  const p = state.play;
  if (state.phase !== 'play') throw new GameError('Предлагать можно только во время розыгрыша');
  if (p.kind === 'raspas') throw new GameError('На распасах предлагать нечего');
  if (p.proposal) throw new GameError('Уже есть предложение');
  if (!proposeOptions(state).includes(declTotal)) throw new GameError('Столько взяток у играющего быть не может');
  const d = state.declarer;
  const tricks = [0, 0, 0];
  tricks[d] = declTotal - p.tricks[d];
  const def = remainingTricks(state) - tricks[d];
  const [x, y] = [next(d), next(next(d))];
  tricks[x] = tricks[y] = Math.floor(def / 2);
  if (def % 2) tricks[p.tricks[x] <= p.tricks[y] ? x : y] += 1;
  p.proposal = { by: seat, declTotal, tricks, answers: {} };
  say(state, `${state.players[seat].name} предлагает: ${proposalText(state, declTotal)}`);
}

export function proposalText(state, n) {
  const who = state.players[state.declarer].name;
  if (state.play.kind === 'misere') return n === 0 ? `${who} — чистый мизер` : `${who} берёт ${n}`;
  const L = bidLevel(state.contract);
  const what = n === L ? 'своя игра' : n < L ? `без ${L - n}` : `${n} (+${n - L})`;
  return `${who} берёт ${n} — ${what}`;
}

function doAnswerProposal(state, seat, accept) {
  const p = state.play;
  const pr = p?.proposal;
  if (!pr || !proposalPending(state).includes(seat)) throw new GameError('Нечего отвечать');
  say(state, `${state.players[seat].name}: ${accept ? 'согласен' : 'нет, играем'}`);
  if (!accept) { p.proposal = null; return; }
  pr.answers[seat] = true;
  if (proposalPending(state).length) return;
  // все согласны — дописываем взятки и считаем раздачу
  for (const s of [0, 1, 2]) p.tricks[s] += pr.tricks[s];
  p.trickNo = 10;
  p.trick = [];
  p.proposal = null;
  say(state, 'Предложение принято.');
  settle(state, { kind: p.kind });
}

function doCancelProposal(state, seat) {
  const pr = state.play?.proposal;
  if (!pr || pr.by !== seat) throw new GameError('Нечего отзывать');
  state.play.proposal = null;
  say(state, `${state.players[seat].name} отозвал предложение`);
}

// ---------- Подсчёт ----------

function addPool(state, seat, amount) {
  const sc = state.score;
  const T = state.config.poolTarget;
  const k = state.config.whistPointsPerPool;
  sc.pool[seat] += amount;
  let excess = sc.pool[seat] - T;
  if (excess <= 0) return;
  sc.pool[seat] = T;
  // излишек отдаём соседям по часовой, за помощь пишем висты
  for (const q of [next(seat), next(next(seat))]) {
    const give = Math.min(excess, T - sc.pool[q]);
    if (give > 0) {
      sc.pool[q] += give;
      sc.whists[seat][q] += give * k;
      excess -= give;
      say(state, `${state.players[seat].name} закрыл пулю и помог ${state.players[q].name} на ${give}.`);
    }
  }
  if (excess > 0) {
    const cut = Math.min(excess, sc.mountain[seat]);
    sc.mountain[seat] -= cut;
    excess -= cut;
  }
  if (excess > 0) {
    for (const q of [next(seat), next(next(seat))]) sc.whists[seat][q] += (excess * k) / 2;
  }
}

// Записи на листе, как ручкой на бумаге: каждое новое значение дописывается через точку.
// trail.pool[i], trail.mountain[i], trail.whists[i][j] — последовательности значений.
function scoreSnapshot(sc) {
  return JSON.stringify([sc.pool, sc.mountain, sc.whists]);
}
function recordTrail(state, before) {
  const sc = state.score;
  const [pool0, mountain0, whists0] = JSON.parse(before);
  const t = state.scoreTrail ||= {
    pool: [[], [], []], mountain: [[], [], []], whists: [0, 1, 2].map(() => [[], [], []]),
  };
  for (const i of [0, 1, 2]) {
    if (sc.pool[i] !== pool0[i]) t.pool[i].push(sc.pool[i]);
    if (sc.mountain[i] !== mountain0[i]) t.mountain[i].push(sc.mountain[i]);
    for (const j of [0, 1, 2]) if (sc.whists[i][j] !== whists0[i][j]) t.whists[i][j].push(sc.whists[i][j]);
  }
}

function settle(state, { kind }) {
  const before = scoreSnapshot(state.score);
  const sc = state.score;
  const cfg = state.config;
  const name = (s) => state.players[s].name;
  const lines = [];
  const tricks = state.play ? [...state.play.tricks] : null;
  const d = state.declarer;

  if (kind === 'raspas') {
    for (const s of [0, 1, 2]) {
      const t = tricks[s];
      if (t > 0) {
        sc.mountain[s] += t * cfg.raspasPrice;
        lines.push(`${name(s)}: ${t} взят. → гора +${t * cfg.raspasPrice}`);
      } else {
        if (cfg.raspasZeroBonus) addPool(state, s, cfg.raspasZeroBonus);
        lines.push(`${name(s)}: без взяток${cfg.raspasZeroBonus ? ` → пуля +${cfg.raspasZeroBonus}` : ''}`);
      }
    }
  } else if (kind === 'misere') {
    const v = cfg.gameValue.MIS;
    const t = tricks[d];
    if (t === 0) { addPool(state, d, v); lines.push(`${name(d)} сыграл мизер → пуля +${v}`); }
    else { sc.mountain[d] += v * t; lines.push(`${name(d)} поймали на мизере (${t}) → гора +${v * t}`); }
  } else if (kind === 'w3') {
    const level = bidLevel(state.contract);
    const v = cfg.gameValue[level];
    const each = (10 - (level - 3)) / 2; // защита как будто взяла остальное поровну
    sc.mountain[d] += 3 * v;
    lines.push(`${name(d)}: без трёх → гора +${3 * v}`);
    for (const s of [next(d), next(next(d))]) {
      sc.whists[s][d] += 3 * v + v * each;
      lines.push(`${name(s)} → висты +${3 * v + v * each}`);
    }
  } else {
    const level = bidLevel(state.contract);
    const v = cfg.gameValue[level];
    const O = cfg.whistObligation[level];
    const w = state.whist;
    const [a, b] = w.order;

    if (kind === 'nowhist') {
      addPool(state, d, v);
      lines.push(`Оба пас: ${name(d)} → пуля +${v}`);
    } else if (kind === 'half') {
      addPool(state, d, v);
      const wv = v * (O / 2);
      sc.whists[b][d] += wv;
      lines.push(`${name(d)} → пуля +${v}; ${name(b)} полвиста → висты +${wv}`);
    } else {
      const need = level;
      const got = tricks[d];
      if (got >= need) {
        addPool(state, d, v);
        lines.push(`${name(d)}: ${got} из ${need} — сыграл → пуля +${v}`);
      } else {
        const under = need - got;
        sc.mountain[d] += v * under;
        for (const s of [a, b]) sc.whists[s][d] += v * under;
        lines.push(`${name(d)}: без ${under} → гора +${v * under}, каждому по ${v * under} вистов`);
      }
      // висты за взятки
      if (w.whisters.length === 1) {
        const ws = w.whisters[0];
        const dt = tricks[a] + tricks[b];
        sc.whists[ws][d] += v * dt;
        lines.push(`${name(ws)} (вист): ${dt} взят. → висты +${v * dt}`);
        if (cfg.responsibleWhist && got >= need && dt < O) {
          const pen = (v / 2) * (O - dt);
          sc.mountain[ws] += pen;
          lines.push(`${name(ws)}: недовист ${O - dt} → гора +${pen}`);
        }
      } else {
        for (const s of [a, b]) {
          sc.whists[s][d] += v * tricks[s];
          lines.push(`${name(s)} (вист): ${tricks[s]} взят. → висты +${v * tricks[s]}`);
        }
        if (cfg.responsibleWhist && got >= need) {
          // каждый отвечает за свою половину; на 8–9 (обязательство 1) отвечает второй вистующий
          const own = O >= 2 ? [[a, O / 2], [b, O / 2]] : [[b, O]];
          for (const [s, need2] of own) {
            const sum = O >= 2 ? tricks[s] : tricks[a] + tricks[b];
            if (sum < need2) {
              const pen = (v / 2) * (need2 - sum);
              sc.mountain[s] += pen;
              lines.push(`${name(s)}: недовист ${need2 - sum} → гора +${pen}`);
            }
          }
        }
      }
    }
  }

  const title = kind === 'raspas' ? 'Распасы'
    : kind === 'misere' ? `Мизер — ${name(d)}`
    : kind === 'w3' ? `${bidLabel(state.contract)} без трёх — ${name(d)}`
    : `${bidLabel(state.contract)} — ${name(d)}`;
  recordTrail(state, before);
  state.lastResult = { title, lines, tricks };
  state.history.push({ dealNo: state.dealNo, title, lines });
  say(state, `${title}. ${lines.join('; ')}`);

  state.raspasStreak = kind === 'raspas' ? (state.raspasStreak || 0) + 1 : 0;

  if (sc.pool.every((p) => p >= cfg.poolTarget)) {
    state.phase = 'gameOver';
    state.final = finalBalance(state);
    say(state, 'Пуля закрыта! ' + state.final.map((x, s) => `${name(s)}: ${x > 0 ? '+' : ''}${x}`).join(', '));
  } else {
    state.phase = 'dealEnd';
  }
}

// Закончить пулю досрочно: расписываем по текущему счёту (недописанная пуля идёт в гору)
export function finishEarly(state) {
  if (state.phase === 'gameOver') throw new GameError('Пуля уже закрыта');
  state._events = [];
  state.phase = 'gameOver';
  state.final = finalBalance(state);
  say(state, 'Пуля закончена досрочно. ' + state.final.map((x, s) => `${state.players[s].name}: ${x > 0 ? '+' : ''}${x}`).join(', '));
  state._events = [];
}

// Итог в вистах: гора (и недописанная пуля) переводится в висты, затем сальдо по вистам.
export function finalBalance(state) {
  const { pool, mountain, whists } = state.score;
  const { poolTarget: T, whistPointsPerPool: k } = state.config;
  const m = [0, 1, 2].map((s) => mountain[s] + Math.max(0, T - pool[s]));
  const total = m[0] + m[1] + m[2];
  return [0, 1, 2].map((i) => {
    let bal = (k * (total - 3 * m[i])) / 3;
    for (const j of [0, 1, 2]) if (j !== i) bal += whists[i][j] - whists[j][i];
    return Math.round(bal * 100) / 100;
  });
}

// ---------- Точка входа ----------

export function act(state, seat, action) {
  state._events = [];
  switch (action?.type) {
    case 'bid':
      if (state.phase !== 'bidding') throw new GameError('Торговля закончена');
      doBid(state, seat, action.bid); break;
    case 'discard':
      if (state.phase !== 'talon') throw new GameError('Сейчас не снос');
      doDiscard(state, seat, action.cards, action.contract); break;
    case 'whist': doWhist(state, seat, action.choice); break;
    case 'whistMode': doWhistMode(state, seat, action.open); break;
    case 'play': doPlay(state, seat, action.card); break;
    case 'withoutThree': doWithoutThree(state, seat); break;
    case 'propose': doPropose(state, seat, Number(action.declTricks)); break;
    case 'answerProposal': doAnswerProposal(state, seat, !!action.accept); break;
    case 'cancelProposal': doCancelProposal(state, seat); break;
    case 'nextDeal':
      if (state.phase !== 'dealEnd') throw new GameError('Раздача ещё идёт');
      startDeal(state); break;
    default: throw new GameError('Неизвестное действие');
  }
  const ev = state._events;
  state._events = [];
  return ev;
}

// Что видит конкретный игрок (seat = null — зритель)
export function viewFor(state, seat) {
  const p = state.play;
  const openSeats = new Set(p ? p.open : []);
  if (p?.proposal) openSeats.add(p.proposal.by); // предлагая, игрок кладёт карты на стол
  const handVisible = (s) => s === seat || openSeats.has(s) || state.phase === 'dealEnd' || state.phase === 'gameOver';
  const controls = p ? [0, 1, 2].filter((s) => p.controller[s] === seat) : seat != null ? [seat] : [];
  const myTurnSeat = p && state.phase === 'play' && !p.proposal && p.controller[p.turn] === seat ? p.turn : null;
  return {
    phase: state.phase,
    seat,
    dealNo: state.dealNo,
    dealer: state.dealer,
    players: state.players,
    config: { poolTarget: state.config.poolTarget, raspasExit: state.config.raspasExit || '6' },
    minLevel: minLevel(state),
    raspasStreak: state.raspasStreak || 0,
    score: state.score,
    scoreTrail: state.scoreTrail || null,
    hands: [0, 1, 2].map((s) => (handVisible(s) ? state.hands[s] : null)),
    handCounts: state.hands.map((h) => h.length),
    talon: state.talonOpen ? state.talon : null,
    discard: seat != null && seat === state.declarer && state.phase !== 'bidding' ? state.discard : null,
    declarer: state.declarer,
    contract: state.contract,
    bidding: state.bidding && {
      turn: state.bidding.turn,
      passed: state.bidding.passed,
      highest: state.bidding.highest,
      log: state.bidding.log,
    },
    whist: state.whist && {
      order: state.whist.order, answers: state.whist.answers, turn: state.whist.turn,
      halfBy: state.whist.halfBy, whisters: state.whist.whisters, open: state.whist.open,
    },
    play: p && {
      kind: p.kind, trump: p.trump, turn: p.turn, trick: p.trick, leadSuit: p.leadSuit,
      lastTrick: p.lastTrick, tricks: p.tricks, trickNo: p.trickNo, open: p.open,
      talonLead: p.kind === 'raspas' && state.config.raspasTalonLeads && p.trickNo < 2 ? state.talon[p.trickNo] : null,
      proposal: p.proposal ? { ...p.proposal, text: proposalText(state, p.proposal.declTotal) } : null,
      remaining: 10 - p.trickNo,
    },
    legal: {
      bids: seat != null ? legalBids(state, seat) : [],
      contracts: state.phase === 'talon' && seat === state.declarer ? legalContracts(state) : [],
      whist: seat != null && state.phase === 'whisting' ? legalWhist(state, seat) : [],
      whistMode: state.phase === 'whistMode' && state.whist.turn === seat,
      cards: myTurnSeat != null ? legalCards(state, myTurnSeat) : [],
      playSeat: myTurnSeat,
      controls,
      withoutThree: state.phase === 'talon' && seat === state.declarer && state.config.allowWithoutThree !== false
        && state.bidding.highest.bid !== 'MIS',
      propose: seat != null && state.phase === 'play' && !p.proposal && p.kind !== 'raspas',
      proposeOptions: seat != null && state.phase === 'play' && !p.proposal ? proposeOptions(state) : [],
      answerProposal: seat != null && proposalPending(state).includes(seat),
    },
    lastResult: state.lastResult,
    history: state.history.slice(-30),
    final: state.final || null,
    balance: finalBalance(state), // «если бы расписали сейчас»
    log: state.log.slice(-40),
  };
}
