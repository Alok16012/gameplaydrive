import { NextRequest, NextResponse } from "next/server";

export interface SportMatchItem {
  gameId: string;
  marketId: string | null;
  eventId: string;
  eventName: string;
  eventTime: string;
  seriesId?: string;
  seriesName: string;
  scoreBoardId: string | null;
  inPlay: boolean;
  tv?: string | null;
  back1?: number;
  lay1?: number;
  back2?: number;
  lay2?: number;
  sport: "cricket" | "tennis" | "soccer";
  team1: { name: string; short: string; score?: string; overs?: string };
  team2: { name: string; short: string; score?: string; overs?: string };
}

// Generate dynamic current dates so timestamps are always fresh today/tomorrow
function getFreshDate(minutesOffset: number): string {
  return new Date(Date.now() + minutesOffset * 60 * 1000).toISOString();
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();
  const sportName = sportParam === "football" ? "soccer" : sportParam; // 'cricket' | 'tennis' | 'soccer'

  const apiKey = process.env.DIAMONDEXCH_API_KEY || process.env.CRICKET_API_KEY;
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";
  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";

  let railwayError: string | null = null;

  // 1. Attempt via Railway Proxy first (if deployed with static/whitelisted IP)
  try {
    const railwayRes = await fetch(`${railwayHost}/api/sports/matches?sport=${sportName}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (railwayRes.ok) {
      const json = await railwayRes.json();
      const rawMatches = Array.isArray(json?.data?.data)
        ? json.data.data
        : (Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []));

      if (rawMatches.length > 0) {
        const parsed = rawMatches.map((m: any) => {
          const parts = (m.eventName || "").split(/ v | vs | VS /i);
          const t1 = parts[0]?.trim() || "Team 1";
          const t2 = parts[1]?.trim() || "Team 2";
          const isLive = Boolean(m.inPlay === true || m.inPlay === "true" || m.isLive === true || m.status === "INPLAY");
          return {
            gameId: String(m.gameId || m.eventId || m.id),
            marketId: m.marketId || null,
            eventId: String(m.eventId || m.gameId || m.id),
            eventName: m.eventName || `${t1} v ${t2}`,
            eventTime: m.eventTime || new Date().toISOString(),
            seriesId: m.seriesId || undefined,
            seriesName: m.seriesName || "Tournament",
            scoreBoardId: m.scoreBoardId || null,
            inPlay: isLive,
            tv: m.tv || null,
            back1: Number(m.back1 || m.b1 || 1.85),
            lay1: Number(m.lay1 || m.l1 || 1.89),
            back2: Number(m.back2 || m.b2 || 2.05),
            lay2: Number(m.lay2 || m.l2 || 2.12),
            sport: sportName,
            team1: { name: t1, short: t1.slice(0, 3).toUpperCase() },
            team2: { name: t2, short: t2.slice(0, 3).toUpperCase() },
          };
        });

        return NextResponse.json({
          success: true,
          source: "railway_diamondexch_live",
          sport: sportName,
          data: parsed,
        });
      } else {
        railwayError = `Railway returned non-array or empty: ${JSON.stringify(json).slice(0, 200)}`;
      }
    } else {
      railwayError = `Railway HTTP status: ${railwayRes.status}`;
    }
  } catch (err: any) {
    railwayError = `Railway fetch error: ${err?.message}`;
  }

  // 2. Attempt direct DiamondExch API call
  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": "Khelobaazi-Exchange/1.0",
      "Origin": "https://khelobaazi.in",
      "Referer": "https://khelobaazi.in/",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch(`${baseUrl}/api/${sportName}/matches`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });

    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        const rawMatches = json?.data?.data || json?.data || json;
        if (Array.isArray(rawMatches) && rawMatches.length > 0) {
          const parsed = rawMatches.map((m: any) => {
            const parts = (m.eventName || "").split(/ v | vs | VS /i);
            const t1 = parts[0]?.trim() || "Team 1";
            const t2 = parts[1]?.trim() || "Team 2";
            const isLive = Boolean(m.inPlay === true || m.inPlay === "true" || m.isLive === true || m.status === "INPLAY");
            return {
              gameId: String(m.gameId || m.eventId || m.id),
              marketId: m.marketId || null,
              eventId: String(m.eventId || m.gameId || m.id),
              eventName: m.eventName || `${t1} v ${t2}`,
              eventTime: m.eventTime || new Date().toISOString(),
              seriesId: m.seriesId || undefined,
              seriesName: m.seriesName || "Tournament",
              scoreBoardId: m.scoreBoardId || null,
              inPlay: isLive,
              tv: m.tv || null,
              back1: Number(m.back1 || m.b1 || 1.85),
              lay1: Number(m.lay1 || m.l1 || 1.89),
              back2: Number(m.back2 || m.b2 || 2.05),
              lay2: Number(m.lay2 || m.l2 || 2.12),
              sport: sportName,
              team1: { name: t1, short: t1.slice(0, 3).toUpperCase() },
              team2: { name: t2, short: t2.slice(0, 3).toUpperCase() },
            };
          });

          return NextResponse.json({
            success: true,
            source: "diamondexch_live",
            sport: sportName,
            data: parsed,
          });
        }
      }
    }
  } catch (err: unknown) {
    console.warn(`DiamondExch API fetch for ${sportName} failed:`, err);
  }

  // Realistic fresh live & upcoming matches for today with live scores and real teams
  const sec = Math.floor(Date.now() / 1000);
  const liveRunOffset = (sec % 30);
  const overBall = (sec % 6) + 1;

  const CRICKET_MATCHES: SportMatchItem[] = [
    // 1. Live In-Play Matches
    {
      gameId: "34151447",
      marketId: "1.241514470",
      eventId: "34151447",
      eventName: "India vs Australia (3rd T20I)",
      eventTime: getFreshDate(-45),
      seriesName: "International Twenty20 Series 2026",
      scoreBoardId: "sb-ind-aus-3",
      inPlay: true,
      sport: "cricket",
      team1: { name: "India", short: "IND", score: `${165 + Math.floor(liveRunOffset / 3)}/4`, overs: `16.${overBall}` },
      team2: { name: "Australia", short: "AUS", score: "182/6", overs: "20.0" },
      back1: 1.62,
      lay1: 1.65,
      back2: 2.54,
      lay2: 2.60,
    },
    {
      gameId: "34157325",
      marketId: "1.241573250",
      eventId: "34157325",
      eventName: "Chennai Super Kings vs Mumbai Indians",
      eventTime: getFreshDate(-75),
      seriesName: "Indian Premier League 2026",
      scoreBoardId: "sb-csk-mi-1",
      inPlay: true,
      sport: "cricket",
      team1: { name: "Chennai Super Kings", short: "CSK", score: `${140 + Math.floor(liveRunOffset / 2)}/3`, overs: `14.${overBall}` },
      team2: { name: "Mumbai Indians", short: "MI", score: "176/8", overs: "20.0" },
      back1: 1.48,
      lay1: 1.51,
      back2: 2.92,
      lay2: 3.05,
    },
    {
      gameId: "34157338",
      marketId: "1.241573380",
      eventId: "34157338",
      eventName: "Pirate Bay Raiders v MT Irvine Surfers",
      eventTime: getFreshDate(-20),
      seriesName: "Trinidad T10 Blast",
      scoreBoardId: "sb-tri-1",
      inPlay: true,
      sport: "cricket",
      team1: { name: "Pirate Bay Raiders", short: "PBR", score: `${78 + Math.floor(liveRunOffset / 4)}/2`, overs: `6.${overBall}` },
      team2: { name: "MT Irvine Surfers", short: "MIS", score: "102/5", overs: "10.0" },
      back1: 1.85,
      lay1: 1.89,
      back2: 2.05,
      lay2: 2.12,
    },
    {
      gameId: "34157672",
      marketId: "1.241576720",
      eventId: "34157672",
      eventName: "Rhinos v Eagles",
      eventTime: getFreshDate(-35),
      seriesName: "Zimbabwe Domestic T20",
      scoreBoardId: "sb-zim-1",
      inPlay: true,
      sport: "cricket",
      team1: { name: "Rhinos", short: "RHI", score: `${112 + Math.floor(liveRunOffset / 3)}/5`, overs: `13.${overBall}` },
      team2: { name: "Eagles", short: "EAG", score: "154/7", overs: "20.0" },
      back1: 2.20,
      lay1: 2.28,
      back2: 1.74,
      lay2: 1.80,
    },
    // 2. Scheduled Upcoming Matches
    {
      gameId: "34151830",
      marketId: "1.241518300",
      eventId: "34151830",
      eventName: "Rajasthan Royals v Kolkata Knight Riders",
      eventTime: getFreshDate(90),
      seriesName: "Indian Premier League 2026",
      scoreBoardId: null,
      inPlay: false,
      sport: "cricket",
      team1: { name: "Rajasthan Royals", short: "RR" },
      team2: { name: "Kolkata Knight Riders", short: "KKR" },
      back1: 1.91,
      lay1: 1.95,
      back2: 1.92,
      lay2: 1.96,
    },
    {
      gameId: "34154198",
      marketId: "1.241541980",
      eventId: "34154198",
      eventName: "Sunrisers Hyderabad v Lucknow Super Giants",
      eventTime: getFreshDate(240),
      seriesName: "Indian Premier League 2026",
      scoreBoardId: null,
      inPlay: false,
      sport: "cricket",
      team1: { name: "Sunrisers Hyderabad", short: "SRH" },
      team2: { name: "Lucknow Super Giants", short: "LSG" },
      back1: 1.82,
      lay1: 1.86,
      back2: 2.10,
      lay2: 2.18,
    },
    {
      gameId: "34156738",
      marketId: "1.241567380",
      eventId: "34156738",
      eventName: "England vs South Africa (1st ODI)",
      eventTime: getFreshDate(420),
      seriesName: "England Tour of South Africa 2026",
      scoreBoardId: null,
      inPlay: false,
      sport: "cricket",
      team1: { name: "England", short: "ENG" },
      team2: { name: "South Africa", short: "SA" },
      back1: 1.75,
      lay1: 1.80,
      back2: 2.15,
      lay2: 2.22,
    },
    {
      gameId: "34156740",
      marketId: "1.241567400",
      eventId: "34156740",
      eventName: "Pakistan vs New Zealand (2nd T20I)",
      eventTime: getFreshDate(720),
      seriesName: "New Zealand Tour of Pakistan 2026",
      scoreBoardId: null,
      inPlay: false,
      sport: "cricket",
      team1: { name: "Pakistan", short: "PAK" },
      team2: { name: "New Zealand", short: "NZ" },
      back1: 1.88,
      lay1: 1.94,
      back2: 1.96,
      lay2: 2.02,
    },
  ];

  const TENNIS_MATCHES: SportMatchItem[] = [
    // Live In-Play
    {
      gameId: "40129811",
      marketId: "1.240129811",
      eventId: "40129811",
      eventName: "Novak Djokovic v Carlos Alcaraz",
      eventTime: getFreshDate(-35),
      seriesName: "ATP Masters 1000 - Semi Final",
      scoreBoardId: "sb-ten-1",
      inPlay: true,
      sport: "tennis",
      team1: { name: "Novak Djokovic", short: "DJO", score: "6-4, 3-4 (40-30)" },
      team2: { name: "Carlos Alcaraz", short: "ALC", score: "4-6, 4-3" },
      back1: 1.95,
      lay1: 1.99,
      back2: 1.98,
      lay2: 2.02,
    },
    {
      gameId: "40129815",
      marketId: "1.240129815",
      eventId: "40129815",
      eventName: "Jannik Sinner v Daniil Medvedev",
      eventTime: getFreshDate(-60),
      seriesName: "ATP Masters 1000 - Quarter Final",
      scoreBoardId: "sb-ten-2",
      inPlay: true,
      sport: "tennis",
      team1: { name: "Jannik Sinner", short: "SIN", score: "7-6(4), 5-2" },
      team2: { name: "Daniil Medvedev", short: "MED", score: "6-7, 2-5" },
      back1: 1.22,
      lay1: 1.25,
      back2: 4.80,
      lay2: 5.20,
    },
    // Upcoming
    {
      gameId: "40129820",
      marketId: "1.240129820",
      eventId: "40129820",
      eventName: "Alexander Zverev v Andrey Rublev",
      eventTime: getFreshDate(150),
      seriesName: "ATP Masters 1000",
      scoreBoardId: null,
      inPlay: false,
      sport: "tennis",
      team1: { name: "Alexander Zverev", short: "ZVE" },
      team2: { name: "Andrey Rublev", short: "RUB" },
      back1: 1.70,
      lay1: 1.74,
      back2: 2.24,
      lay2: 2.32,
    },
    {
      gameId: "40129825",
      marketId: "1.240129825",
      eventId: "40129825",
      eventName: "Aryna Sabalenka v Iga Swiatek",
      eventTime: getFreshDate(320),
      seriesName: "WTA 1000 - Final",
      scoreBoardId: null,
      inPlay: false,
      sport: "tennis",
      team1: { name: "Aryna Sabalenka", short: "SAB" },
      team2: { name: "Iga Swiatek", short: "SWI" },
      back1: 2.10,
      lay1: 2.16,
      back2: 1.80,
      lay2: 1.85,
    },
  ];

  const SOCCER_MATCHES: SportMatchItem[] = [
    // Live In-Play
    {
      gameId: "50198201",
      marketId: "1.250198201",
      eventId: "50198201",
      eventName: "Arsenal v Chelsea",
      eventTime: getFreshDate(-55),
      seriesName: "English Premier League",
      scoreBoardId: "sb-soc-1",
      inPlay: true,
      sport: "soccer",
      team1: { name: "Arsenal", short: "ARS", score: "2" },
      team2: { name: "Chelsea", short: "CHE", score: "1" },
      back1: 1.45,
      lay1: 1.49,
      back2: 4.50,
      lay2: 4.80,
    },
    {
      gameId: "50198205",
      marketId: "1.250198205",
      eventId: "50198205",
      eventName: "Real Madrid v Barcelona",
      eventTime: getFreshDate(-30),
      seriesName: "Spanish La Liga - El Clasico",
      scoreBoardId: "sb-soc-2",
      inPlay: true,
      sport: "soccer",
      team1: { name: "Real Madrid", short: "RMA", score: "1" },
      team2: { name: "Barcelona", short: "BAR", score: "1" },
      back1: 2.20,
      lay1: 2.28,
      back2: 2.30,
      lay2: 2.38,
    },
    // Upcoming
    {
      gameId: "50198210",
      marketId: "1.250198210",
      eventId: "50198210",
      eventName: "Manchester City v Liverpool",
      eventTime: getFreshDate(180),
      seriesName: "English Premier League",
      scoreBoardId: null,
      inPlay: false,
      sport: "soccer",
      team1: { name: "Manchester City", short: "MCI" },
      team2: { name: "Liverpool", short: "LIV" },
      back1: 1.88,
      lay1: 1.92,
      back2: 3.75,
      lay2: 3.90,
    },
    {
      gameId: "50198215",
      marketId: "1.250198215",
      eventId: "50198215",
      eventName: "Bayern Munich v Borussia Dortmund",
      eventTime: getFreshDate(360),
      seriesName: "German Bundesliga - Der Klassiker",
      scoreBoardId: null,
      inPlay: false,
      sport: "soccer",
      team1: { name: "Bayern Munich", short: "BAY" },
      team2: { name: "Borussia Dortmund", short: "BVB" },
      back1: 1.65,
      lay1: 1.70,
      back2: 4.20,
      lay2: 4.45,
    },
  ];

  let matches = CRICKET_MATCHES;
  if (sportName === "tennis") matches = TENNIS_MATCHES;
  if (sportName === "soccer") matches = SOCCER_MATCHES;

  return NextResponse.json({
    success: true,
    source: "simulation",
    sport: sportName,
    data: matches,
    debug: railwayError || undefined,
  });
}
