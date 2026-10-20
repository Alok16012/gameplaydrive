// Texas Hold'em hand ranking: the best five cards out of the two hole cards and up to five board cards.
// Cards are the same shape as Teen Patti's (numeric rank 2..14, suit letter), so one deck serves both games.
// Keys are arrays compared lexicographically: [category, tie-breakers…]; a higher key wins.

import { cardId, fullDeck, isValidCard, type Card } from "../teenpatti/evaluator.ts";

export type { Card };
export { cardId, fullDeck, isValidCard };

export const POKER_NAMES = ["High Card", "Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", "Straight Flush", "Royal Flush"] as const;

export interface PokerEvaluation { key: number[]; name: string }

/** Rank one five-card hand. */
export function scoreFive(cards: readonly Card[]): number[] {
  const v = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const uniq = [...new Set(v)];
  let straightTop = 0;
  if (uniq.length === 5) {
    if (v[0] - v[4] === 4) straightTop = v[0];
    else if (v[0] === 14 && v[1] === 5 && v[4] === 2) straightTop = 5; // wheel: A-2-3-4-5
  }
  const counts = new Map<number, number>();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const order = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]).join("");
  if (straightTop && flush) return [straightTop === 14 ? 9 : 8, straightTop];
  if (shape === "41") return [7, ...order];
  if (shape === "32") return [6, ...order];
  if (flush) return [5, ...v];
  if (straightTop) return [4, straightTop];
  if (shape === "311") return [3, ...order];
  if (shape === "221") return [2, ...order];
  if (shape === "2111") return [1, ...order];
  return [0, ...v];
}

export function compareKeys(a: readonly number[], b: readonly number[]): -1 | 0 | 1 {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Best five-card hand from 5, 6 or 7 cards. */
export function evaluate(cards: readonly Card[]): PokerEvaluation {
  if (cards.length < 5) throw new Error("A poker hand needs at least five cards");
  let best: number[] | null = null;
  const n = cards.length;
  const pick = (from: number, chosen: Card[]) => {
    if (chosen.length === 5) {
      const k = scoreFive(chosen);
      if (!best || compareKeys(k, best) > 0) best = k;
      return;
    }
    for (let i = from; i < n && n - i >= 5 - chosen.length; i++) pick(i + 1, [...chosen, cards[i]]);
  };
  pick(0, []);
  const key = best!;
  return { key, name: POKER_NAMES[key[0]] };
}

/** Every card in play (hole cards and board) must be a valid, distinct card. */
export function validateDeal(hands: readonly (readonly Card[])[], board: readonly Card[]) {
  const seen = new Set<string>();
  const check = (c: Card) => {
    if (!isValidCard(c)) throw new Error("Invalid card");
    const id = cardId(c);
    if (seen.has(id)) throw new Error("Duplicate card in the deal");
    seen.add(id);
  };
  for (const h of hands) {
    if (h.length !== 2) throw new Error("A hold'em hand has exactly two cards");
    h.forEach(check);
  }
  if (board.length !== 5) throw new Error("The board has exactly five cards");
  board.forEach(check);
}
