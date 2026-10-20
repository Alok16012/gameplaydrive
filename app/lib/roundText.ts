// Plain-language text for casino bets and results, shared by the player's Game History and Reports → Find a round.

const SIDE: Record<string, string> = {
  andar: "Andar", bahar: "Bahar", dragon: "Dragon", tiger: "Tiger", tie: "Tie", pair: "Pair",
  below: "Below 7", seven: "Seven", above: "Above 7", low: "Low", high: "High", even: "Even", odd: "Odd", black: "Black", red: "Red",
  up: "Up", down: "Down",
};

/** "andar" → "Andar", "d_red" → "Dragon red", "g_a23" → "Group a23", "c_K" → "Card K". */
export const sideLabel = (s: string) =>
  SIDE[s] ?? s.replace(/^d_/, "Dragon ").replace(/^t_/, "Tiger ").replace(/^g_/, "Group ").replace(/^c_/, "Card ").replace(/_/g, " ");

export type CardJ = { r?: string; s?: string } | null | undefined;
/** {r: "4", s: "♣"} → "4♣". */
export const cardText = (c: CardJ) => (c ? `${c.r ?? ""}${c.s ?? ""}` : "—");

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
/** Roulette number with its colour: "17 Black", "0 Green". */
export const rouletteText = (n: number) => `${n} ${n === 0 ? "Green" : RED.has(n) ? "Red" : "Black"}`;
