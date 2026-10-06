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

    const hash = Math.abs([...String(m.eventId || m.gameId || m.id || "1")].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7));
    const baseBack1 = Number(m.back1 || m.b1 || (1.35 + ((hash % 120) / 100)));
    const b1 = Number(baseBack1.toFixed(2));
    const l1 = Number((b1 + 0.02 + (hash % 3) * 0.01).toFixed(2));
    
    // Fair implied probability for Runner 2
    const p1 = 1 / b1;
    const p2 = sport === "soccer" ? Math.max(0.18, 0.70 - (p1 * 0.65)) : Math.max(0.15, Math.min(0.85, 1.05 - p1));
    const b2 = Number((1 / p2).toFixed(2));
    const l2 = Number((b2 + 0.03 + (hash % 4) * 0.01).toFixed(2));

    // Draw for Soccer
    const drawBack = sport === "soccer" ? Number((3.10 + ((hash % 8) * 0.10)).toFixed(2)) : undefined;
    const drawLay = drawBack ? Number((drawBack + 0.08).toFixed(2)) : undefined;

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
      drawBack,
      drawLay,
      isRealApi: isReal,
    };
  });
}

// Model for 3-Level Depth Exchange Ladder (B3, B2, B1 | L1, L2, L3)
export function getMatchDepthOdds(
  match: CricketMatch,
  tickOffset = 0
): {
  matchOdds: MarketOdds[];
  bookMakerOdds: MarketOdds[];
  fancyOdds: MarketOdds[];
} {
  const hash = Math.abs([...match.eventId].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 11));
  const drift = match.inPlay ? (Math.sin(tickOffset * 0.8 + (hash % 10)) * 0.04) : 0;
  
  const b1 = Math.max(1.05, Number(((match.back1 || 1.85) + drift).toFixed(2)));
  const l1 = Number((b1 + 0.02 + ((hash + tickOffset) % 2) * 0.01).toFixed(2));
  const b2_lvl = Number((b1 - 0.02).toFixed(2));
  const b3_lvl = Number((b1 - 0.04).toFixed(2));
  const l2_lvl = Number((l1 + 0.02).toFixed(2));
  const l3_lvl = Number((l1 + 0.04).toFixed(2));

  // Runner 2
  const p1 = 1 / b1;
  const p2 = match.sport === "soccer" ? Math.max(0.18, 0.70 - (p1 * 0.65)) : Math.max(0.15, Math.min(0.85, 1.05 - p1));
  const r2_b1 = Math.max(1.05, Number(((1 / p2) - drift).toFixed(2)));
  const r2_l1 = Number((r2_b1 + 0.03).toFixed(2));
  const r2_b2 = Number((r2_b1 - 0.02).toFixed(2));
  const r2_b3 = Number((r2_b1 - 0.04).toFixed(2));
  const r2_l2 = Number((r2_l1 + 0.02).toFixed(2));
  const r2_l3 = Number((r2_l1 + 0.04).toFixed(2));

  const runner1: RunnerOdd = {
    sid: "1",
    rname: match.team1.name,
    status: "ACTIVE",
    b1: b1.toFixed(2),
    bs1: `${(1.2 + ((hash + tickOffset) % 5) * 0.3).toFixed(1)}L`,
    b2: b2_lvl.toFixed(2),
    bs2: `${(2.5 + ((hash + tickOffset) % 4) * 0.5).toFixed(1)}L`,
    b3: b3_lvl.toFixed(2),
    bs3: `${(4.0 + ((hash + tickOffset) % 6) * 0.8).toFixed(1)}L`,
    l1: l1.toFixed(2),
    ls1: `${(1.0 + ((hash + tickOffset) % 3) * 0.2).toFixed(1)}L`,
    l2: l2_lvl.toFixed(2),
    ls2: `${(2.2 + ((hash + tickOffset) % 5) * 0.4).toFixed(1)}L`,
    l3: l3_lvl.toFixed(2),
    ls3: `${(5.5 + ((hash + tickOffset) % 7) * 0.9).toFixed(1)}L`,
  };

  const runner2: RunnerOdd = {
    sid: "2",
    rname: match.team2.name,
    status: "ACTIVE",
    b1: r2_b1.toFixed(2),
    bs1: `${(90 + ((hash + tickOffset) % 40))}K`,
    b2: r2_b2.toFixed(2),
    bs2: `${(1.8 + ((hash + tickOffset) % 3) * 0.4).toFixed(1)}L`,
    b3: r2_b3.toFixed(2),
    bs3: `${(3.5 + ((hash + tickOffset) % 5) * 0.6).toFixed(1)}L`,
    l1: r2_l1.toFixed(2),
    ls1: `${(110 + ((hash + tickOffset) % 30))}K`,
    l2: r2_l2.toFixed(2),
    ls2: `${(2.0 + ((hash + tickOffset) % 4) * 0.3).toFixed(1)}L`,
    l3: r2_l3.toFixed(2),
    ls3: `${(4.8 + ((hash + tickOffset) % 6) * 0.7).toFixed(1)}L`,
  };

  const runners = [runner1];

  // Draw for Soccer
  if (match.sport === "soccer") {
    const dB1 = Number((3.20 + ((hash % 6) * 0.1) + drift * 0.5).toFixed(2));
    const dL1 = Number((dB1 + 0.08).toFixed(2));
    runners.push({
      sid: "draw",
      rname: "The Draw",
      status: "ACTIVE",
      b1: dB1.toFixed(2),
      bs1: `${(65 + ((hash + tickOffset) % 25))}K`,
      b2: (dB1 - 0.05).toFixed(2),
      bs2: "1.2L",
      b3: (dB1 - 0.10).toFixed(2),
      bs3: "2.5L",
      l1: dL1.toFixed(2),
      ls1: `${(80 + ((hash + tickOffset) % 30))}K`,
      l2: (dL1 + 0.05).toFixed(2),
      ls2: "1.5L",
      l3: (dL1 + 0.10).toFixed(2),
      ls3: "3.2L",
    });
  }

  runners.push(runner2);

  // Bookmaker odds (0-100 format)
  const bm1_back = Math.max(10, Math.min(190, Math.round((b1 - 1) * 100)));
  const bm1_lay = bm1_back + 2;
  const bm2_back = Math.max(10, Math.min(190, Math.round((r2_b1 - 1) * 100)));
  const bm2_lay = bm2_back + 3;

  const bookMakerOdds: MarketOdds[] = [
    {
      mid: `bm.${match.eventId}`,
      mname: "BOOKMAKER",
      status: "ACTIVE",
      oddDatas: [
        { sid: "bm1", rname: match.team1.name, status: "ACTIVE", b1: String(bm1_back), bs1: "100K", l1: String(bm1_lay), ls1: "100K" },
        { sid: "bm2", rname: match.team2.name, status: "ACTIVE", b1: String(bm2_back), bs1: "100K", l1: String(bm2_lay), ls1: "100K" },
      ],
    },
  ];

  // Fancy session markets with live ball-by-ball shifting
  const runShift = Math.floor(drift * 20);
  const sixRuns = Math.max(30, 48 + (hash % 12) + runShift);
  const tenRuns = Math.max(65, 84 + (hash % 18) + runShift * 2);
  const fifteenRuns = Math.max(110, 132 + (hash % 24) + runShift * 3);
  const sixes = Math.max(6, 13 + (hash % 6));
  const nextWicket = Math.max(80, 175 + (hash % 30) + runShift * 4);

  const fancyOdds: MarketOdds[] = [
    {
      mid: `f.${match.eventId}`,
      mname: "FANCY",
      status: "ACTIVE",
      oddDatas: [
        { sid: "101", rname: `6 Over Runs ${match.team1.short || "T1"}`, b1: String(sixRuns), bs1: "100", l1: String(sixRuns - 2), ls1: "100", status: "ACTIVE" },
        { sid: "102", rname: `10 Over Runs ${match.team1.short || "T1"}`, b1: String(tenRuns), bs1: "100", l1: String(tenRuns - 2), ls1: "100", status: "ACTIVE" },
        { sid: "103", rname: `15 Over Runs ${match.team1.short || "T1"}`, b1: String(fifteenRuns), bs1: "100", l1: String(fifteenRuns - 3), ls1: "100", status: "ACTIVE" },
        { sid: "104", rname: "Total Match Sixes", b1: String(sixes + 1), bs1: "100", l1: String(sixes), ls1: "100", status: "ACTIVE" },
        { sid: "105", rname: "Fall of Next Wicket", b1: String(nextWicket), bs1: "100", l1: String(nextWicket - 5), ls1: "100", status: "ACTIVE" },
      ],
    },
  ];

  return {
    matchOdds: [{ mid: `mo.${match.eventId}`, mname: "MATCH_ODDS", status: "ACTIVE", oddDatas: runners }],
    bookMakerOdds,
    fancyOdds,
  };
}

// Fetch matches list for specific sport (cricket, tennis, soccer) via backend proxy
export async function fetchCricketMatches(sport: SportType = "cricket"): Promise<CricketMatch[]> {
  try {
    const res = await fetch(`/api/sports/matches?sport=${encodeURIComponent(sport)}&_t=${Date.now()}`, {
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
