// Cricket odds from The Odds API (https://the-odds-api.com), server-only. Import from route handlers only.
//
// The API gives the Match Winner (h2h) price of each bookmaker; we show the median of them as the Back price and a
// slightly higher Lay. Every odds pull costs request credits (1 per active cricket competition), so one pull is
// shared by all players through the odds_cache table (supabase/migrations/039_odds_api.sql) and the refresh interval
// is stretched to make the remaining credits last until the end of the month.
// The key comes from the ODDS_API_KEY env var, or the 'odds_api_key' row of private_settings.

import { selectOne, upsertRow } from "./supabaseAdmin";

const BASE = "https://api.the-odds-api.com/v4";
const MIN_TTL = 5 * 60_000;
const MAX_TTL = 6 * 3600_000;
const RESERVE = 10; // credits kept back for the last days of the month
/** In-play odds older than this are suspended: the match has moved on since the last pull. */
export const LIVE_STALE_MS = 10 * 60_000;

export interface OddsRunner { name: string; back: number; lay: number }
export interface OddsEvent {
  id: string; home: string; away: string; commence: string; series: string; books: number; runners: OddsRunner[];
}
/** fetchedAt: when these odds were pulled; nextAt: when to pull again. */
interface Feed { events: OddsEvent[]; fetchedAt: number; nextAt: number; remaining: number | null; error?: string }

let mem: Feed | null = null;
let inflight: Promise<Feed> | null = null;

async function apiKey(): Promise<string | null> {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY;
  try {
    const row = await selectOne<{ value: unknown }>("private_settings", "key=eq.odds_api_key&select=value");
    return typeof row?.value === "string" && row.value ? row.value : null;
  } catch {
    return null;
  }
}

async function readCache(): Promise<Feed | null> {
  try {
    const row = await selectOne<{ data: Feed }>("odds_cache", "key=eq.cricket&select=data");
    return row?.data ?? null;
  } catch {
    return null; // table not created yet: the in-memory copy is used instead
  }
}

async function writeCache(feed: Feed) {
  try {
    await upsertRow("odds_cache", { key: "cricket", data: feed, fetched_at: new Date(feed.fetchedAt).toISOString() });
  } catch { /* table not created yet */ }
}

/** How long one pull should last so that `remaining` credits reach the end of the month. */
function ttlFor(remaining: number | null, perPull: number) {
  if (remaining === null) return 30 * 60_000;
  const now = new Date();
  const left = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime();
  const pulls = Math.floor((remaining - RESERVE) / Math.max(1, perPull));
  if (pulls <= 0) return MAX_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, left / pulls));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const layOf = (back: number) => Math.ceil(Math.max(back + 0.01, back * 1.02) * 100) / 100;

async function pull(key: string, prev: Feed | null): Promise<Feed> {
  const sports = await fetch(`${BASE}/sports?apiKey=${key}`, { cache: "no-store", signal: AbortSignal.timeout(10000) }); // free call
  if (!sports.ok) throw new Error(`Odds API ${sports.status}`);
  const active = ((await sports.json()) as { key: string; active: boolean; has_outrights: boolean }[])
    .filter((s) => s.key.startsWith("cricket_") && s.active && !s.has_outrights)
    .map((s) => s.key);

  let remaining: number | null = prev?.remaining ?? null;
  if (remaining !== null && remaining - RESERVE < active.length) {
    // Out of credits for this month: keep serving the last pull.
    return { events: prev?.events ?? [], fetchedAt: prev?.fetchedAt ?? 0, nextAt: Date.now() + MAX_TTL, remaining, error: "Odds API monthly quota used up" };
  }

  const events: OddsEvent[] = [];
  for (const sport of active) {
    const res = await fetch(`${BASE}/sports/${sport}/odds?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const left = res.headers.get("x-requests-remaining");
    if (left !== null) remaining = Number(left);
    if (!res.ok) throw new Error(`Odds API ${res.status} for ${sport}`);
    type Raw = {
      id: string; sport_title: string; commence_time: string; home_team: string; away_team: string;
      bookmakers: { markets: { key: string; outcomes: { name: string; price: number }[] }[] }[];
    };
    for (const e of (await res.json()) as Raw[]) {
      const prices = new Map<string, number[]>();
      for (const b of e.bookmakers) {
        for (const o of b.markets.find((m) => m.key === "h2h")?.outcomes ?? []) {
          if (o.price > 1) prices.set(o.name, [...(prices.get(o.name) ?? []), o.price]);
        }
      }
      const order = [e.home_team, e.away_team, ...[...prices.keys()].filter((n) => n !== e.home_team && n !== e.away_team)];
      const runners = order.filter((n) => prices.has(n)).map((name) => {
        const back = r2(median(prices.get(name)!));
        return { name, back, lay: layOf(back) };
      });
      events.push({ id: e.id, home: e.home_team, away: e.away_team, commence: e.commence_time, series: e.sport_title, books: e.bookmakers.length, runners });
    }
  }
  events.sort((a, b) => a.commence.localeCompare(b.commence));
  return { events, fetchedAt: Date.now(), nextAt: Date.now() + ttlFor(remaining, active.length), remaining };
}

/** The current cricket odds: from the shared cache while it is fresh, otherwise pulled again (once at a time). */
export async function cricketFeed(): Promise<Feed> {
  const stored = await readCache();
  const cached = mem && (!stored || mem.nextAt > stored.nextAt) ? mem : stored; // memory may hold a newer retry time
  if (cached && Date.now() < cached.nextAt) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const key = await apiKey();
      if (!key) return (mem = { events: [], fetchedAt: 0, nextAt: Date.now() + 60_000, remaining: null, error: "Odds API key not set" });
      const feed = await pull(key, cached);
      mem = feed;
      await writeCache(feed);
      return feed;
    } catch (err) {
      // Upstream down: keep the last odds (they go on ageing, so in-play ones get suspended) and retry in a few minutes.
      return (mem = { events: cached?.events ?? [], fetchedAt: cached?.fetchedAt ?? 0, nextAt: Date.now() + MIN_TTL, remaining: cached?.remaining ?? null, error: String(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const short = (name: string) => {
  const w = name.split(/\s+/).filter(Boolean);
  return w.length > 1 ? w.map((x) => x[0]).join("").slice(0, 4).toUpperCase() : name.slice(0, 3).toUpperCase();
};

/** Is betting on this event's odds closed right now (in play, and the odds are older than LIVE_STALE_MS)? */
export const suspended = (e: OddsEvent, feed: Feed) => Date.parse(e.commence) <= Date.now() && Date.now() - feed.fetchedAt > LIVE_STALE_MS;

const listPrice = (x: number | undefined, off: boolean) => (x === undefined || off ? "-" : x);

/** One row of /api/sports/matches, in the shape app/lib/cricketApi.ts parses. */
export function toMatch(e: OddsEvent, feed: Feed) {
  const off = suspended(e, feed);
  const [r1, r2, draw] = [e.runners.find((r) => r.name === e.home), e.runners.find((r) => r.name === e.away), e.runners.find((r) => r.name === "Draw")];
  const live = Date.parse(e.commence) <= Date.now();
  return {
    eventId: e.id, gameId: e.id, marketId: "", sport: "cricket",
    eventName: `${e.home} v ${e.away}`, eventTime: e.commence, seriesName: e.series,
    inPlay: live, status: live ? "INPLAY" : "UPCOMING", tv: false, bm: false, f: false,
    team1: { name: e.home, short: short(e.home) }, team2: { name: e.away, short: short(e.away) },
    back1: listPrice(r1?.back, off), lay1: listPrice(r1?.lay, off),
    back2: listPrice(r2?.back, off), lay2: listPrice(r2?.lay, off),
    drawBack: draw ? listPrice(draw.back, off) : undefined, drawLay: draw ? listPrice(draw.lay, off) : undefined,
  };
}

/** The Match Odds market for /api/cricket/odds. */
export function toMatchOdds(e: OddsEvent, feed: Feed) {
  const status = suspended(e, feed) ? "SUSPENDED" : "ACTIVE";
  return {
    mid: `mo.${e.id}`,
    mname: "MATCH_ODDS",
    status,
    oddDatas: e.runners.map((r, i) => ({
      sid: String(i + 1),
      rname: r.name === "Draw" ? "The Draw" : r.name,
      status,
      b1: r.back.toFixed(2),
      bs1: "",
      l1: r.lay.toFixed(2),
      ls1: "",
    })),
  };
}
