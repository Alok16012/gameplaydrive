// JILI games through the iGaming SoftAPI (https://world-casino-api.com/api/v1): the whole JILI catalogue (brand 49)
// in the app. Free play (demo) needs nothing but our token; real-coin play (launch + bet callbacks) needs a
// whitelisted server IP and GGR credit on the SoftAPI account — not wired up yet.

import { createCipheriv, createDecipheriv } from "node:crypto";
import { rpc, selectOne } from "./supabaseAdmin";

import { BROKEN_LOGO, NO_FREE_PLAY } from "./jiliCatalog";

/** demo: free play offered (JILI has coins-only games). */
export interface JiliGameInfo { uid: string; name: string; category: string; logo: string | null; demo: boolean }

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
  const games: JiliGameInfo[] = j.data.games.filter((x) => x.brand_id === 49).map((x) => {
    const uid = String(x.game_uid);
    return { uid, name: x.name.trim(), category: category(x.category ?? ""), logo: x.logo && !BROKEN_LOGO.has(uid) ? x.logo : null, demo: !NO_FREE_PLAY.has(uid) };
  });
  // A game without a picture ("Boxing King Exclusive", "Fortune Gems 500"…) borrows its base game's: the longest
  // other game name it starts with that has one.
  const byName = games.filter((g) => g.logo).sort((a, b) => b.name.length - a.name.length);
  for (const g of games) {
    if (g.logo) continue;
    const base = byName.find((o) => o.uid !== g.uid && g.name.toLowerCase().startsWith(o.name.toLowerCase() + " "));
    if (base) g.logo = base.logo;
  }
  cache = { at: Date.now(), games };
  return games;
}

/** A free-play URL for a JILI game on our account (no coins involved). */
export async function jiliDemoUrl(uid: string): Promise<string> {
  const [games, hidden] = await Promise.all([jiliGames(), jiliHidden()]);
  if (!games.some((g) => g.uid === uid) || hidden.has(uid)) throw new Error("This game is not available");
  if (NO_FREE_PLAY.has(uid)) throw new Error("This game has no free play — play it with coins");
  const r = await fetch(`${BASE()}/demo?token=${encodeURIComponent(TOKEN())}&game_uid=${encodeURIComponent(uid)}`, { cache: "no-store" });
  const text = (await r.text()).trim();
  if (!text.startsWith("http")) {
    let msg = "The game could not be opened";
    try {
      const e = JSON.parse(text) as { code?: number; msg?: string };
      msg = e.code === 1008 ? "This game has no free play — play it with coins" : e.msg ?? msg;
    } catch { /* plain text */ }
    throw new Error(msg);
  }
  return text;
}

// ---- Real-coin play (migration 112): play currency VND ----

/** Players 100001.. were initially registered as INR on SoftAPI; an offset gives fresh VND IDs. */
const MEMBER_OFFSET = 200000;

const secret = () => {
  const s = process.env.JILI_SECRET ?? "";
  if (s.length !== 32) throw new Error("JILI with coins is not set up yet");
  return s;
};
/** SoftAPI's payload encryption: AES-256-ECB, PKCS7, Base64. */
export function softEncrypt(obj: unknown, key = secret()) {
  const c = createCipheriv("aes-256-ecb", Buffer.from(key, "utf8"), null);
  return Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), "utf8")), c.final()]).toString("base64");
}
export function softDecrypt(b64: string, key = secret()) {
  const d = createDecipheriv("aes-256-ecb", Buffer.from(key, "utf8"), null);
  return JSON.parse(Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8"));
}

export const COIN_TO_VND = Number(process.env.JILI_COIN_TO_VND ?? 1);

/** Is real-coin JILI configured on this server? */
export const jiliRealReady = () => (process.env.JILI_SECRET ?? "").length === 32 && !!process.env.SOFTAPI_PROXY_KEY && !!process.env.JILI_CALLBACK_KEY;

/** Most coins a launch may carry: SoftAPI wants GGR credit ≥ 5% of the launch balance. */
async function launchCap(): Promise<number> {
  const r = await fetch(`${BASE()}/ggr-balance?token=${encodeURIComponent(TOKEN())}`, { cache: "no-store" });
  const j = (await r.json().catch(() => null)) as { code?: number; data?: { wallet?: number } } | null;
  const usdt = Number(j?.data?.wallet ?? 0);
  const vndPerUsdt = Number(process.env.SOFTAPI_VND_RATE ?? 25000);
  return Math.floor((usdt / 0.05) * vndPerUsdt * 0.95); // 5% margin
}

/** Launch a JILI game with the player's coins; returns the game URL. */
export async function jiliLaunch(userId: string, uid: string): Promise<{ url: string; balance: number; coins: number; balanceVnd: number }> {
  const [games, hidden] = await Promise.all([jiliGames(), jiliHidden()]);
  if (!games.some((g) => g.uid === uid) || hidden.has(uid)) throw new Error("This game is not available");
  await rpc("game_guard", { g: "jili", amount: 0, check_size: false }); // closed for maintenance?
  const w = await selectOne<{ coins: number }>("wallets", `select=coins&user_id=eq.${userId}`);
  const coins = Math.floor(Number(w?.coins ?? 0));
  if (coins < 1) throw new Error("Not enough coins — ask your agent");

  const playerVnd = Math.floor(coins * COIN_TO_VND);
  const capVnd = await launchCap();
  if (capVnd < COIN_TO_VND) throw new Error("JILI is resting for a moment — please try again later");

  const balanceVnd = Math.min(playerVnd, capVnd);
  const balance = Math.floor(balanceVnd / COIN_TO_VND); // coins taken into game
  const num = await rpc<number>("jili_player_num", { p_user: userId });
  const site = process.env.JILI_SITE_URL ?? "https://www.khelobaazi.in";
  const payload = {
    user_id: String(num + MEMBER_OFFSET),
    balance: String(balanceVnd),
    game_uid: uid,
    token: TOKEN(),
    timestamp: Date.now(),
    return: `${site}/`,
    callback: `${site}/api/jili/callback?k=${process.env.JILI_CALLBACK_KEY}`,
    currency_code: process.env.JILI_CURRENCY ?? "VND",
    language: "en",
  };
  const proxy = process.env.SOFTAPI_PROXY_URL ?? "https://srv2101978.hstgr.cloud/softapi";
  const r = await fetch(proxy, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proxy-key": process.env.SOFTAPI_PROXY_KEY ?? "" },
    body: JSON.stringify({ token: TOKEN(), payload: softEncrypt(payload) }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => null)) as { code?: number; msg?: string; data?: { url?: string } } | null;
  if (j?.code !== 0 || !j.data?.url) {
    console.warn("jili launch failed:", r.status, j?.code, j?.msg);
    throw new Error(j?.code === 1 ? "JILI is resting for a moment — please try again later" : j?.msg || "The game could not be opened");
  }
  return { url: j.data.url, balance, coins, balanceVnd };
}

/** One settle notice from SoftAPI (plain or { payload } encrypted) into the ledger. */
export async function jiliCallback(body: Record<string, unknown>) {
  const n = (typeof body.payload === "string" ? softDecrypt(body.payload) : body) as Record<string, unknown>;
  const raw = Number(n.member_account);
  const member = raw >= MEMBER_OFFSET ? raw - MEMBER_OFFSET : raw;
  const rawBet = Number(n.bet_amount ?? 0);
  const rawWin = Number(n.win_amount ?? 0);
  const rawCredit = n.credit_amount != null ? Number(n.credit_amount) : null;

  // Convert VND amounts back to Coins for the ledger
  const betCoins = rawBet / COIN_TO_VND;
  const winCoins = rawWin / COIN_TO_VND;
  const creditCoins = rawCredit != null ? rawCredit / COIN_TO_VND : null;

  return rpc<Record<string, unknown>>("jili_settle", {
    p_serial: String(n.serial_number ?? ""),
    p_member: member,
    p_game_uid: n.game_uid != null ? String(n.game_uid) : n.game_id != null ? String(n.game_id) : null,
    p_game_name: n.game_name != null ? String(n.game_name) : null,
    p_round: n.game_round != null ? String(n.game_round) : null,
    p_bet: betCoins,
    p_win: winCoins,
    p_credit: creditCoins,
  });
}
