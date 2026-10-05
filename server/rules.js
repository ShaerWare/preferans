// Правила «Сочинки». Всё спорное вынесено в конфиг, чтобы можно было подстроить под свою компанию.

export const SUITS = ['S', 'C', 'D', 'H']; // ♠ ♣ ♦ ♥ — порядок старшинства в торговле
export const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUIT_SYMBOL = { S: '♠', C: '♣', D: '♦', H: '♥', N: 'БК' };

// Лестница заявок: 6♠ … 8БК, мизер, 9♠ … 10БК
export const BIDS = [];
for (const lvl of [6, 7, 8, 9, 10]) {
  if (lvl === 9) BIDS.push('MIS');
  for (const s of [...SUITS, 'N']) BIDS.push(`${lvl}${s}`);
}
export const bidIndex = (b) => BIDS.indexOf(b);
export const bidLevel = (b) => (b === 'MIS' ? null : parseInt(b, 10));
export const bidTrump = (b) => (b === 'MIS' ? null : b.slice(-1)); // 'N' = без козыря

export const DEFAULT_CONFIG = {
  poolTarget: 20, // размер пули на каждого
  gameValue: { 6: 2, 7: 4, 8: 6, 9: 8, 10: 10, MIS: 10 },
  // сколько взяток обязаны взять вистующие (в сумме)
  whistObligation: { 6: 4, 7: 2, 8: 1, 9: 1, 10: 0 },
  halfWhistLevels: [6, 7], // «уйти за полвиста» — по своду правил на шестерной и семерной
  responsibleWhist: true, // Сочи: недобор виста — стоимость игры в гору за каждую взятку
  // Цена взятки на распасах по кругам (распасы подряд): '1' — 1,1,1…; '12' — 1,2,2…; '124' — 1,2,4…
  raspasPrices: '1',
  raspasZeroBonus: 1, // в пулю за «чистый» распас (ноль взяток); на одинарных распасах — по выходу, см. raspasZeroBonusFor
  raspasTalonLeads: true, // первые две взятки на распасах — в масть карт прикупа
  // «Без трёх»: играющий, увидев прикуп, сдаётся. Ему — гора 3×стоимость, каждому противнику —
  // висты за «без трёх» (3×стоимость) и за свою половину взяток защиты (10 − (заказ − 3)) / 2.
  allowWithoutThree: true,
  // Выход с распасов — с какой игры начинается торговля после распасов подряд:
  //   '6'     — без ограничений
  //   '7'     — после распасов с 7♠
  //   'prog9' — прогрессия: 1-е распасы → с 7, 2-е → с 8, дальше → с 9
  //   'prog8' — прогрессия: 1-е распасы → с 7, со 2-х и дальше → с 8
  // Мизер разрешён всегда.
  raspasExit: '6',
  // «Сталинград» (обязон): на 6♠ вистуют оба обязательно, в закрытую; за недовист отвечают как обычно
  stalingrad: false,
  // Мизер в открытую: ловящие (и зрители) видят все 12 карт мизериста — руку, сыгранные и снос
  misereOpen: true,
  whistPointsPerPool: 10, // перевод пули/горы в висты при расчёте
};

export const RASPAS_EXIT = {
  6: { label: '6', steps: [6] },
  7: { label: '7', steps: [6, 7] },
  prog9: { label: '7 → 8 → 9', steps: [6, 7, 8, 9] },
  prog8: { label: '7 → 8 → 8', steps: [6, 7, 8] },
};

// С какого уровня можно торговаться после streak распасов подряд
export const RASPAS_PRICE = {
  1: { label: '1, 1, 1…', steps: [1] },
  12: { label: '1, 2, 2…', steps: [1, 2] },
  124: { label: '1, 2, 4…', steps: [1, 2, 4] },
};

// Цена взятки на распасах, если перед ними было streak распасов подряд
export function raspasPriceFor(cfg, streak) {
  const steps = RASPAS_PRICE[cfg.raspasPrices]?.steps || [cfg.raspasPrice || 1]; // старые пули: raspasPrice
  return steps[Math.min(streak, steps.length - 1)];
}

// В пулю за распас без взяток. На одинарных распасах (1, 1, 1…) — по текущему выходу:
// с 6 → 1, с 7 → 2, с 8 и выше → 4. При растущей цене взятки — всегда raspasZeroBonus.
const ZERO_BONUS_BY_EXIT = { 6: 1, 7: 2, 8: 4 };
export function raspasZeroBonusFor(cfg, streak) {
  if (!cfg.raspasZeroBonus) return 0;
  if ((cfg.raspasPrices || '1') !== '1') return cfg.raspasZeroBonus;
  return ZERO_BONUS_BY_EXIT[Math.min(minBidLevel(cfg.raspasExit, streak), 8)];
}

export function minBidLevel(exit, streak) {
  const steps = (RASPAS_EXIT[exit] || RASPAS_EXIT[6]).steps;
  return steps[Math.min(streak, steps.length - 1)];
}

export const bidLabel = (b) => {
  if (b === 'PASS') return 'пас';
  if (b === 'MIS') return 'мизер';
  return `${bidLevel(b)}${SUIT_SYMBOL[bidTrump(b)]}`;
};
