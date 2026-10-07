import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "";
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();
  
  if (!eventId) return NextResponse.json({ success: false, data: [] });

  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";
  const sportName = sportParam === "football" ? "soccer" : sportParam; 

  try {
    const railwayRes = await fetch(`${railwayHost}/api/cricket/fancy-results?eventId=${encodeURIComponent(eventId)}&sport=${encodeURIComponent(sportName)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (railwayRes.ok) {
      const json = await railwayRes.json();
      return NextResponse.json(json, { headers: { "Cache-Control": "public, s-maxage=60" } });
    }
  } catch (err) {
    console.warn("Proxy to Node server failed for fancy-results:", err);
  }

  return NextResponse.json({ success: false, data: [] });
}
