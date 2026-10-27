// JILI games through the iGaming SoftAPI (https://world-casino-api.com/api/v1). Only the games listed here can be
// opened from the app. Free play (demo) needs nothing but our token; real-coin play (launch + bet callbacks) needs a
// whitelisted server IP and GGR credit on the SoftAPI account — not wired up yet.

/** App game id → SoftAPI game_uid (from GET /api/v1/games, brand 49 = JILI). */
export const JILI_GAMES: Record<string, { uid: string; name: string }> = {
  "super-ace": { uid: "879", name: "Super Ace" },
};

/** A free-play URL for one of our JILI games (no coins involved). */
export async function jiliDemoUrl(game: string): Promise<string> {
  const g = JILI_GAMES[game];
  if (!g) throw new Error("Unknown game");
  const base = process.env.SOFTAPI_URL ?? "https://world-casino-api.com/api/v1";
  const token = process.env.SOFTAPI_TOKEN;
  if (!token) throw new Error("JILI is not set up on this server");
  const r = await fetch(`${base}/demo?token=${encodeURIComponent(token)}&game_uid=${encodeURIComponent(g.uid)}`, { cache: "no-store" });
  const text = (await r.text()).trim();
  if (!text.startsWith("http")) {
    let msg = "The game could not be opened";
    try { msg = (JSON.parse(text) as { msg?: string }).msg ?? msg; } catch { /* plain text */ }
    throw new Error(msg);
  }
  return text;
}
