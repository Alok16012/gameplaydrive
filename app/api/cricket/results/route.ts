import { NextRequest, NextResponse } from "next/server";

// Betfair & Bookmaker Results API proxy (5 minute cache interval)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "";
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();
  const sportName = sportParam === "football" ? "soccer" : sportParam;

  const apiKey = process.env.DIAMONDEXCH_API_KEY || process.env.CRICKET_API_KEY;
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";
  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";

  // 1. Fetch via Railway Proxy (with 5-minute server-side cache)
  if (!process.env.RAILWAY_PROJECT_ID && !req.headers.get("x-from-railway")) {
    try {
      const railwayRes = await fetch(`${railwayHost}/api/cricket/results?eventId=${encodeURIComponent(eventId)}&sport=${sportName}`, {
        headers: { "x-from-railway": "1" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
    if (railwayRes.ok) {
      const json = await railwayRes.json();
      return NextResponse.json(
        {
          success: true,
          source: "railway_diamondexch_live",
          data: json?.data?.data || json?.data || json,
        },
        {
          headers: {
            "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
          },
        }
      );
      }
    } catch (err) {
      // fallback to direct
    }
  }

  // 2. Direct DiamondExch API call
  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": "curl/7.81.0",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch(`${baseUrl}/api/${sportName}/results?eventId=${encodeURIComponent(eventId)}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const json = await res.json();
      return NextResponse.json(
        {
          success: true,
          source: "diamondexch_live",
          data: json?.data?.data || json?.data || json,
        },
        {
          headers: {
            "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
          },
        }
      );
    }
  } catch (err) {
    console.warn("Match results fetch error:", err);
  }

  return NextResponse.json(
    {
      success: true,
      source: "empty",
      data: [],
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300",
      },
    }
  );
}
