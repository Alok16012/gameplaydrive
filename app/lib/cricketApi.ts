// Cricket exchange client: matches and Match Winner odds from The Odds API (through app/api/sports/matches and
// app/api/cricket/odds), bets through Supabase. Every price shown comes from the API — nothing is made up; a
// price the API doesn't have (or a suspended market) is "-".

import { supabase } from "./supabase";

export type SportType = "cricket";
export type Price = number | "-";

export interface CricketMatch {
  eventId: string;
  eventName: string;
  eventTime: string;
  seriesName: string;
  inPlay: boolean;
  sport: SportType;
  team1: { name: string; short: string };
  team2: { name: string; short: string };
  back1: Price;
  lay1: Price;
  back2: Price;
  lay2: Price;
  drawBack?: Price;
  drawLay?: Price;
}

export interface RunnerOdd {
  sid: string;
  rname: string;
  status: string;
  b1: string;
  l1: string;
}

export interface MarketOdds {
  mid: string;
  mname: string;
  status: string;
  oddDatas: RunnerOdd[];
}

export interface CricketOddsResponse {
  matchOdds: MarketOdds | null;
  /** When the server last pulled odds from the API (ms), or null if it never has. */
  updatedAt: number | null;
  message?: string;
}

export interface CricketBet {
  id: string;
  eventId: string;
  eventName: string;
  marketType: "MATCH_ODDS" | "BOOKMAKER" | "FANCY" | "TIE" | "TOSS";
  marketName: string;
  runnerName: string;
  betType: "BACK" | "LAY";
  odds: number;
  size?: number;
  stake: number;
  profit: number;
  exposure: number;
  status: "OPEN" | "WON" | "LOST" | "VOID";
  placedAt: string;
  sport?: SportType;
  result?: string;
  payout?: number;
}

const price = (x: unknown): Price => (typeof x === "number" && x > 1 ? x : "-");

/** Cricket matches with their Match Winner odds. `message` explains an empty list (e.g. API key not set). */
export async function fetchCricketMatches(): Promise<{ matches: CricketMatch[]; updatedAt: number | null; message?: string }> {
  try {
    const res = await fetch(`/api/sports/matches?_t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return { matches: [], updatedAt: null, message: `Server error ${res.status}` };
    const json = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches = (Array.isArray(json?.data) ? json.data : []).map((m: any): CricketMatch => ({
      eventId: String(m.eventId),
      eventName: m.eventName,
      eventTime: m.eventTime,
      seriesName: m.seriesName,
      inPlay: !!m.inPlay,
      sport: "cricket",
      team1: m.team1,
      team2: m.team2,
      back1: price(m.back1),
      lay1: price(m.lay1),
      back2: price(m.back2),
      lay2: price(m.lay2),
      drawBack: m.drawBack === undefined ? undefined : price(m.drawBack),
      drawLay: m.drawLay === undefined ? undefined : price(m.drawLay),
    }));
    return { matches, updatedAt: json?.updatedAt ?? null, message: json?.message };
  } catch {
    return { matches: [], updatedAt: null, message: "Could not reach the server" };
  }
}

/** Match Winner odds of one match. */
export async function fetchCricketOdds(eventId: string): Promise<CricketOddsResponse> {
  try {
    const res = await fetch(`/api/cricket/odds?eventId=${encodeURIComponent(eventId)}`, { cache: "no-store" });
    if (!res.ok) return { matchOdds: null, updatedAt: null, message: `Server error ${res.status}` };
    const json = await res.json();
    return { matchOdds: json?.data?.matchOdds ?? null, updatedAt: json?.updatedAt ?? null, message: json?.message };
  } catch {
    return { matchOdds: null, updatedAt: null, message: "Could not reach the server" };
  }
}

// Bets live in the sport_bets table: placed through place_sport_bet, settled by the Super Admin's declared result.
export interface SportBetRow {
  id: number;
  user_id: string;
  sport: string;
  event_id: string;
  event_name: string;
  market_type: CricketBet["marketType"];
  market_name: string;
  runner_name: string;
  bet_type: "BACK" | "LAY";
  odds: number;
  line: number | null;
  stake: number;
  exposure: number;
  profit: number;
  status: CricketBet["status"];
  result: string | null;
  payout: number;
  created_at: string;
  settled_at: string | null;
}

export function rowToBet(r: SportBetRow): CricketBet {
  return {
    id: String(r.id),
    eventId: r.event_id,
    eventName: r.event_name,
    marketType: r.market_type,
    marketName: r.market_name,
    runnerName: r.runner_name,
    betType: r.bet_type,
    odds: Number(r.odds),
    size: r.line ?? undefined,
    stake: Number(r.stake),
    profit: Number(r.profit),
    exposure: Number(r.exposure),
    status: r.status,
    placedAt: new Date(r.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    sport: r.sport as SportType,
    result: r.result ?? undefined,
    payout: Number(r.payout),
  };
}

export async function fetchMyBets(): Promise<CricketBet[]> {
  const sb = supabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return [];
  const { data, error } = await sb
    .from("sport_bets")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as SportBetRow[]).map(rowToBet);
}

export async function placeSportBet(bet: {
  sport: SportType;
  eventId: string;
  eventName: string;
  marketType: CricketBet["marketType"];
  marketName: string;
  runnerName: string;
  betType: "BACK" | "LAY";
  odds: number;
  line?: number;
  stake: number;
}): Promise<{ id: number; balance: number; exposure: number; profit: number }> {
  const { data, error } = await supabase().rpc("place_sport_bet", {
    p_sport: bet.sport,
    p_event_id: bet.eventId,
    p_event_name: bet.eventName,
    p_market_type: bet.marketType,
    p_market_name: bet.marketName,
    p_runner_name: bet.runnerName,
    p_bet_type: bet.betType,
    p_odds: bet.odds,
    p_line: bet.line ?? null,
    p_stake: bet.stake,
  });
  if (error) throw error;
  return data;
}
