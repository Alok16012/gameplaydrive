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
      const rawMatches: any[] =
        (Array.isArray(json?.data?.data) && json.data.data) ||
        (Array.isArray(json?.data?.cricketMatches) && json.data.cricketMatches) ||
        (Array.isArray(json?.data?.soccerMatches) && json.data.soccerMatches) ||
        (Array.isArray(json?.data?.TennisMatches) && json.data.TennisMatches) ||
        (Array.isArray(json?.data?.tennisMatches) && json.data.tennisMatches) ||
        (Array.isArray(json?.data) && json.data) ||
        (Array.isArray(json) && json) ||
        (json?.data && typeof json.data === "object" ? Object.values(json.data).find(Array.isArray) as any[] : []) ||
        [];

      if (rawMatches.length > 0) {
        const parsed = rawMatches.map((m: any) => {
          const parts = (m.eventName || "").split(/ v | vs | VS /i);
          const t1 = parts[0]?.trim() || "Team 1";
          const t2 = parts[1]?.trim() || "Team 2";
          const isLive = Boolean(m.inPlay === true || m.inPlay === "true" || m.isLive === true || m.status === "INPLAY");
          const evId = String(m.eventId || m.gameId || m.id || "0");
          
          
          let b1 = Number(m.back1 || m.b1 || 0);
          let l1 = Number(m.lay1 || m.l1 || 0);
          let b2 = Number(m.back2 || m.b2 || 0);
          let l2 = Number(m.lay2 || m.l2 || 0);



          return {
            gameId: String(m.gameId || m.eventId || m.id),
            marketId: m.marketId || null,
            eventId: evId,
            eventName: m.eventName || `${t1} v ${t2}`,
            eventTime: m.eventTime || new Date().toISOString(),
            seriesId: m.seriesId || undefined,
            seriesName: m.seriesName || "Tournament",
            scoreBoardId: m.scoreBoardId || null,
            inPlay: isLive,
            tv: m.tv || null,
            back1: b1,
            lay1: l1,
            back2: b2,
            lay2: l2,
            sport: sportName,
            team1: { name: t1, short: t1.slice(0, 3).toUpperCase() },
            team2: { name: t2, short: t2.slice(0, 3).toUpperCase() },
          };
        });

        return NextResponse.json(
          {
            success: true,
            source: "railway_diamondexch_live",
            sport: sportName,
            data: parsed,
          },
          {
            headers: {
              "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            },
          }
        );
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
        const rawMatches: any[] =
          (Array.isArray(json?.data?.data) && json.data.data) ||
          (Array.isArray(json?.data?.cricketMatches) && json.data.cricketMatches) ||
          (Array.isArray(json?.data?.soccerMatches) && json.data.soccerMatches) ||
          (Array.isArray(json?.data?.TennisMatches) && json.data.TennisMatches) ||
          (Array.isArray(json?.data?.tennisMatches) && json.data.tennisMatches) ||
          (Array.isArray(json?.data) && json.data) ||
          (Array.isArray(json) && json) ||
          (json?.data && typeof json.data === "object" ? Object.values(json.data).find(Array.isArray) as any[] : []) ||
          [];

        if (rawMatches.length > 0) {
          const parsed = rawMatches.map((m: any) => {
            const parts = (m.eventName || "").split(/ v | vs | VS /i);
            const t1 = parts[0]?.trim() || "Team 1";
            const t2 = parts[1]?.trim() || "Team 2";
            const isLive = Boolean(m.inPlay === true || m.inPlay === "true" || m.isLive === true || m.status === "INPLAY");
            const evId = String(m.eventId || m.gameId || m.id || "0");
            
            
            let b1 = Number(m.back1 || m.b1 || 0);
            let l1 = Number(m.lay1 || m.l1 || 0);
            let b2 = Number(m.back2 || m.b2 || 0);
            let l2 = Number(m.lay2 || m.l2 || 0);



            return {
              gameId: String(m.gameId || m.eventId || m.id),
              marketId: m.marketId || null,
              eventId: evId,
              eventName: m.eventName || `${t1} v ${t2}`,
              eventTime: m.eventTime || new Date().toISOString(),
              seriesId: m.seriesId || undefined,
              seriesName: m.seriesName || "Tournament",
              scoreBoardId: m.scoreBoardId || null,
              inPlay: isLive,
              tv: m.tv || null,
              back1: b1,
              lay1: l1,
              back2: b2,
              lay2: l2,
              sport: sportName,
              team1: { name: t1, short: t1.slice(0, 3).toUpperCase() },
              team2: { name: t2, short: t2.slice(0, 3).toUpperCase() },
            };
          });

          return NextResponse.json(
            {
              success: true,
              source: "diamondexch_live",
              sport: sportName,
              data: parsed,
            },
            {
              headers: {
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
              },
            }
          );
        }
      }
    }
  } catch (err: unknown) {
    console.warn(`DiamondExch API fetch for ${sportName} failed:`, err);
  }

  // If we reach here, both Railway Proxy and Direct DiamondExch API failed.
  return NextResponse.json({
    success: false,
    message: "No live matches available from Diamond API",
    data: [],
    debug: railwayError || undefined,
  });
}
