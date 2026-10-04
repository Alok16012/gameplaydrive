// 13 Card Rummy rules shared by the table UI. The server (public.rm_classify / rm_score_groups in
// supabase/migrations/003_teen_patti_rummy.sql) implements the same rules and is the one that decides.
//
// Two decks, no printed jokers; every card of the wild-joker rank is a joker.
// A valid declaration: 13 cards in groups of 3+, at least one pure sequence, at least two sequences,
// no invalid groups. Points (max 80): no pure sequence → every card counts; one pure sequence but no second
// sequence → everything outside pure sequences counts; otherwise only cards in invalid groups count.
// Jokers are worth 0; A, K, Q, J, 10 are worth 10; other cards their number.

import type { Card } from "./data";

export interface RCard extends Card { id: number }
export type GroupKind = "pure" | "impure" | "set" | "tunnela" | "dublee" | "invalid";
export const KIND_LABEL: Record<GroupKind, string> = { pure: "Pure Sequence", impure: "Sequence", set: "Set", tunnela: "3 Naali", dublee: "Double", invalid: "Invalid" };

/**
 * Wild-joker key, same format as the server (public.rm_wk): "5" for 13 cards (every 5 is a joker),
 * "5:♥" for 21 cards (every 5, plus 4♥ and 6♥). Printed jokers ("JK") are always jokers.
 */
export const wildKey = (wild: Card | null | undefined, cards: number) => (!wild ? "" : cards === 21 ? `${wild.r}:${wild.s}` : wild.r);

export function isJoker(c: Card, w: string): boolean {
  if ((c.r as string) === "JK") return true;
  const [wr, ws] = w.split(":");
  if (c.r === wr) return true;
  if (ws && c.s === ws && LOW[c.r] && LOW[wr]) return [1, 12].includes((LOW[c.r] - LOW[wr] + 13) % 13);
  return false;
}

const LOW: Record<string, number> = { A: 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, J: 11, Q: 12, K: 13 };

export const cardPoints = (c: Card, wild: string) => (isJoker(c, wild) ? 0 : ["A", "K", "Q", "J", "10"].includes(c.r) ? 10 : LOW[c.r]);

const consecutive = (vals: number[]) => {
  const v = [...vals].sort((a, b) => a - b);
  return v.every((x, i) => i === 0 || x - v[i - 1] === 1);
};

export function classify(group: Card[], wild: string): GroupKind {
  const printed = group.some((c) => (c.r as string) === "JK");
  if (!printed && (group.length === 2 || group.length === 3) && group.every((c) => c.r === group[0].r && c.s === group[0].s)) {
    return group.length === 3 ? "tunnela" : "dublee";
  }
  if (group.length < 3) return "invalid";
  if (!printed && group.every((c) => c.s === group[0].s)) {
    const low = group.map((c) => LOW[c.r]);
    if (new Set(low).size === low.length && (consecutive(low) || consecutive(low.map((v) => (v === 1 ? 14 : v))))) return "pure";
  }
  const naturals = group.filter((c) => !isJoker(c, wild));
  const jokers = group.length - naturals.length;
  if (!naturals.length) return "invalid";
  if (group.length <= 4 && naturals.every((c) => c.r === naturals[0].r) && new Set(naturals.map((c) => c.s)).size === naturals.length) return "set";
  if (naturals.every((c) => c.s === naturals[0].s)) {
    for (const aceHigh of [false, true]) {
      const v = naturals.map((c) => (aceHigh && c.r === "A" ? 14 : LOW[c.r])).sort((a, b) => a - b);
      if (new Set(v).size !== v.length) continue;
      if (v[v.length - 1] - v[0] + 1 - v.length <= jokers) return "impure";
    }
  }
  return "invalid";
}

/** Points and validity for an arrangement of the whole hand. */
export function scoreGroups(groups: Card[][], wild: string): { points: number; valid: boolean; kinds: GroupKind[] } {
  const kinds = groups.map((g) => classify(g, wild));
  const pure = kinds.filter((k) => k === "pure").length;
  const seqs = kinds.filter((k) => k === "pure" || k === "impure").length;
  const sum = (gs: Card[][]) => gs.flat().reduce((a, c) => a + cardPoints(c, wild), 0);
  const count = groups.reduce((a, g) => a + g.length, 0);
  // 21 Card Rummy (the hand size picks the rules): 3 pure sequences needed (a 3 Naali counts as one); without them every
  // card counts; max 120. 3 Naali ×3 or 8 Doubles is a rummy on its own.
  if (count >= 20) {
    const tun = kinds.filter((k) => k === "tunnela").length;
    const dub = kinds.filter((k) => k === "dublee").length;
    if (count === 21 && (tun >= 3 || dub >= 8)) return { points: 0, valid: true, kinds };
    const good = (k: GroupKind) => k === "pure" || k === "impure" || k === "set" || k === "tunnela";
    const points = pure + tun < 3 ? sum(groups) : sum(groups.filter((_, i) => !good(kinds[i])));
    return { points: Math.min(points, 120), valid: count === 21 && pure + tun >= 3 && kinds.every(good), kinds };
  }
  const good13 = (k: GroupKind) => k === "pure" || k === "impure" || k === "set";
  let points: number;
  if (pure === 0) points = sum(groups);
  else if (seqs < 2) points = sum(groups.filter((_, i) => kinds[i] !== "pure"));
  else points = sum(groups.filter((_, i) => !good13(kinds[i])));
  return { points: Math.min(points, 80), valid: count === 13 && pure >= 1 && seqs >= 2 && kinds.every(good13), kinds };
}
