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
/** The SoftAPI accounts we launch from: JILI (SOFTAPI_TOKEN / JILI_SECRET) and Bharat Matka (MATKA_TOKEN /
 *  MATKA_SECRET) — each provider is licensed on its own account with its own token and secret. */
export type Provider = "jili" | "matka" | "9w";
export const PROVIDER_NAME: Record<Provider, string> = { jili: "JILI", matka: "Bharat Matka", "9w": "9Wickets" };
/** Bharat Matka is one game on its account (brand 202). */
export const MATKA_UID = "1001325";
const TOKEN = (p: Provider = "jili") => {
  const t = p === "matka" ? process.env.MATKA_TOKEN : p === "9w" ? process.env.NINE_TOKEN : process.env.SOFTAPI_TOKEN;
  if (!t) throw new Error(`${PROVIDER_NAME[p]} is not set up on this server`);
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

const secret = (p: Provider = "jili") => {
  const s = (p === "matka" ? process.env.MATKA_SECRET : p === "9w" ? process.env.NINE_SECRET : process.env.JILI_SECRET) ?? "";
  if (s.length !== 32) throw new Error(`${PROVIDER_NAME[p]} with coins is not set up yet`);
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
/** Play currency and coins-to-currency rate per provider: JILI plays in VND (JILI_COIN_TO_VND per coin); Bharat Matka
 *  takes INR only, 1 coin = ₹1. */
const CURRENCY = (p: Provider) => (p === "jili" ? process.env.JILI_CURRENCY ?? "VND" : "INR");
const RATE = (p: Provider) => (p === "jili" ? COIN_TO_VND : 1);

/** Is real-coin JILI configured on this server? */
export const jiliRealReady = (p: Provider = "jili") =>
  ((p === "matka" ? process.env.MATKA_SECRET : p === "9w" ? process.env.NINE_SECRET : process.env.JILI_SECRET) ?? "").length === 32 && !!(p === "matka" ? process.env.MATKA_TOKEN : p === "9w" ? process.env.NINE_TOKEN : process.env.SOFTAPI_TOKEN)
  && !!process.env.SOFTAPI_PROXY_KEY && !!process.env.JILI_CALLBACK_KEY;

/** Most coins a launch may carry: SoftAPI wants GGR credit against the launch balance.
 *  For JILI (VND) it is ~5%; for Bharat Matka (INR) SoftAPI requires ~1% GGR in USDT. */
async function launchCap(p: Provider = "jili"): Promise<number> {
  const r = await fetch(`${BASE()}/ggr-balance?token=${encodeURIComponent(TOKEN(p))}`, { cache: "no-store" });
  const j = (await r.json().catch(() => null)) as { code?: number; data?: { wallet?: number } } | null;
  const usdt = Number(j?.data?.wallet ?? 0);
  const perUsdt = p === "jili" ? Number(process.env.SOFTAPI_VND_RATE ?? 25000) : Number(process.env.SOFTAPI_INR_RATE ?? 90);
  const ggrMargin = p === "matka" ? 0.01 : 0.05;
  return Math.floor((usdt / ggrMargin) * perUsdt * 0.95); // 5% buffer below SoftAPI rejection threshold
}

/** Launch a JILI game (or Bharat Matka, p = "matka") with the player's coins; returns the game URL. */
export async function jiliLaunch(userId: string, uid: string, p: Provider = "jili"): Promise<{ url: string; balance: number; coins: number; balanceVnd: number }> {
  if (p === "matka") {
    if (uid !== MATKA_UID) throw new Error("This game is not available");
  } else {
    const [games, hidden] = await Promise.all([jiliGames(), jiliHidden()]);
    if (!games.some((g) => g.uid === uid) || hidden.has(uid)) throw new Error("This game is not available");
  }
  await rpc("game_guard", { g: p, amount: 0, check_size: false }); // closed for maintenance?
  await rpc("player_game_guard", { p_uid: userId, p_game: p }); // locked for this player (115)?
  const w = await selectOne<{ coins: number }>("wallets", `select=coins&user_id=eq.${userId}`);
  const coins = Math.floor(Number(w?.coins ?? 0));
  if (coins < 1) throw new Error("Not enough coins — ask your agent");

  const rate = RATE(p);
  const playerVnd = Math.floor(coins * rate);
  const capVnd = await launchCap(p);
  if (capVnd < rate) throw new Error(`${PROVIDER_NAME[p]} is resting for a moment — please try again later`);

  const balanceVnd = Math.min(playerVnd, capVnd);
  const balance = Math.floor(balanceVnd / rate); // coins taken into game
  const num = await rpc<number>("jili_player_num", { p_user: userId });
  const site = process.env.JILI_SITE_URL ?? "https://www.khelobaazi.in";
  const payload = {
    user_id: String(num + MEMBER_OFFSET),
    balance: String(balanceVnd),
    game_uid: uid,
    token: TOKEN(p),
    timestamp: Date.now(),
    return: `${site}/`,
    callback: `${site}/api/jili/callback?k=${process.env.JILI_CALLBACK_KEY}&p=${p}`,
    currency_code: CURRENCY(p),
    language: "en",
  };
  const proxy = process.env.SOFTAPI_PROXY_URL ?? "https://srv2101978.hstgr.cloud/softapi";
  const r = await fetch(proxy, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proxy-key": process.env.SOFTAPI_PROXY_KEY ?? "" },
    body: JSON.stringify({ token: TOKEN(p), payload: softEncrypt(payload, secret(p)) }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => null)) as { code?: number; msg?: string; data?: { url?: string } } | null;
  if (j?.code !== 0 || !j.data?.url) {
    console.warn(`${p} launch failed:`, r.status, j?.code, j?.msg);
    throw new Error(j?.code === 1 ? `${PROVIDER_NAME[p]} is resting for a moment — please try again later` : j?.msg || "The game could not be opened");
  }
  return { url: j.data.url, balance, coins, balanceVnd };
}

/** One settle notice from SoftAPI (plain or { payload } encrypted) into the ledger. */
export async function jiliCallback(body: Record<string, unknown>, p: Provider = "jili") {
  const n = (typeof body.payload === "string" ? softDecrypt(body.payload, secret(p)) : body) as Record<string, unknown>;
  // 9Wickets sends session events (session_start / transfer / session_end), never bets: nothing to settle here —
  // coins move at launch and cash out (nineLaunch / nineCashout).
  if (p === "9w") { console.log("9w event:", n.event, n.session_id, n.action, n.after_amount); return { ok: true }; }
  const raw = Number(n.member_account);
  const member = raw >= MEMBER_OFFSET ? raw - MEMBER_OFFSET : raw;
  const rawBet = Number(n.bet_amount ?? 0);
  const rawWin = Number(n.win_amount ?? 0);
  const rawCredit = n.credit_amount != null ? Number(n.credit_amount) : null;

  // Convert the play currency (VND for JILI, INR for Matka) back to coins for the ledger
  const rate = RATE(p);
  const betCoins = rawBet / rate;
  const winCoins = rawWin / rate;
  const creditCoins = rawCredit != null ? rawCredit / rate : null;

  return rpc<Record<string, unknown>>("jili_settle", {
    p_serial: String(n.serial_number ?? ""),
    p_member: member,
    p_game_uid: n.game_uid != null ? String(n.game_uid) : n.game_id != null ? String(n.game_id) : null,
    p_game_name: n.game_name != null ? String(n.game_name) : null,
    p_round: n.game_round != null ? String(n.game_round) : null,
    p_bet: betCoins,
    p_win: winCoins,
    p_credit: creditCoins,
    p_label: p === "matka" ? "Matka" : "JILI", // the ledger note's game ("Matka • Bharat Matka • Round #…")
  });
}

// ------------------------------------------------------------------------------------------------- 9Wickets
// A transfer-wallet sportsbook (migration 121): coins go into the 9Wickets wallet at launch (balance > 0), the player
// bets inside, and what is left comes back at cash out (balance < 0, after an inquiry with balance 0). One open
// session per player; the SoftAPI wallet is per player (user_id), so a stray balance is picked up at the next cash out.
const NINE_UID = "11539";
interface NineReply { code?: number; msg?: string; data?: { url?: string; session_id?: number | string; after_amount?: number | string; before_amount?: number | string; action?: string } }

async function nineTransfer(num: number, balance: number, transferId: string): Promise<NineReply> {
  const site = process.env.JILI_SITE_URL ?? "https://www.khelobaazi.in";
  const payload = {
    user_id: String(num + MEMBER_OFFSET), balance: String(balance), game_uid: NINE_UID, symbol: "9W", token: TOKEN("9w"), timestamp: Date.now(),
    return: `${site}/`, callback: `${site}/api/jili/callback?k=${process.env.JILI_CALLBACK_KEY}&p=9w`, currency_code: "INR", language: "en", transfer_id: transferId,
  };
  const proxy = process.env.SOFTAPI_PROXY_URL ?? "https://srv2101978.hstgr.cloud/softapi";
  const r = await fetch(proxy, {
    method: "POST", headers: { "content-type": "application/json", "x-proxy-key": process.env.SOFTAPI_PROXY_KEY ?? "" },
    body: JSON.stringify({ token: TOKEN("9w"), payload: softEncrypt(payload, secret("9w")) }), cache: "no-store",
  });
  const j = (await r.json().catch(() => null)) as NineReply | null;
  if (!j) throw new Error("9Wickets did not answer — please try again");
  return j;
}

/** Most coins a session may take in: 9Wickets bills 13.5% of a session's loss from the GGR wallet. */
export async function nineCap(): Promise<number> {
  const r = await fetch(`${BASE()}/ggr-balance?token=${encodeURIComponent(TOKEN("9w"))}`, { cache: "no-store" });
  const j = (await r.json().catch(() => null)) as { data?: { wallet?: number } } | null;
  const usdt = Number(j?.data?.wallet ?? 0);
  return Math.floor((usdt * Number(process.env.SOFTAPI_INR_RATE ?? 88) / 0.135) * 0.95);
}

export interface NineSession { id: number; coins_in: number; coins_out: number | null; session_id: string | null; status: string; launched_at: string }
/** The player's open session, or null (PostgREST renders a function's empty composite result as a row of nulls). */
export async function nineOpen(userId: string): Promise<NineSession | null> {
  const r = await rpc<NineSession | null>("nw_open", { p_user: userId });
  return r && r.id != null ? r : null;
}

/** Move coins into 9Wickets and open the sportsbook. A session still open from before is cashed out first. */
export async function nineLaunch(userId: string, coins: number): Promise<{ url: string; session: number; coins: number }> {
  if (await nineOpen(userId)) await nineCashout(userId);
  const cap = await nineCap();
  if (cap < 10) throw new Error("9Wickets is resting for a moment — please try again later");
  if (coins > cap) throw new Error(`At most ${cap.toLocaleString("en-IN")} coins can go into 9Wickets right now`);
  const num = await rpc<number>("jili_player_num", { p_user: userId });
  const sid = await rpc<number>("nw_start", { p_user: userId, p_coins: coins });
  try {
    const j = await nineTransfer(num, coins, `in-${sid}`);
    if (j.code !== 0 || !j.data?.url) throw new Error(j.code === 1 ? "9Wickets is resting for a moment — please try again later" : j.msg || "9Wickets could not be opened");
    await rpc("nw_opened", { p_id: sid, p_session: j.data.session_id != null ? String(j.data.session_id) : null });
    return { url: j.data.url, session: sid, coins };
  } catch (e) {
    await rpc("nw_cancel", { p_id: sid, p_why: e instanceof Error ? e.message : String(e) }).catch(() => {});
    throw e;
  }
}

/** Bring the player's 9Wickets balance back to their coins and close the session. */
export async function nineCashout(userId: string): Promise<{ coins: number; balance: number | null; session: number | null }> {
  const open = await nineOpen(userId);
  const num = await rpc<number>("jili_player_num", { p_user: userId });
  const inq = await nineTransfer(num, 0, `inq-${Date.now()}`);
  if (inq.code !== 0) throw new Error(inq.msg || "9Wickets did not answer — please try again");
  const left = Math.floor(Number(inq.data?.after_amount ?? 0));
  let got = 0;
  if (left > 0) {
    const out = await nineTransfer(num, -left, `out-${open?.id ?? "x"}-${Date.now()}`);
    if (out.code !== 0) throw new Error(out.msg || "Cash out failed — please try again");
    got = left;
  }
  if (!open) {
    // No session of ours, but coins were sitting in the 9Wickets wallet (an earlier cash out that didn't finish).
    if (got > 0) await rpc("wallet_move", { p_uid: userId, p_amount: got, p_kind: "win", p_note: "9Wickets • Cash out" });
    return { coins: got, balance: null, session: null };
  }
  const balance = await rpc<number>("nw_close", { p_id: open.id, p_coins: got });
  return { coins: got, balance, session: open.id };
}

export interface NineBet { bet_id?: number; status: string; sport?: string; competition?: string; event?: string; market?: string; selection?: string; side?: string; odds?: number; stake?: number; profit_loss?: number | null; placed_at?: string; settled_at?: string }
/** The player's match bets (last 7 days, newest first) from SoftAPI. */
export async function nineBets(userId: string): Promise<NineBet[]> {
  const num = await rpc<number>("jili_player_num", { p_user: userId });
  const r = await fetch(`${BASE()}/9w/transactions?token=${encodeURIComponent(TOKEN("9w"))}&user_id=${num + MEMBER_OFFSET}&page_size=100`, { cache: "no-store" });
  const j = (await r.json().catch(() => null)) as { code?: number; data?: { records?: NineBet[] } } | null;
  return j?.code === 0 ? j.data?.records ?? [] : [];
}
