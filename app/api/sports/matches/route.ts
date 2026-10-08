import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();
  const sportName = sportParam === "football" ? "soccer" : sportParam; 
  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";

  try {
    const railwayRes = await fetch(`${railwayHost}/api/sports/matches?sport=${encodeURIComponent(sportName)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (railwayRes.ok) {
      const json = await railwayRes.json();
      return NextResponse.json(json, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (err) {
    console.warn("Proxy to Node server failed for matches:", err);
  }

  return NextResponse.json({ success: false, data: [] });
}
