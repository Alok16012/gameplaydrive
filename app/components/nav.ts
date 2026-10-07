import type { GameId } from "../lib/data";

/** Rummy formats. Points: one deal, settled per point. Pool: play deals until everyone else crosses 101/201. Deals: fixed number of deals, most chips wins. */
export type RummyMode = "points" | "pool101" | "pool201" | "deals";

export type Route =
  | { name: "home" }
  | { name: "games"; category?: "sports" | "card" | "casino" | "board" }
  | { name: "lobby"; game: GameId }
  | { name: "casino"; game: GameId }
  | { name: "cricket"; matchId?: string; sport?: "cricket" | "tennis" | "soccer" }
  | { name: "aviator" }
  | { name: "roulette" }
  | { name: "blackjack" }
  | { name: "plinko" }
  | { name: "stockmarket" }
  | { name: "cardtable"; game: GameId; table: string; buyIn: number }
  | { name: "rummy"; table: string; buyIn: number; mode: RummyMode; deals?: number; cards?: 13 | 21; avoid?: string } // buyIn = point value (points) or entry fee; avoid = a table just left
  | { name: "board"; game: GameId; table: string; buyIn: number; players?: 2 | 4 } // Ludo: 2 or 4 players
  | { name: "wallet" }
  | { name: "addcash" } // "Get coins": coins come from your agent
  | { name: "txns" }
  | { name: "more" }
  | { name: "history" }
  | { name: "rg" }
  | { name: "help" }
  | { name: "settings" }
  | { name: "notifications" };

export interface Nav {
  push: (r: Route) => void;
  back: () => void;
  reset: (r: Route) => void;
  logout: () => void;
}
