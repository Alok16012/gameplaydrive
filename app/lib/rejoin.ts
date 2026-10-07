"use client";

import { useEffect, useState } from "react";
import type { Route } from "../components/nav";

// "Rejoin game": the table you were last playing at, so you can go back to it from Home.
//   • Server tables (Teen Patti, Rummy, Blackjack) keep your seat / hand on the server; rejoining just opens the
//     table again.
//   • Games that run on the phone (Ludo, Chess, Poker) also save their state here after every move, so the game
//     carries on from where you left it — the entry is not charged again.
// Everything lives in this browser only (localStorage) and expires after a few hours.

export interface ActiveGame { route: Route; title: string; at: number; ttl?: number }

/**
 * How long after you leave a table you can still come back to it — about three missed turns, after which the
 * table has packed / dropped you (server tables) or the game is given up (games on the phone).
 */
export const REJOIN_MS = {
  rummy: 90_000,      // 3 × 30 s turns; the server also seats only players seen in the last 90 s
  teenPatti: 60_000,  // the game server drops a player who has been away 60 s
  ludo: 60_000,       // 3 × 20 s turns
  poker: 45_000,      // 3 × 15 s turns
  blackjack: MAX_AGE_HOURS(3), // a dealt hand waits on the server until you finish it
};
function MAX_AGE_HOURS(h: number) { return h * 60 * 60 * 1000; }

const KEY = "kb-active-game";
const SNAP = "kb-snap:";
const MAX_AGE = 3 * 60 * 60 * 1000;
const subs = new Set<() => void>();

const read = <T,>(k: string): T | null => {
  try { const raw = window.localStorage.getItem(k); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
};
const write = (k: string, v: unknown) => {
  try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
};

export function markActive(route: Route, title: string, ttl?: number) {
  write(KEY, { route, title, at: Date.now(), ttl } satisfies ActiveGame);
  subs.forEach((f) => f());
}

/** Still at this table (screen open): keep the rejoin window counting from now. */
export function touchActive(route: Route) {
  const cur = read<ActiveGame>(KEY);
  if (!cur || JSON.stringify(cur.route) !== JSON.stringify(route)) return;
  write(KEY, { ...cur, at: Date.now() });
}

/** Forget the active game (only if it is this route, when one is given). */
export function clearActive(route?: Route) {
  const cur = getActive();
  if (route && cur && JSON.stringify(cur.route) !== JSON.stringify(route)) return;
  write(KEY, null);
  subs.forEach((f) => f());
}

export function getActive(): ActiveGame | null {
  if (typeof window === "undefined") return null;
  const a = read<ActiveGame>(KEY);
  if (!a || Date.now() - a.at > (a.ttl ?? MAX_AGE)) return null;
  return a;
}

export function useActiveGame(): ActiveGame | null {
  const [a, setA] = useState<ActiveGame | null>(null);
  useEffect(() => {
    const f = () => setA(getActive());
    f();
    subs.add(f);
    const t = setInterval(f, 5000); // the banner goes away by itself once the window has passed
    return () => { subs.delete(f); clearInterval(t); };
  }, []);
  return a;
}

/** Saved state of a game that runs on the phone, keyed by game + table + entry. */
export function saveSnap<T>(key: string, data: T) {
  write(SNAP + key, { at: Date.now(), data });
}
export function loadSnap<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  const s = read<{ at: number; data: T }>(SNAP + key);
  if (!s || Date.now() - s.at > MAX_AGE) return null;
  return s.data;
}
/** How long ago (ms) a saved game was last saved, or null if there is none. */
export function snapAge(key: string): number | null {
  if (typeof window === "undefined") return null;
  const s = read<{ at: number }>(SNAP + key);
  return s ? Date.now() - s.at : null;
}
export function dropSnap(key: string) {
  write(SNAP + key, null);
}
