// Demo data for the GameHub client demo. Everything here is sample data held in memory —
// the real app reads it from the backend (PRD §4: Node + Socket.io, PostgreSQL ledger, Redis lobbies).

export type GameCategory = "card" | "casino" | "board";
export type GameKind = "rummy" | "cardtable" | "casino" | "board" | "aviator" | "roulette" | "blackjack" | "plinko";

export type GameId =
  | "rummy"
  | "teen-patti"
  | "andar-bahar"
  | "dragon-tiger"
  | "lucky-7"
  | "poker"
  | "ludo"
  | "carrom"
  | "chess"
  | "aviator"
  | "rummy21"
  | "roulette"
  | "blackjack"
  | "plinko";

export interface Game {
  id: GameId;
  name: string;
  tag: string; // short label on the home tile
  meta: string; // line under the name on the games list
  category: GameCategory;
  kind: GameKind;
  from: string; // tile gradient
  to: string;
  glow: string;
  players: string;
  online: number;
  phase: 1 | 2 | 3;
}

export const GAMES: Game[] = [
  { id: "rummy", name: "Rummy", tag: "13 Cards", meta: "13 Card • 2-6 Players", category: "card", kind: "rummy", from: "#4b4fc4", to: "#1d2170", glow: "#5b61ff", players: "2-6", online: 12480, phase: 2 },
  { id: "rummy21", name: "21 Card Rummy", tag: "21 Cards", meta: "21 Card • 2-6 Players", category: "card", kind: "rummy", from: "#0f766e", to: "#0b2a3d", glow: "#2dd4bf", players: "2-6", online: 6930, phase: 3 },
  { id: "teen-patti", name: "Teen Patti", tag: "3 Cards", meta: "3 Card • 2-6 Players", category: "card", kind: "cardtable", from: "#d42f36", to: "#6d0e14", glow: "#ff4d57", players: "2-6", online: 18230, phase: 2 },
  { id: "andar-bahar", name: "Andar Bahar", tag: "Casino Style", meta: "Casino Style • 2-7 Players", category: "casino", kind: "casino", from: "#c98a1f", to: "#5e3606", glow: "#ffb13b", players: "2-7", online: 6410, phase: 1 },
  { id: "dragon-tiger", name: "Dragon Tiger", tag: "Casino Style", meta: "Casino Style • 2-7 Players", category: "casino", kind: "casino", from: "#7b35c9", to: "#2e0f5c", glow: "#a45cff", players: "2-7", online: 9120, phase: 1 },
  { id: "lucky-7", name: "Lucky 7", tag: "Casino Style", meta: "Casino Style • 2-7 Players", category: "casino", kind: "casino", from: "#23a058", to: "#0b4424", glow: "#3ddc84", players: "2-7", online: 5270, phase: 1 },
  { id: "poker", name: "Poker", tag: "Texas Hold'em", meta: "Texas Hold'em • 2-6 Players", category: "card", kind: "cardtable", from: "#2459e0", to: "#0b1f6b", glow: "#3d7bff", players: "2-6", online: 7840, phase: 3 },
  { id: "ludo", name: "Ludo", tag: "Board Game", meta: "Board Game • 2-4 Players", category: "board", kind: "board", from: "#14a0b4", to: "#063f4a", glow: "#2fd3e8", players: "2-4", online: 15360, phase: 2 },
  { id: "carrom", name: "Carrom", tag: "Board Game", meta: "Board Game • 2 Players", category: "board", kind: "board", from: "#d8691e", to: "#6b2a06", glow: "#ff8a3d", players: "2", online: 3920, phase: 3 },
  { id: "aviator", name: "Aviator", tag: "Crash Game", meta: "Crash • Live rounds", category: "casino", kind: "aviator", from: "#2a0a10", to: "#0b0b0f", glow: "#e50914", players: "Live", online: 11240, phase: 1 },
  { id: "roulette", name: "Roulette", tag: "Casino Style", meta: "European • Single zero", category: "casino", kind: "roulette", from: "#15803d", to: "#052e16", glow: "#22c55e", players: "Live", online: 8650, phase: 1 },
  { id: "blackjack", name: "Blackjack", tag: "21", meta: "Blackjack • vs Dealer", category: "card", kind: "blackjack", from: "#334155", to: "#0b1220", glow: "#94a3b8", players: "1", online: 7120, phase: 1 },
  { id: "plinko", name: "Plinko", tag: "Drop Game", meta: "Plinko • Instant", category: "casino", kind: "plinko", from: "#db2777", to: "#4a0a2c", glow: "#f472b6", players: "Live", online: 9840, phase: 1 },
  { id: "chess", name: "Chess", tag: "Board Game", meta: "Board Game • 2 Players", category: "board", kind: "board", from: "#4a5368", to: "#171b27", glow: "#8a94ad", players: "2", online: 4410, phase: 3 },
];

export const gameById = (id: GameId) => GAMES.find((g) => g.id === id)!;

export type Stake = "Low" | "Mid" | "High";

export interface Table {
  id: string;
  seated: number;
  seats: number;
  buyIn: number;
  stake: Stake;
}

// Lobby tables (PRD §5.3 — stake tiers). Same list is re-used per game with a per-game multiplier.
export const TABLES: Table[] = [
  { id: "101", seated: 2, seats: 6, buyIn: 10, stake: "Low" },
  { id: "203", seated: 4, seats: 6, buyIn: 25, stake: "Low" },
  { id: "307", seated: 3, seats: 6, buyIn: 50, stake: "Mid" },
  { id: "412", seated: 6, seats: 6, buyIn: 100, stake: "Mid" },
  { id: "528", seated: 2, seats: 6, buyIn: 200, stake: "High" },
  { id: "615", seated: 5, seats: 6, buyIn: 500, stake: "High" },
  { id: "722", seated: 1, seats: 6, buyIn: 1000, stake: "High" },
];

// Rummy has its own entry ladder (50 → 5,000 coins).
export const RUMMY_TABLES: Table[] = [
  { id: "101", seated: 3, seats: 6, buyIn: 50, stake: "Low" },
  { id: "203", seated: 4, seats: 6, buyIn: 100, stake: "Low" },
  { id: "307", seated: 2, seats: 6, buyIn: 250, stake: "Mid" },
  { id: "412", seated: 5, seats: 6, buyIn: 500, stake: "Mid" },
  { id: "528", seated: 6, seats: 6, buyIn: 1000, stake: "Mid" },
  { id: "615", seated: 3, seats: 6, buyIn: 2000, stake: "High" },
  { id: "722", seated: 1, seats: 6, buyIn: 5000, stake: "High" },
];

export const USER = {
  name: "Rahul Sharma",
  first: "Rahul",
  id: "GH123456",
  phone: "+91 98765 43210",
  email: "rahul.sharma@example.com",
  kyc: "Verified" as const,
  joined: "12 Aug 2025",
  bank: "HDFC Bank •••• 4821",
  upi: "rahul@okhdfc",
};

export interface Wallet {
  deposit: number;
  winning: number;
  bonus: number;
}

export const START_WALLET: Wallet = { deposit: 1200, winning: 980, bonus: 270 };

export type TxnType = "deposit" | "winning" | "bet" | "withdraw" | "bonus";

export interface Txn {
  id: string;
  type: TxnType;
  title: string;
  sub: string;
  amount: number; // signed
  status?: "Success" | "Pending" | "Failed";
}

export const START_TXNS: Txn[] = [
  { id: "t1", type: "deposit", title: "Added Cash", sub: "UPI • 10 Oct 2025, 09:12 AM", amount: 500, status: "Success" },
  { id: "t2", type: "winning", title: "Game Winnings", sub: "Rummy • 9 Oct 2025, 08:45 PM", amount: 120, status: "Success" },
  { id: "t3", type: "bet", title: "Bet Placed", sub: "Teen Patti • 9 Oct 2025, 08:20 PM", amount: -50, status: "Success" },
  { id: "t4", type: "bonus", title: "Welcome Bonus", sub: "Promo • 8 Oct 2025, 06:02 PM", amount: 100, status: "Success" },
  { id: "t5", type: "withdraw", title: "Withdrawal", sub: "HDFC •••• 4821 • 7 Oct 2025, 11:40 AM", amount: -800, status: "Success" },
  { id: "t6", type: "winning", title: "Game Winnings", sub: "Dragon Tiger • 6 Oct 2025, 10:15 PM", amount: 340, status: "Success" },
  { id: "t7", type: "bet", title: "Bet Placed", sub: "Andar Bahar • 6 Oct 2025, 10:02 PM", amount: -200, status: "Success" },
  { id: "t8", type: "deposit", title: "Added Cash", sub: "NetBanking • 5 Oct 2025, 07:30 PM", amount: 1000, status: "Success" },
];

export interface HistoryItem {
  game: GameId;
  table: string;
  when: string;
  result: "Won" | "Lost" | "Refund";
  amount: number;
}

export const GAME_HISTORY: HistoryItem[] = [
  { game: "rummy", table: "Table #203", when: "Today, 08:45 PM", result: "Won", amount: 120 },
  { game: "teen-patti", table: "Table #101", when: "Today, 08:20 PM", result: "Lost", amount: -50 },
  { game: "dragon-tiger", table: "Round #88213", when: "Yesterday, 10:15 PM", result: "Won", amount: 340 },
  { game: "andar-bahar", table: "Round #55120", when: "Yesterday, 10:02 PM", result: "Lost", amount: -200 },
  { game: "ludo", table: "Table #307", when: "7 Oct, 06:30 PM", result: "Won", amount: 90 },
  { game: "lucky-7", table: "Round #31877", when: "7 Oct, 05:10 PM", result: "Refund", amount: 0 },
  { game: "rummy", table: "Table #528", when: "6 Oct, 09:40 PM", result: "Lost", amount: -80 },
];

export const NOTIFICATIONS = [
  { title: "Welcome to Khelobaazi 🎉", body: "Coins are virtual and come from your agent. Pick a game and take a seat!", when: "Now", unread: true },
];

export const FAQS = [
  { q: "How do I add cash?", a: "Go to Wallet → Add Cash, pick an amount and pay via UPI, NetBanking or Card. Money reaches your Deposit Cash instantly." },
  { q: "Which balance can I withdraw?", a: "Only Winning Cash can be withdrawn, and only after KYC is verified. Deposit Cash and Bonus are for playing." },
  { q: "What happens if my internet drops mid-game?", a: "You have 60 seconds to reconnect to the same table with your hand, pot and timer restored. If you don't, the server auto-plays the safest move (fold / discard / skip)." },
  { q: "How is bonus cash used?", a: "Bonus is used first but capped per table (10% of the entry), then Deposit Cash, then Winning Cash." },
  { q: "Are games fair?", a: "Every shuffle, dice roll and result is generated on the server with a certified RNG. The app never decides outcomes." },
];

// Card helpers
export const SUITS = ["♠", "♥", "♦", "♣"] as const;
export type Suit = (typeof SUITS)[number];
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export type Rank = (typeof RANKS)[number];
export interface Card {
  r: Rank;
  s: Suit;
}
export const rankValue = (r: Rank) => RANKS.indexOf(r) + 1; // A=1 … K=13

export function randomCard(): Card {
  return { r: RANKS[Math.floor(Math.random() * 13)], s: SUITS[Math.floor(Math.random() * 4)] };
}

export function deck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** Format a coin amount (virtual coins — no cash value). Named `inr` for historical reasons. */
export const inr = (n: number) =>
  "🪙 " + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const AVATARS = ["👨🏽", "👩🏻", "🧔🏾", "👨🏻‍🦱", "👩🏽‍🦱", "🧑🏼"];
export const BOT_NAMES = ["Arjun", "Priya", "Vikram", "Sneha", "Karan", "Meera"];
