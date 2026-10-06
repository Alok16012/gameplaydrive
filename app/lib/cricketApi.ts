// Sports Exchange API Client & Data Models (Cricket, Tennis, Football/Soccer)

export type SportType = "cricket" | "tennis" | "soccer";

export interface CricketMatch {
  marketId: string | null;
  eventId: string;
  gameId?: string;
  eventName: string;
  eventTime: string;
  seriesName: string;
  scoreBoardId: string | null;
  inPlay: boolean;
  isLive: boolean;
  hasFancy: boolean;
  hasBookmaker: boolean;
  status: "OPEN" | "INPLAY" | "UPCOMING" | "CLOSED";
  sport: SportType;
  team1: { name: string; short: string; score?: string; overs?: string };
  team2: { name: string; short: string; score?: string; overs?: string };
  back1?: number;
  lay1?: number;
  back2?: number;
  lay2?: number;
  isRealApi?: boolean;
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
  size?: number;
  stake: number;
  profit: number;
  exposure: number;
  status: "OPEN" | "WON" | "LOST" | "VOID";
  placedAt: string;
  sport?: SportType;
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

function parseMatchesList(rawList: any[], sport: SportType, isReal = false): CricketMatch[] {
  return rawList.map((m: any) => {
    let t1 = m.team1;
    let t2 = m.team2;
    if (!t1 || !t2) {
      const parts = (m.eventName || "").split(/ v | vs | VS /i);
      const name1 = parts[0]?.trim() || m.runnerName1 || "Team 1";
      const name2 = parts[1]?.trim() || m.runnerName2 || "Team 2";
      t1 = { name: name1, short: name1.slice(0, 3).toUpperCase() };
      t2 = { name: name2, short: name2.slice(0, 3).toUpperCase() };
    }

    const isLiveMatch = Boolean(
      m.inPlay === true ||
      m.inPlay === "true" ||
      m.isLive === true ||
      m.status === "INPLAY" ||
      (m.scoreBoardId && m.inPlay !== false)
    );

    const b1 = Number(m.back1 || m.b1 || 1.85);
    const l1 = Number(m.lay1 || m.l1 || 1.89);
    const b2 = Number(m.back2 || m.b2 || (b1 > 0 ? (b1 > 2 ? 1.55 : 2.05) : 2.05));
    const l2 = Number(m.lay2 || m.l2 || (b2 + 0.05));

    return {
      marketId: m.marketId || m.market_id || null,
      eventId: String(m.eventId || m.gameId || m.id),
      gameId: String(m.gameId || m.eventId || m.id),
      eventName: m.eventName || m.event_name || `${t1.name} v ${t2.name}`,
      eventTime: m.eventTime || m.event_time || new Date().toISOString(),
      seriesName: m.seriesName || m.series_name || "Tournament",
      scoreBoardId: m.scoreBoardId || null,
      inPlay: isLiveMatch,
      isLive: isLiveMatch,
      hasFancy: Boolean(m.hasFancy ?? m.f ?? true),
      hasBookmaker: Boolean(m.hasBookmaker ?? m.bm ?? true),
      status: isLiveMatch ? "INPLAY" : "UPCOMING",
      sport: (m.sport || sport) as SportType,
      team1: t1,
      team2: t2,
      back1: b1 > 0 ? b1 : 1.85,
      lay1: l1 > 0 ? l1 : 1.89,
      back2: b2 > 0 ? b2 : 2.05,
      lay2: l2 > 0 ? l2 : 2.12,
      isRealApi: isReal,
    };
  });
}

// Fetch matches list for specific sport (cricket, tennis, soccer) via backend proxy
export async function fetchCricketMatches(sport: SportType = "cricket"): Promise<CricketMatch[]> {
  try {
    const res = await fetch(`/api/sports/matches?sport=${encodeURIComponent(sport)}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const json = await res.json();
      const rawList = json?.data || [];
      if (Array.isArray(rawList) && rawList.length > 0) {
        return parseMatchesList(rawList, sport, json?.source === "diamondexch_live");
      }
    }
  } catch (err) {
    console.error("Error fetching sports matches from backend proxy:", err);
  }

  return [];
}

// Fetch live odds for event (Served through server cache: 500ms live, 2s upcoming)
export async function fetchCricketOdds(
  eventId: string,
  sport: SportType = "cricket",
  isLive = true,
  team1 = "",
  team2 = ""
): Promise<CricketOddsResponse> {
  const sportName = sport === "soccer" ? "soccer" : sport;

  try {
    const res = await fetch(
      `/api/cricket/odds?eventId=${encodeURIComponent(eventId)}&sport=${encodeURIComponent(sportName)}&live=${isLive}&team1=${encodeURIComponent(team1)}&team2=${encodeURIComponent(team2)}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error("Failed to fetch odds");
    const json = await res.json();
    const data = json?.data || {};

    const matchOdds = Array.isArray(data.matchOdds) ? data.matchOdds : (data.match_odds ? [data.match_odds] : []);
    const bookMakerOdds = Array.isArray(data.bookMakerOdds)
      ? data.bookMakerOdds.map((b: any) => b.bm1 || b)
      : [];
    const fancyOdds = Array.isArray(data.fancyOdds) ? data.fancyOdds : [];

    return { matchOdds, bookMakerOdds, fancyOdds };
  } catch (err) {
    console.error("Error fetching sports odds:", err);
    return { matchOdds: [], bookMakerOdds: [], fancyOdds: [] };
  }
}

// Fetch Fancy Results (Cached for 1 minute on server)
export async function fetchFancyResults(eventId: string, sport: SportType = "cricket"): Promise<any[]> {
  try {
    const res = await fetch(`/api/cricket/fancy-results?eventId=${encodeURIComponent(eventId)}&sport=${encodeURIComponent(sport)}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
  }
}

// Fetch Betfair & Bookmaker Results (Cached for 5 minutes on server)
export async function fetchMatchResults(eventId: string, sport: SportType = "cricket"): Promise<any[]> {
  try {
    const res = await fetch(`/api/cricket/results?eventId=${encodeURIComponent(eventId)}&sport=${encodeURIComponent(sport)}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
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
