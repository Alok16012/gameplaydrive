// Cards and Teen Patti hand ranking (same rules as the app's lib/hands.ts and the old SQL tp_score).

export const SUITS = ["♠", "♥", "♦", "♣"] as const;
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export interface Card { r: string; s: string }

export function deck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const HIGH: Record<string, number> = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, J: 11, Q: 12, K: 13, A: 14 };

/** Compare scores lexicographically; higher wins. */
export function compare(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const TP_NAMES = ["", "High Card", "Pair", "Color", "Sequence", "Pure Sequence", "Trail"];

/** Trail > Pure Sequence > Sequence > Color > Pair > High Card. A-2-3 ranks just below A-K-Q. */
export function tpScore(cards: Card[]): number[] {
  const v = cards.map((c) => HIGH[c.r]).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  let seq = v[0] - v[1] === 1 && v[1] - v[2] === 1;
  let top = v;
  if (!seq && v[0] === 14 && v[1] === 3 && v[2] === 2) { seq = true; top = [13.5, 0, 0]; }
  if (v[0] === v[1] && v[1] === v[2]) return [6, ...v];
  if (seq && flush) return [5, ...top];
  if (seq) return [4, ...top];
  if (flush) return [3, ...v];
  if (v[0] === v[1] || v[1] === v[2]) {
    const pair = v[1];
    const kicker = v[0] === v[1] ? v[2] : v[0];
    return [2, pair, kicker];
  }
  return [1, ...v];
}

export const tpHandName = (cards: Card[]) => TP_NAMES[tpScore(cards)[0]];
