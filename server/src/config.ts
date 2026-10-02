// Game settings the Super Admin controls (Admin → Game Config), cached and refreshed every 30 s.
import { getSetting } from "./supa.js";

export interface GameCfg { enabled: boolean; rake: number; turn: number; blind_limit?: number }
const DEFAULTS: Record<string, GameCfg> = {
  "teen-patti": { enabled: true, rake: 5, turn: 15, blind_limit: 4 },
  rummy: { enabled: true, rake: 10, turn: 30 },
};
let cache: Record<string, GameCfg> = { ...DEFAULTS };

export async function refreshConfig() {
  try {
    const v = await getSetting<Record<string, Partial<GameCfg>>>("games");
    if (v) for (const k of Object.keys(DEFAULTS)) cache[k] = { ...DEFAULTS[k], ...(v[k] ?? {}) } as GameCfg;
  } catch (e) { console.warn("[config] refresh failed", (e as Error).message); }
}
export const cfg = (game: string): GameCfg => cache[game] ?? DEFAULTS[game];
/** Tests only. */
export const setConfig = (game: string, c: Partial<GameCfg>) => { cache[game] = { ...cfg(game), ...c }; };
