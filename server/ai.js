// ИИ-игроки для «Сочинки». Бот видит только то, что видел бы человек на его месте:
// свою руку, открытые карты, прикуп (если открыт), вышедшие карты и выявленные «ренонсы».
import { SUITS, RANKS, BIDS, bidIndex, bidLevel, bidTrump } from './rules.js';
import { legalBids, legalContracts, legalWhist, misereOpen, newDeck, proposalPending } from './engine.js';

export const AI_LEVELS = {
  novice: { label: 'Новичок', samples: 6, noise: 1.6, randomPlay: 0.4, memory: false, mc: 0, misereSlack: 2 },
  amateur: { label: 'Любитель', samples: 10, noise: 0.8, randomPlay: 0.08, memory: false, mc: 0, misereSlack: 1 },
  pro: { label: 'Профи', samples: 24, noise: 0.25, randomPlay: 0, memory: true, mc: 0, misereSlack: 1 },
  master: { label: 'Мастер', samples: 40, noise: 0, randomPlay: 0, memory: true, mc: 36, misereSlack: 1 },
};
export const AI_NAMES = ['Кузьмич', 'Люба', 'Сан Саныч', 'Гоша', 'Зина', 'Федя', 'Маруся', 'Палыч'];

const next = (s) => (s + 1) % 3;
const suitOf = (c) => c.slice(-1);
const rankOf = (c) => RANKS.indexOf(c[0]);
const byRankAsc = (a, b) => rankOf(a) - rankOf(b);
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const DECK = newDeck();

function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Быстрый симулятор розыгрыша ----------

function teamFor(kind, declarer) {
  if (kind === 'raspas') return [0, 1, 2];
  return [0, 1, 2].map((s) => (s === declarer ? 0 : 1));
}

function simLegal(sim, seat) {
  const hand = sim.hands[seat];
  if (!sim.leadSuit) return hand;
  const follow = hand.filter((c) => suitOf(c) === sim.leadSuit);
  if (follow.length) return follow;
  if (sim.trump) {
    const tr = hand.filter((c) => suitOf(c) === sim.trump);
    if (tr.length) return tr;
  }
  return hand;
}

function trickWinner(sim) {
  let best = null;
  for (const t of sim.trick) {
    const s = suitOf(t.card);
    if (s !== sim.leadSuit && s !== sim.trump) continue;
    if (!best || beats(t.card, best.card, sim)) best = t;
  }
  return best;
}

function beats(card, other, sim) {
  const a = suitOf(card);
  const b = suitOf(other);
  if (a === b) return rankOf(card) > rankOf(other);
  return a === sim.trump;
}

function simPlay(sim, card) {
  const seat = sim.turn;
  sim.hands[seat] = sim.hands[seat].filter((c) => c !== card);
  if (!sim.leadSuit) sim.leadSuit = suitOf(card);
  sim.trick.push({ seat, card });
  sim.played.add(card);
  if (sim.trick.length < 3) { sim.turn = next(seat); return; }
  const w = trickWinner(sim);
  if (w) { sim.tricks[w.seat] += 1; sim.leader = w.seat; }
  sim.trickNo += 1;
  sim.trick = [];
  sim.leadSuit = sim.kind === 'raspas' && sim.trickNo < sim.talonLeads.length ? suitOf(sim.talonLeads[sim.trickNo]) : null;
  sim.turn = sim.leader;
}

function playout(sim, lvl, rng) {
  while (sim.hands[sim.turn].length) simPlay(sim, policy(sim, sim.turn, lvl, rng));
  return sim.tricks;
}

function newSim({ hands, kind, trump, declarer, leader, talonLeads = [], played = [] }) {
  return {
    hands: hands.map((h) => [...h]), kind, trump: trump || null, declarer, leader, turn: leader,
    trick: [], leadSuit: kind === 'raspas' && talonLeads.length ? suitOf(talonLeads[0]) : null,
    tricks: [0, 0, 0], trickNo: 0, played: new Set(played), talonLeads, team: teamFor(kind, declarer),
  };
}

function cloneSim(sim, hands) {
  return {
    ...sim, hands: hands.map((h) => [...h]), trick: sim.trick.map((t) => ({ ...t })),
    tricks: [...sim.tricks], played: new Set(sim.played),
  };
}

// ---------- Эвристика хода (используется и в симуляциях, и ботами) ----------

// Сколько карт этой масти старше card может быть у соперников
function higherOut(sim, seat, card, memory) {
  const s = suitOf(card);
  const r = rankOf(card);
  let n = 0;
  for (let i = r + 1; i < RANKS.length; i++) {
    const c = RANKS[i] + s;
    if (sim.hands[seat].includes(c)) continue;
    if (memory && sim.played.has(c)) continue;
    n++;
  }
  return n;
}
function lowerOut(sim, seat, card, memory) {
  const s = suitOf(card);
  let n = 0;
  for (let i = 0; i < rankOf(card); i++) {
    const c = RANKS[i] + s;
    if (sim.hands[seat].includes(c) || (memory && sim.played.has(c))) continue;
    n++;
  }
  return n;
}
const lowest = (cards) => [...cards].sort(byRankAsc)[0];
const highest = (cards) => [...cards].sort(byRankAsc).at(-1);

function policy(sim, seat, lvl, rng) {
  const legal = simLegal(sim, seat);
  if (legal.length === 1) return legal[0];
  if (lvl.randomPlay && rng() < lvl.randomPlay) return pick(legal, rng);
  if (sim.kind === 'raspas' || (sim.kind === 'misere' && seat === sim.declarer)) return avoidPolicy(sim, seat, legal, lvl.memory);
  if (sim.kind === 'misere') return catchPolicy(sim, seat, legal);
  return gamePolicy(sim, seat, legal, lvl.memory);
}

function gamePolicy(sim, seat, legal, memory) {
  const master = (c) => higherOut(sim, seat, c, memory) === 0;
  // «дешёвая» карта: не козырь, не старшая, младшая
  const cheapest = (cards) => [...cards].sort((a, b) => {
    const va = (suitOf(a) === sim.trump ? 100 : 0) + (master(a) ? 50 : 0) + rankOf(a);
    const vb = (suitOf(b) === sim.trump ? 100 : 0) + (master(b) ? 50 : 0) + rankOf(b);
    return va - vb;
  })[0];

  if (!sim.trick.length) {
    const hand = sim.hands[seat];
    if (seat === sim.declarer && sim.trump) {
      const tr = legal.filter((c) => suitOf(c) === sim.trump);
      const outTrumps = RANKS.some((r) => !hand.includes(r + sim.trump) && !sim.played.has(r + sim.trump));
      const top = tr.filter(master);
      if (tr.length && outTrumps && top.length) return highest(top); // выбиваем козыри
    }
    const winners = legal.filter((c) => master(c) && suitOf(c) !== sim.trump);
    if (winners.length) return highest(winners);
    const bySuit = {};
    for (const c of legal) if (suitOf(c) !== sim.trump) (bySuit[suitOf(c)] ||= []).push(c);
    const suits = Object.values(bySuit).sort((a, b) => b.length - a.length);
    if (suits.length) return lowest(suits[0]);
    return lowest(legal);
  }

  const win = trickWinner(sim);
  const last = sim.trick.length === 2;
  const partnerWins = win && sim.team[win.seat] === sim.team[seat];
  if (partnerWins && (last || higherOut(sim, seat, win.card, memory) === 0)) return cheapest(legal);
  const winners = win ? legal.filter((c) => beats(c, win.card, sim)) : legal;
  if (!winners.length) return cheapest(legal);
  if (last) return lowest(winners.filter((c) => suitOf(c) !== sim.trump).length ? winners.filter((c) => suitOf(c) !== sim.trump) : winners);
  if (partnerWins || sim.team[next(seat)] === sim.team[seat]) return cheapest(legal); // напарник ещё сыграет
  const safe = winners.filter((c) => master(c) || (suitOf(c) === sim.trump && sim.leadSuit !== sim.trump));
  return safe.length ? lowest(safe) : cheapest(legal);
}

// Распасы и мизер: не брать
function avoidPolicy(sim, seat, legal, memory) {
  if (!sim.trick.length && !sim.leadSuit) {
    // заходим картой, которую наверняка перебьют
    return [...legal].sort((a, b) => higherOut(sim, seat, b, memory) - higherOut(sim, seat, a, memory) || byRankAsc(a, b))[0];
  }
  const win = trickWinner(sim);
  const following = legal.some((c) => suitOf(c) === sim.leadSuit);
  if (following) {
    const under = win ? legal.filter((c) => !beats(c, win.card, sim)) : [];
    if (under.length) return highest(under);
    return sim.trick.length === 2 ? highest(legal) : lowest(legal);
  }
  // своей масти нет — сбрасываем самую опасную карту
  return [...legal].sort((a, b) => (rankOf(b) - lowerOut(sim, seat, b, memory)) - (rankOf(a) - lowerOut(sim, seat, a, memory)) || byRankAsc(b, a))[0];
}

// Ловля мизера
function catchPolicy(sim, seat, legal) {
  const d = sim.declarer;
  if (!sim.trick.length) return lowest(legal);
  const win = trickWinner(sim);
  const declPlayed = sim.trick.some((t) => t.seat === d);
  const following = legal.some((c) => suitOf(c) === sim.leadSuit);
  if (!following) return highest(legal);
  if (declPlayed && win?.seat === d) {
    const under = legal.filter((c) => !beats(c, win.card, sim));
    return under.length ? highest(under) : lowest(legal);
  }
  return lowest(legal);
}

// ---------- Оценка руки ----------

// Какие 2 карты снести при игре с козырем trump (null — БК)
function chooseDiscard(hand12, trump) {
  const bySuit = {};
  for (const c of hand12) (bySuit[suitOf(c)] ||= []).push(c);
  const value = (c) => {
    const s = suitOf(c);
    const cards = [...bySuit[s]].sort((a, b) => rankOf(b) - rankOf(a));
    const pos = cards.indexOf(c);
    const len = cards.length;
    if (trump && s === trump) return 100 + rankOf(c);
    if (rankOf(c) === RANKS.length - 1 - pos) return 50 + rankOf(c); // старшая последовательность от туза
    if (c[0] === 'K' && len >= 2) return 30;
    if (c[0] === 'Q' && len >= 3) return 25;
    return rankOf(c) + len * (trump ? 1 : 3);
  };
  const sorted = [...hand12].sort((a, b) => value(a) - value(b));
  return { discard: sorted.slice(0, 2), keep: sorted.slice(2) };
}

// Опасность карты на мизере: в масти 7-9-В каждая следующая карта «прикрыта» младшими
function misereDangers(hand) {
  const bySuit = {};
  for (const c of hand) (bySuit[suitOf(c)] ||= []).push(c);
  const res = [];
  for (const cards of Object.values(bySuit)) {
    cards.sort(byRankAsc).forEach((c, i) => res.push({ c, d: Math.max(0, rankOf(c) - 2 * i) }));
  }
  return res.sort((a, b) => b.d - a.d || rankOf(b.c) - rankOf(a.c));
}
function misereDiscard(hand12) {
  let h = [...hand12];
  const out = [];
  for (let k = 0; k < 2; k++) {
    const worst = misereDangers(h)[0].c;
    out.push(worst);
    h = h.filter((c) => c !== worst);
  }
  return { discard: out, keep: h };
}
const dangerSum = (hand) => misereDangers(hand).reduce((s, x) => s + x.d, 0);

// Распределение взяток играющего с козырем trump, если он возьмёт прикуп
function estimateGame(hand10, seat, firstLead, trump, samples, rng) {
  const unknown = DECK.filter((c) => !hand10.includes(c));
  const pro = AI_LEVELS.pro;
  const out = [];
  for (let i = 0; i < samples; i++) {
    const u = shuffled(unknown, rng);
    const { keep } = chooseDiscard([...hand10, u[0], u[1]], trump);
    const hands = [];
    hands[seat] = keep; hands[next(seat)] = u.slice(2, 12); hands[next(next(seat))] = u.slice(12, 22);
    const sim = newSim({ hands, kind: 'game', trump, declarer: seat, leader: firstLead });
    out.push(playout(sim, pro, rng)[seat]);
  }
  return out;
}

function estimateMisere(hand10, seat, firstLead, samples, rng) {
  const unknown = DECK.filter((c) => !hand10.includes(c));
  let clean = 0;
  for (let i = 0; i < samples; i++) {
    const u = shuffled(unknown, rng);
    const { keep } = misereDiscard([...hand10, u[0], u[1]]);
    const hands = [];
    hands[seat] = keep; hands[next(seat)] = u.slice(2, 12); hands[next(next(seat))] = u.slice(12, 22);
    const sim = newSim({ hands, kind: 'misere', declarer: seat, leader: firstLead });
    if (playout(sim, AI_LEVELS.pro, rng)[seat] === 0) clean++;
  }
  return clean / samples;
}

const probAtLeast = (dist, n) => dist.filter((t) => t >= n).length / dist.length;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const gauss = (rng) => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());

// ---------- Торговля ----------

const bidCache = new Map(); // оценка руки один раз на раздачу

function handPlan(state, seat, lvl, rng) {
  const key = `${state.dealNo}:${seat}:${state.hands[seat].join('')}`;
  if (bidCache.has(key)) return bidCache.get(key);
  const hand = state.hands[seat];
  const firstLead = next(state.dealer);
  const shift = lvl.noise ? gauss(rng) * lvl.noise : 0; // новичок пере- или недооценивает руку
  let maxBid = null;
  for (const t of [...SUITS, 'N']) {
    const dist = estimateGame(hand, seat, firstLead, t === 'N' ? null : t, lvl.samples, rng).map((x) => x + shift);
    for (let L = 10; L >= 6; L--) {
      if (probAtLeast(dist, L) >= 0.62) {
        const b = `${L}${t}`;
        if (!maxBid || bidIndex(b) > bidIndex(maxBid)) maxBid = b;
        break;
      }
    }
  }
  // мизер: сначала грубое правило «опасных» карт, затем (у сильных) проверка симуляцией
  const dangers = misereDangers(hand);
  const rest = dangers.slice(lvl.misereSlack).reduce((s, x) => s + x.d, 0);
  let misere = rest === 0;
  if (misere && lvl.mc + lvl.samples >= 24) misere = estimateMisere(hand, seat, firstLead, lvl.samples, rng) >= 0.8;
  const plan = { maxBid, misere };
  bidCache.set(key, plan);
  if (bidCache.size > 500) bidCache.delete(bidCache.keys().next().value);
  return plan;
}

function decideBid(state, seat, lvl, rng) {
  const legal = legalBids(state, seat);
  const plan = handPlan(state, seat, lvl, rng);
  if (plan.misere && legal.includes('MIS')) return 'MIS';
  const nextBid = legal.find((b) => b !== 'PASS' && b !== 'MIS');
  if (plan.maxBid && nextBid && bidIndex(nextBid) <= bidIndex(plan.maxBid)) return nextBid;
  return 'PASS';
}

// ---------- Снос и заказ ----------

function decideDiscard(state, seat, lvl, rng) {
  const hand = state.hands[seat];
  const contracts = legalContracts(state);
  if (contracts[0] === 'MIS') return { type: 'discard', cards: misereDiscard(hand).discard, contract: 'MIS' };
  const minBid = state.bidding.highest.bid;
  const firstLead = next(state.dealer);
  let best = null;
  for (const t of [...SUITS, 'N']) {
    const trump = t === 'N' ? null : t;
    const L0 = [6, 7, 8, 9, 10].find((L) => bidIndex(`${L}${t}`) >= bidIndex(minBid));
    if (!L0) continue;
    const { keep, discard } = chooseDiscard(hand, trump);
    // известная рука из 10 карт, прикупа больше нет — оцениваем раскладом остальных 22 карт
    const unknown = DECK.filter((c) => !hand.includes(c));
    const dist = [];
    for (let i = 0; i < lvl.samples; i++) {
      const u = shuffled(unknown, rng);
      const hands = [];
      hands[seat] = keep; hands[next(seat)] = u.slice(0, 10); hands[next(next(seat))] = u.slice(10, 20);
      dist.push(playout(newSim({ hands, kind: 'game', trump, declarer: seat, leader: firstLead }), AI_LEVELS.pro, rng)[seat]);
    }
    const score = mean(dist) - L0 + (lvl.noise ? gauss(rng) * lvl.noise * 0.5 : 0);
    let L = L0;
    while (L < 10 && probAtLeast(dist, L + 1) >= 0.8 && lvl.memory) L++; // сильные повышают заказ, если уверены
    if (!best || score > best.score) best = { score, contract: `${L}${t}`, discard, expect: mean(dist), L0 };
  }
  // безнадёжно (ждём недобор больше трёх) — опытные сдаются «без трёх»
  if (lvl.memory && state.config.allowWithoutThree !== false && best.expect <= best.L0 - 4) return { type: 'withoutThree' };
  return { type: 'discard', cards: best.discard, contract: best.contract };
}

// ---------- Вист ----------

function defenseDist(state, seat, lvl, rng) {
  const d = state.declarer;
  const trump = bidTrump(state.contract) === 'N' ? null : bidTrump(state.contract);
  const mine = state.hands[seat];
  const unknown = DECK.filter((c) => !mine.includes(c) && !state.talon.includes(c));
  const other = [0, 1, 2].find((s) => s !== d && s !== seat);
  const res = [];
  for (let i = 0; i < lvl.samples; i++) {
    const u = shuffled(unknown, rng);
    const hands = [];
    hands[seat] = mine;
    hands[d] = chooseDiscard([...state.talon, ...u.slice(0, 10)], trump).keep;
    hands[other] = u.slice(10, 20);
    const t = playout(newSim({ hands, kind: 'game', trump, declarer: d, leader: next(state.dealer) }), AI_LEVELS.pro, rng);
    res.push({ mine: t[seat], team: t[seat] + t[other] });
  }
  return res;
}

function decideWhist(state, seat, lvl, rng) {
  const legal = legalWhist(state, seat);
  const level = bidLevel(state.contract);
  const v = state.config.gameValue[level];
  const O = state.config.whistObligation[level];
  if (O === 0) return 'WHIST'; // на десятерной вист бесплатный
  const w = state.whist;
  const partnerWhists = Object.entries(w.answers).some(([s, a]) => Number(s) !== seat && a === 'WHIST') && w.halfBy == null;
  const K = 20 / 3; // очко горы ≈ 6,7 виста
  const dist = defenseDist(state, seat, lvl, rng);
  const ev = partnerWhists
    ? mean(dist.map((x) => v * x.mine - (x.mine < O / 2 ? v * (O / 2 - x.mine) * K : 0)))
    : mean(dist.map((x) => v * x.team - (x.team < O ? v * (O - x.team) * K : 0)));
  const noisy = ev + (lvl.noise ? gauss(rng) * lvl.noise * v * 2 : 0);
  if (legal.includes('HALF') && noisy < v * (O / 2)) return 'HALF';
  return noisy > 0 ? 'WHIST' : 'PASS';
}

// ---------- Розыгрыш ----------

function playSim(state) {
  const p = state.play;
  const played = [];
  for (const t of p.history) for (const x of t.cards) played.push(x.card);
  for (const x of p.trick) played.push(x.card);
  return {
    hands: state.hands, kind: p.kind, trump: p.trump, declarer: state.declarer, leader: p.leader, turn: p.turn,
    trick: p.trick.map((t) => ({ ...t })), leadSuit: p.leadSuit, tricks: [...p.tricks], trickNo: p.trickNo,
    played: new Set(played), talonLeads: p.kind === 'raspas' && state.config.raspasTalonLeads ? state.talon : [],
    team: teamFor(p.kind, state.declarer),
  };
}

// «Ренонсы»: кто точно не имеет какой масти
function knownVoids(state) {
  const p = state.play;
  const voids = [new Set(), new Set(), new Set()];
  const tricks = [...p.history, { cards: p.trick, leadSuit: p.leadSuit }];
  for (const t of tricks) {
    for (const { seat, card } of t.cards) {
      if (!t.leadSuit || suitOf(card) === t.leadSuit) continue;
      voids[seat].add(t.leadSuit);
      if (p.trump && suitOf(card) !== p.trump) voids[seat].add(p.trump);
    }
  }
  return voids;
}

// Случайный расклад скрытых карт, не противоречащий тому, что видит actor
function sampleHands(state, actor, rng) {
  const p = state.play;
  const controlled = [0, 1, 2].filter((s) => p.controller[s] === actor);
  const visible = new Set([actor, ...controlled, ...p.open, ...(p.proposal ? [p.proposal.by] : [])]);
  const played = new Set();
  for (const t of p.history) for (const x of t.cards) played.add(x.card);
  for (const x of p.trick) played.add(x.card);
  const known = new Set(played);
  for (const s of visible) for (const c of state.hands[s]) known.add(c);
  if (p.kind === 'raspas') for (const c of state.talon) known.add(c);
  const hasDiscard = p.kind !== 'raspas';
  const discardKnown = hasDiscard && (actor === state.declarer || (p.kind === 'misere' && misereOpen(state)));
  if (discardKnown) for (const c of state.discard) known.add(c);
  const talonSet = new Set(p.kind !== 'raspas' ? state.talon : []);
  const unknown = DECK.filter((c) => !known.has(c));
  const locs = [0, 1, 2].filter((s) => !visible.has(s)).map((s) => ({ seat: s, cap: state.hands[s].length }));
  if (hasDiscard && !discardKnown) locs.push({ seat: 'discard', cap: 2 });
  const voids = knownVoids(state);

  for (let attempt = 0; attempt < 40; attempt++) {
    const relax = attempt >= 30;
    const cap = locs.map((l) => l.cap);
    const got = locs.map(() => []);
    // сначала карты прикупа — они могут быть только у играющего или в сносе
    const order = shuffled(unknown, rng).sort((a, b) => talonSet.has(b) - talonSet.has(a));
    let ok = true;
    for (const c of order) {
      const cand = locs.map((l, i) => i).filter((i) => cap[i] > 0
        && (locs[i].seat === 'discard' || relax || !voids[locs[i].seat].has(suitOf(c)))
        && (!talonSet.has(c) || locs[i].seat === 'discard' || locs[i].seat === state.declarer));
      if (!cand.length) { ok = false; break; }
      let r = rng() * cand.reduce((s, i) => s + cap[i], 0);
      let chosen = cand[0];
      for (const i of cand) { r -= cap[i]; if (r <= 0) { chosen = i; break; } }
      got[chosen].push(c);
      cap[chosen]--;
    }
    if (!ok) continue;
    const hands = state.hands.map((h, s) => (visible.has(s) ? [...h] : null));
    locs.forEach((l, i) => { if (l.seat !== 'discard') hands[l.seat] = got[i]; });
    return hands;
  }
  return state.hands.map((h) => [...h]); // не должно случаться; на крайний случай
}

function objective(state, tricks, actor) {
  const p = state.play;
  const d = state.declarer;
  if (p.kind === 'raspas') return -tricks[actor] + (tricks[actor] === 0 ? 1 : 0);
  if (p.kind === 'misere') {
    const s = tricks[d] === 0 ? 10 : -tricks[d] * 2;
    return actor === d ? s : -s;
  }
  const need = bidLevel(state.contract);
  const made = tricks[d] >= need;
  return actor === d ? tricks[d] + (made ? 5 : 0) : 10 - tricks[d] + (made ? 0 : 5);
}

function decidePlay(state, actor, lvl, rng) {
  const p = state.play;
  const base = playSim(state);
  const legal = simLegal(base, p.turn);
  if (legal.length === 1) return legal[0];
  if (!lvl.mc) return policy(base, p.turn, lvl, rng);

  // Мастер: перебор ходов на случайных, но согласованных с игрой раскладах
  const worlds = Array.from({ length: lvl.mc }, () => sampleHands(state, actor, rng));
  let best = null;
  for (const card of legal) {
    let total = 0;
    for (const hands of worlds) {
      const sim = cloneSim(base, hands);
      simPlay(sim, card);
      total += objective(state, playout(sim, AI_LEVELS.pro, rng), actor);
    }
    if (!best || total > best.total) best = { card, total };
  }
  return best.card;
}

// Кто ловит мизер: бот берётся ловить, если у него много мелочи (ею удобно «подлезать» под играющего).
// Второй, если первый отказался, ловит всегда (иначе ловить всё равно первому).
function decideCatch(state, seat, lvl, rng) {
  if (state.catch.order[1] === seat) return true;
  if (lvl.randomPlay && rng() < lvl.randomPlay) return rng() < 0.5;
  const low = state.hands[seat].filter((c) => rankOf(c) <= 2).length; // 7, 8, 9
  return low >= 4;
}

// ---------- Точка входа ----------

// Ответ на «Предложить»: доигрываем возможные расклады и сравниваем с предложенным итогом
function decideProposal(state, seat, lvl, rng) {
  const p = state.play;
  const pr = p.proposal;
  const proposed = objective(state, [0, 1, 2].map((s) => p.tricks[s] + pr.tricks[s]), seat);
  const base = playSim(state);
  const n = Math.max(lvl.mc, 16);
  let total = 0;
  for (let i = 0; i < n; i++) total += objective(state, playout(cloneSim(base, sampleHands(state, seat, rng)), AI_LEVELS.pro, rng), seat);
  const noise = lvl.noise ? gauss(rng) * lvl.noise : 0;
  return proposed + noise >= total / n - 0.25;
}

export function decide(state, seat, levelKey, rng = Math.random) {
  const lvl = AI_LEVELS[levelKey] || AI_LEVELS.amateur;
  if (proposalPending(state).includes(seat)) return { type: 'answerProposal', accept: decideProposal(state, seat, lvl, rng) };
  switch (state.phase) {
    case 'bidding': return { type: 'bid', bid: decideBid(state, seat, lvl, rng) };
    case 'talon': return decideDiscard(state, seat, lvl, rng);
    case 'whisting': return { type: 'whist', choice: decideWhist(state, seat, lvl, rng) };
    case 'whistMode': return { type: 'whistMode', open: levelKey === 'novice' ? rng() < 0.5 : true };
    case 'misereCatch': return { type: 'catch', take: decideCatch(state, seat, lvl, rng) };
    case 'play': return { type: 'play', card: decidePlay(state, seat, lvl, rng) };
    default: return null;
  }
}

// Чей сейчас ход (место, которое должно действовать), или null
// Все места, от которых сейчас ждут действия (на предложение отвечают сразу несколько)
export function actingSeats(state) {
  const pending = proposalPending(state);
  if (pending.length) return pending;
  const s = actorSeat(state);
  return s == null ? [] : [s];
}

export function actorSeat(state) {
  switch (state?.phase) {
    case 'bidding': return state.bidding.turn;
    case 'talon': return state.declarer;
    case 'whisting':
    case 'whistMode': return state.whist.turn;
    case 'misereCatch': return state.catch.turn;
    case 'play': return state.play.controller[state.play.turn];
    default: return null;
  }
}
