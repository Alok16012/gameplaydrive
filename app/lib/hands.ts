import type { Card, Rank } from "./data";

// Hand evaluators for the demo tables. Scores are arrays compared lexicographically (higher wins).

const HIGH: Record<Rank, number> = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, J: 11, Q: 12, K: 13, A: 14 };

export function compare(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// ---- Teen Patti: Trail > Pure Sequence > Sequence > Color > Pair > High Card ----
export const TP_NAMES = ["", "High Card", "Pair", "Color", "Sequence", "Pure Sequence", "Trail"];

export function teenPattiScore(cards: Card[]): number[] {
  const v = cards.map((c) => HIGH[c.r]).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  let seq = v[0] - v[1] === 1 && v[1] - v[2] === 1;
  let top = v;
  if (!seq && v[0] === 14 && v[1] === 3 && v[2] === 2) {
    seq = true; // A-2-3 ranks just below A-K-Q
    top = [13.5, 0, 0];
  }
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

// ---- Texas Hold'em: best 5 of 7 ----
export const POKER_NAMES = ["High Card", "Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", "Straight Flush"];

function five(cards: Card[]): number[] {
  const v = cards.map((c) => HIGH[c.r]).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const uniq = [...new Set(v)];
  let straightTop = 0;
  if (uniq.length === 5) {
    if (v[0] - v[4] === 4) straightTop = v[0];
    else if (v[0] === 14 && v[1] === 5) straightTop = 5; // wheel
  }
  const counts = new Map<number, number>();
  v.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const order = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]).join("");
  if (straightTop && flush) return [8, straightTop];
  if (shape === "41") return [7, ...order];
  if (shape === "32") return [6, ...order];
  if (flush) return [5, ...v];
  if (straightTop) return [4, straightTop];
  if (shape === "311") return [3, ...order];
  if (shape === "221") return [2, ...order];
  if (shape === "2111") return [1, ...order];
  return [0, ...v];
}

export function pokerScore(cards: Card[]): number[] {
  if (cards.length < 5) return [-1];
  let best: number[] = [-1];
  const pick = (from: number, chosen: Card[]) => {
    if (chosen.length === 5) {
      const sc = five(chosen);
      if (compare(sc, best) > 0) best = sc;
      return;
    }
    for (let i = from; i < cards.length; i++) pick(i + 1, [...chosen, cards[i]]);
  };
  pick(0, []);
  return best;
}
