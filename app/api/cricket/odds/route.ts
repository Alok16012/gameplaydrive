import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "";
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();
  const isLive = searchParams.get("live") === "true" || searchParams.get("inPlay") === "true";
  const team1 = searchParams.get("team1") || "";
  const team2 = searchParams.get("team2") || "";
  // no-store: Netlify's CDN ignores query strings, so caching here would serve one event's data for another.
  // The Railway server already caches upstream calls.
  const cacheControl = "no-store";

  if (!eventId) {
    return NextResponse.json({ success: false, message: "eventId required", data: { matchOdds: [], bookMakerOdds: [], fancyOdds: [], otherMarketOdds: [] } });
  }

  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";
  const sportName = sportParam === "football" ? "soccer" : sportParam;

  try {
    const railwayRes = await fetch(`${railwayHost}/api/cricket/odds?eventId=${encodeURIComponent(eventId)}&sport=${encodeURIComponent(sportName)}&live=${isLive}&team1=${encodeURIComponent(team1)}&team2=${encodeURIComponent(team2)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (railwayRes.ok) {
      const json = await railwayRes.json();
      return NextResponse.json(json, { headers: { "Cache-Control": cacheControl } });
    }
  } catch (err) {
    console.warn("Proxy to Node server failed for odds:", err);
  }

  return NextResponse.json({
    success: false,
    message: "No live odds available",
    data: { matchOdds: [], bookMakerOdds: [], fancyOdds: [], otherMarketOdds: [] },
  });
}
