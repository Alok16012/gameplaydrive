// Cricket Exchange API Client & Data Models

export interface CricketMatch {
  marketId: string | null;
  eventId: string;
  eventName: string;
  eventTime: string;
  seriesName: string;
  scoreBoardId: string | null;
  isLive: boolean;
  hasFancy: boolean;
  hasBookmaker: boolean;
  status: "OPEN" | "INPLAY" | "UPCOMING" | "CLOSED";
  team1: { name: string; short: string; score?: string; overs?: string };
  team2: { name: string; short: string; score?: string; overs?: string };
  back1?: number;
  lay1?: number;
  back2?: number;
  lay2?: number;
}

export interface RunnerOdd {
  sid: string | number;
  rname: string;
  status: string;
  b1?: string;
  bs1?: string;
  b2?: string;
  bs2?: string;
  b3?: string;
  bs3?: string;
  l1?: string;
  ls1?: string;
  l2?: string;
  ls2?: string;
  l3?: string;
  ls3?: string;
  min?: number;
  max?: number;
}

export interface MarketOdds {
  mid: string | number;
  mname: string;
  status: string;
  min?: number;
  max?: number;
  gtype?: string;
  oddDatas: RunnerOdd[];
}

export interface CricketOddsResponse {
  matchOdds: MarketOdds[];
  bookMakerOdds: MarketOdds[];
  fancyOdds: MarketOdds[];
}

export interface CricketBet {
  id: string;
  eventId: string;
  eventName: string;
  marketType: "MATCH_ODDS" | "BOOKMAKER" | "FANCY";
  marketName: string;
  runnerName: string;
  betType: "BACK" | "LAY";
  odds: number;
  size?: number; // For fancy runs (e.g. 48 runs)
  stake: number;
  profit: number;
  exposure: number;
  status: "OPEN" | "WON" | "LOST" | "VOID";
  placedAt: string;
}

export interface CricketScorecard {
  team1: string;
  team2: string;
  battingTeam: string;
  runs: number;
  wickets: number;
  overs: string;
  target?: number;
  crr: string;
  rrr?: string;
  batsmen: Array<{ name: string; runs: number; balls: number; fours: number; sixes: number; strikeRate: string }>;
  bowler: { name: string; overs: string; maidens: number; runs: number; wickets: number; econ: string };
  recentBalls: string[];
  lastWicket?: string;
}

// Fetch matches list
export async function fetchCricketMatches(): Promise<CricketMatch[]> {
  try {
    const res = await fetch("/api/cricket/matches");
    if (!res.ok) throw new Error("Failed to fetch matches");
    const json = await res.json();
    const rawList = json?.data || [];
    
    // Normalize in case diamondexch raw structure comes
    return rawList.map((m: any) => {
      let t1 = m.team1;
      let t2 = m.team2;
      if (!t1 || !t2) {
        const parts = (m.eventName || "").split(/ v | vs | VS /i);
        t1 = { name: parts[0]?.trim() || "Team 1", short: parts[0]?.slice(0, 3).toUpperCase() || "T1" };
        t2 = { name: parts[1]?.trim() || "Team 2", short: parts[1]?.slice(0, 3).toUpperCase() || "T2" };
      }
      return {
        marketId: m.marketId || m.market_id || null,
        eventId: String(m.eventId || m.event_id || m.id),
        eventName: m.eventName || m.event_name || `${t1.name} vs ${t2.name}`,
        eventTime: m.eventTime || m.event_time || new Date().toISOString(),
        seriesName: m.seriesName || m.series_name || "Cricket Tournament",
        scoreBoardId: m.scoreBoardId || null,
        isLive: Boolean(m.isLive ?? m.is_live ?? (m.status === "INPLAY")),
        hasFancy: Boolean(m.hasFancy ?? m.has_fancy ?? true),
        hasBookmaker: Boolean(m.hasBookmaker ?? m.has_bookmaker ?? true),
        status: m.status || (m.isLive ? "INPLAY" : "UPCOMING"),
        team1: t1,
        team2: t2,
        back1: Number(m.back1 || 1.65),
        lay1: Number(m.lay1 || 1.68),
        back2: Number(m.back2 || 2.45),
        lay2: Number(m.lay2 || 2.52),
      };
    });
  } catch (err) {
    console.error("Error fetching cricket matches:", err);
    return [];
  }
}

// Fetch live odds for event
export async function fetchCricketOdds(eventId: string): Promise<CricketOddsResponse> {
  try {
    const res = await fetch(`/api/cricket/odds?eventId=${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error("Failed to fetch odds");
    const json = await res.json();
    const data = json?.data || {};

    // Standardize structure
    const matchOdds = Array.isArray(data.matchOdds) ? data.matchOdds : (data.match_odds ? [data.match_odds] : []);
    const bookMakerOdds = Array.isArray(data.bookMakerOdds)
      ? data.bookMakerOdds.map((b: any) => b.bm1 || b)
      : [];
    const fancyOdds = Array.isArray(data.fancyOdds) ? data.fancyOdds : [];

    return { matchOdds, bookMakerOdds, fancyOdds };
  } catch (err) {
    console.error("Error fetching cricket odds:", err);
    return { matchOdds: [], bookMakerOdds: [], fancyOdds: [] };
  }
}

// Fetch scorecard
export async function fetchCricketScorecard(eventId: string): Promise<CricketScorecard | null> {
  try {
    const res = await fetch(`/api/cricket/scorecard?eventId=${encodeURIComponent(eventId)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.score || null;
  } catch (err) {
    return null;
  }
}

// Local storage for bets
const BETS_STORAGE_KEY = "khelobaazi_cricket_bets";

export function loadStoredBets(): CricketBet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(BETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveStoredBet(bet: CricketBet): CricketBet[] {
  if (typeof window === "undefined") return [];
  try {
    const existing = loadStoredBets();
    const updated = [bet, ...existing].slice(0, 50);
    localStorage.setItem(BETS_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}
