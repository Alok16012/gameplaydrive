// Classic Teen Patti hand evaluator — this app's house rules, pure and deterministic.
//
// Categories, strongest first: TRAIL > PURE_SEQUENCE > SEQUENCE > COLOR > PAIR > HIGH_CARD.
// Sequence order: AKQ > A23 > KQJ > QJ10 > J109 > 1098 > 987 > 876 > 765 > 654 > 543 > 432 (no wrap-around).
// Suits never rank. Who loses a tied paid show is the engine's business, not the evaluator's.

export type Suit = "S" | "H" | "D" | "C";
export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];
/** 2–10, J = 11, Q = 12, K = 13, A = 14. */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export interface Card { r: Rank; s: Suit }

export type Category = "TRAIL" | "PURE_SEQUENCE" | "SEQUENCE" | "COLOR" | "PAIR" | "HIGH_CARD";
export const CATEGORY_VALUE: Record<Category, number> = { TRAIL: 6, PURE_SEQUENCE: 5, SEQUENCE: 4, COLOR: 3, PAIR: 2, HIGH_CARD: 1 };
export const CATEGORY_NAME: Record<Category, string> = {
  TRAIL: "Trail", PURE_SEQUENCE: "Pure Sequence", SEQUENCE: "Sequence", COLOR: "Color", PAIR: "Pair", HIGH_CARD: "High Card",
};

export interface Evaluation {
  category: Category;
  name: string;
  /** Compare lexicographically; a longer key never meets a shorter one of the same category. */
  key: number[];
  /** The three cards, highest rank first (suit order S, H, D, C on equal ranks) — display only. */
  cards: Card[];
}

export class InvalidHandError extends Error {}

const RANK_LABEL: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const SUIT_LABEL: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const rankLabel = (r: number) => RANK_LABEL[r] ?? String(r);
export const cardLabel = (c: Card) => `${rankLabel(c.r)}${SUIT_LABEL[c.s]}`;
export const cardId = (c: Card) => `${c.r}${c.s}`;

export function isValidCard(c: unknown): c is Card {
  if (!c || typeof c !== "object") return false;
  const { r, s } = c as { r: unknown; s: unknown };
  return typeof r === "number" && Number.isInteger(r) && r >= 2 && r <= 14 && (SUITS as readonly unknown[]).includes(s);
}

function validate(cards: readonly Card[]) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new InvalidHandError("A hand has exactly three cards");
  for (const c of cards) if (!isValidCard(c)) throw new InvalidHandError("Invalid card");
  if (new Set(cards.map(cardId)).size !== 3) throw new InvalidHandError("Duplicate card in hand");
}

/**
 * Sequence strength 12 (AKQ) … 1 (432) for three distinct ranks sorted high → low, or 0 if not a sequence.
 * Ace is high only in AKQ and low only in A23; KA2, QKA-wraps etc. are not sequences.
 */
export function sequenceStrength(desc: readonly number[]): number {
  const [a, b, c] = desc;
  if (a === 14 && b === 13 && c === 12) return 12;
  if (a === 14 && b === 3 && c === 2) return 11;
  if (a <= 13 && a - b === 1 && b - c === 1) return a - 3; // KQJ = 10 … 432 = 1
  return 0;
}

export function evaluate(cards: readonly Card[]): Evaluation {
  validate(cards);
  const sorted = [...cards].sort((x, y) => y.r - x.r || SUITS.indexOf(x.s) - SUITS.indexOf(y.s));
  const v = sorted.map((c) => c.r);
  const flush = sorted[0].s === sorted[1].s && sorted[1].s === sorted[2].s;
  const out = (category: Category, key: number[]): Evaluation => ({ category, name: CATEGORY_NAME[category], key: [CATEGORY_VALUE[category], ...key], cards: sorted });

  if (v[0] === v[1] && v[1] === v[2]) return out("TRAIL", [v[0]]);
  const seq = v[0] !== v[1] && v[1] !== v[2] ? sequenceStrength(v) : 0;
  if (seq && flush) return out("PURE_SEQUENCE", [seq]);
  if (seq) return out("SEQUENCE", [seq]);
  if (flush) return out("COLOR", v);
  if (v[0] === v[1]) return out("PAIR", [v[0], v[2]]);
  if (v[1] === v[2]) return out("PAIR", [v[1], v[0]]);
  return out("HIGH_CARD", v);
}

export function compareKeys(a: readonly number[], b: readonly number[]): -1 | 0 | 1 {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 1 if A wins, -1 if B wins, 0 if equal. */
export function compareHands(a: readonly Card[], b: readonly Card[]): -1 | 0 | 1 {
  return compareKeys(evaluate(a).key, evaluate(b).key);
}

/** Throws unless every hand is valid and no card appears twice across the whole roster. */
export function validateRoster(hands: readonly (readonly Card[])[]) {
  const seen = new Set<string>();
  for (const h of hands) {
    validate(h);
    for (const c of h) {
      const id = cardId(c);
      if (seen.has(id)) throw new InvalidHandError("Duplicate card across hands");
      seen.add(id);
    }
  }
}

/** Every distinct-rank triple that is not a sequence (274 of them), strongest first, as [high, mid, low]. */
export function nonSequenceRankTriples(): number[][] {
  const out: number[][] = [];
  for (let a = 14; a >= 4; a--) for (let b = a - 1; b >= 3; b--) for (let c = b - 1; c >= 2; c--) {
    if (!sequenceStrength([a, b, c])) out.push([a, b, c]);
  }
  return out; // generated high-to-low lexicographically, which is exactly the COLOR / HIGH_CARD order
}

export function fullDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  return d;
}
