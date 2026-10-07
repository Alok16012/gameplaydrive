import { NextRequest, NextResponse } from "next/server";

// DiamondExch Match Odds, Bookmaker & Fancy API proxy
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "34157338";
  const apiKey = process.env.DIAMONDEXCH_API_KEY || process.env.CRICKET_API_KEY;
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";
  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();

  const isLive = searchParams.get("live") === "true" || searchParams.get("inPlay") === "true";
  const cacheControl = isLive ? "public, max-age=1" : "public, max-age=2";

  // 1. Attempt via Railway Proxy first (Live: 500ms cache, Upcoming: 2s cache)
  try {
    const railwayRes = await fetch(`${railwayHost}/api/cricket/odds?gameId=${eventId}&eventId=${eventId}&sport=${sportParam}&live=${isLive}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (railwayRes.ok) {
      const json = await railwayRes.json();
      const data = json?.data?.data || json?.data || json;
      if (data && (data.matchOdds || data.match_odds || data.bookMakerOdds || data.fancyOdds)) {
        return NextResponse.json(
          {
            success: true,
            source: "railway_diamondexch_live",
            data,
          },
          {
            headers: {
              "Cache-Control": cacheControl,
            },
          }
        );
      }
    }
  } catch (err) {
    // fallback
  }

  // 2. Direct DiamondExch API call
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

    const res = await fetch(`${baseUrl}/api/${sportParam === "football" ? "soccer" : sportParam}/odds?gameId=${eventId}&eventId=${eventId}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        const data = json?.data?.data || json?.data || json;
        if (data && (data.matchOdds || data.match_odds || data.bookMakerOdds || data.fancyOdds)) {
          return NextResponse.json(
            {
              success: true,
              source: "diamondexch_live",
              data,
            },
            {
              headers: {
                "Cache-Control": cacheControl,
              },
            }
          );
        }
      }
    }
  } catch (err) {
    console.warn("Live DiamondExch Odds fetch exception:", err);
  }

  // If we reach here, both Railway Proxy and Direct DiamondExch API failed.
  return NextResponse.json({
    success: false,
    message: "No live odds available from Diamond API",
    data: {
      matchOdds: [],
      bookMakerOdds: [],
      fancyOdds: [],
    },
  });
}
