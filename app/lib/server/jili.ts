// JILI games through the iGaming SoftAPI (https://world-casino-api.com/api/v1): the whole JILI catalogue (brand 49)
// in the app. Free play (demo) needs nothing but our token; real-coin play (launch + bet callbacks) needs a
// whitelisted server IP and GGR credit on the SoftAPI account — not wired up yet.

import { selectOne } from "./supabaseAdmin";

export interface JiliGameInfo { uid: string; name: string; category: string; logo: string | null }

/** Games the Super Admin switched off (Admin → JILI Games, app_settings 'jili_games', migration 111). */
export async function jiliHidden(): Promise<Set<string>> {
  const r = await selectOne<{ value: { hidden?: string[] } }>("app_settings", "select=value&key=eq.jili_games").catch(() => null);
  return new Set((r?.value?.hidden ?? []).map(String));
}

const BASE = () => process.env.SOFTAPI_URL ?? "https://world-casino-api.com/api/v1";
const TOKEN = () => {
  const t = process.env.SOFTAPI_TOKEN;
  if (!t) throw new Error("JILI is not set up on this server");
  return t;
};

/** SoftAPI's categories are spelt many ways ("Slot", "Slots", "SLot", "flash", "Fish"…): one label each. */
function category(c: string) {
  const k = c.toLowerCase();
  if (k.startsWith("slot")) return "Slots";
  if (k.startsWith("fish")) return "Fishing";
  if (k === "crash") return "Crash";
  if (k === "mines") return "Mines";
  if (k === "flash" || k === "instant") return "Mini games";
  return "Table & Casino"; // table, card, casino
}

let cache: { at: number; games: JiliGameInfo[] } | null = null;
/** Every JILI game on our account, fetched at most once an hour (SoftAPI allows 20 list calls a minute). */
export async function jiliGames(): Promise<JiliGameInfo[]> {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.games;
  const r = await fetch(`${BASE()}/games?token=${encodeURIComponent(TOKEN())}&brand_id=49&limit=500`, { cache: "no-store" });
  const j = (await r.json()) as { code: number; msg?: string; data?: { games?: { game_uid: string; name: string; category: string; logo?: string; brand_id: number }[] } };
  if (j.code !== 0 || !j.data?.games) {
    if (cache) return cache.games; // keep serving the last good list
    throw new Error(j.msg ?? "Could not load JILI games");
  }
  const games = j.data.games.filter((x) => x.brand_id === 49).map((x) => ({ uid: String(x.game_uid), name: x.name.trim(), category: category(x.category ?? ""), logo: x.logo || null }));
  cache = { at: Date.now(), games };
  return games;
}

/** A free-play URL for a JILI game on our account (no coins involved). */
export async function jiliDemoUrl(uid: string): Promise<string> {
  const [games, hidden] = await Promise.all([jiliGames(), jiliHidden()]);
  if (!games.some((g) => g.uid === uid) || hidden.has(uid)) throw new Error("This game is not available");
  const r = await fetch(`${BASE()}/demo?token=${encodeURIComponent(TOKEN())}&game_uid=${encodeURIComponent(uid)}`, { cache: "no-store" });
  const text = (await r.text()).trim();
  if (!text.startsWith("http")) {
    let msg = "The game could not be opened";
    try {
      const e = JSON.parse(text) as { code?: number; msg?: string };
      msg = e.code === 1008 ? "This game has no free play" : e.msg ?? msg;
    } catch { /* plain text */ }
    throw new Error(msg);
  }
  return text;
}
