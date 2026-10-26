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

/** Roulette bet: "n_17" → "17", "s_1_2" → "Split 1/2", "q_1_2_4_5" → "Corner 1/2/4/5", "d1" → "1st 12", "c3" → "Column 3". */
export const rouletteSide = (s: string) => {
  if (/^n_\d+$/.test(s)) return s.slice(2);
  if (/^s_/.test(s)) return `Split ${s.slice(2).replace(/_/g, "/")}`;
  if (/^q_/.test(s)) return `Corner ${s.slice(2).replace(/_/g, "/")}`;
  if (/^d[123]$/.test(s)) return `${["1st", "2nd", "3rd"][Number(s[1]) - 1]} 12`;
  if (/^c[123]$/.test(s)) return `Column ${s[1]}`;
  return sideLabel(s);
};
