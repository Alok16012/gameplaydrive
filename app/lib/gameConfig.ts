"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// Admin game settings (app_settings.games, set from /admin → Game Config). The database enforces the parts that
// matter (closed games, bet limits, daily limits); the app reads them to show "Closed" tiles and to pace bots and
// work out fees in the browser-played games.

export interface GameSettings { enabled?: boolean; min_bet?: number; max_bet?: number; rake?: number; turn?: number; blind_limit?: number; bot_speed?: "slow" | "normal" | "fast" }
type All = Record<string, GameSettings>;

let cache: { at: number; p: Promise<All> } | null = null;
let latest: All = {};

export function loadGameSettings(): Promise<All> {
  if (cache && Date.now() - cache.at < 60000) return cache.p;
  const p = Promise.resolve(supabase().from("app_settings").select("value").eq("key", "games").maybeSingle())
    .then(({ data }) => { latest = (data?.value ?? {}) as All; return latest; })
    .catch(() => latest);
  cache = { at: Date.now(), p };
  return p;
}

/** Settings key for a game id (both Rummy variants share "rummy"). */
const key = (id: string) => (id === "rummy21" ? "rummy" : id);

export function useGameSettings(): All {
  const [s, setS] = useState<All>(latest);
  useEffect(() => { loadGameSettings().then(setS); }, []);
  return s;
}

export const isClosed = (s: All, id: string) => s[key(id)]?.enabled === false;
export const latestSettings = () => latest;
/** Platform fee as a fraction (e.g. 0.1), falling back to the game's default. */
export const feeOf = (s: All, id: string, defPct: number) => Math.min(25, Math.max(0, s[key(id)]?.rake ?? defPct)) / 100;
/** Multiplier for bot thinking time: slow 1.6×, normal 1×, fast 0.55×. */
export const botPace = (s: All, id: string) => ({ slow: 1.6, normal: 1, fast: 0.55 })[s[key(id)]?.bot_speed ?? "normal"];
