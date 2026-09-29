import type { GameId } from "../lib/data";

export type Route =
  | { name: "home" }
  | { name: "games"; category?: "card" | "casino" | "board" }
  | { name: "lobby"; game: GameId }
  | { name: "casino"; game: GameId }
  | { name: "cardtable"; game: GameId; table: string; buyIn: number }
  | { name: "rummy"; table: string; buyIn: number }
  | { name: "board"; game: GameId; table: string; buyIn: number }
  | { name: "wallet" }
  | { name: "addcash" }
  | { name: "withdraw" }
  | { name: "txns" }
  | { name: "more" }
  | { name: "history" }
  | { name: "kyc" }
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
