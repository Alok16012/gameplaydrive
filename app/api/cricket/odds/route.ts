import { NextRequest, NextResponse } from "next/server";

// DiamondExch Odds API Proxy — returns real data only, NO mock/static data
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "";
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";
  const sportParam = (searchParams.get("sport") || "cricket").toLowerCase();
  const isLive = searchParams.get("live") === "true" || searchParams.get("inPlay") === "true";
  const cacheControl = isLive ? "public, max-age=0" : "public, max-age=2";

  if (!eventId) {
    return NextResponse.json({ success: false, message: "eventId required", data: { matchOdds: [], bookMakerOdds: [], fancyOdds: [], otherMarketOdds: [] } });
  }

  // 1. Direct DiamondExch API — primary source
  try {
    const sportPath = sportParam === "football" ? "soccer" : sportParam;
    const res = await fetch(`${baseUrl}/api/${sportPath}/odds?gameId=${eventId}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const json = await res.json();
      const raw = json?.data || {};

      const matchOdds = Array.isArray(raw.matchOdds) ? raw.matchOdds : [];
      const bookMakerOdds = Array.isArray(raw.bookMakerOdds) ? raw.bookMakerOdds : [];
      const fancyOdds = Array.isArray(raw.fancyOdds) ? raw.fancyOdds : [];
      const otherMarketOdds = Array.isArray(raw.otherMarketOdds) ? raw.otherMarketOdds : [];

      if (matchOdds.length > 0 || fancyOdds.length > 0) {
        return NextResponse.json(
          {
            success: true,
            source: "diamondexch_direct",
            data: { matchOdds, bookMakerOdds, fancyOdds, otherMarketOdds },
          },
          { headers: { "Cache-Control": cacheControl } }
        );
      }
    }
  } catch (err) {
    console.warn("DiamondExch Odds fetch failed:", err);
  }

  // 2. my99exch Highlight Odds — fallback, transformed to DiamondExch format
  try {
    const my99Res = await fetch(`https://my99exch.cx/api/front_open/highlightodds-direct/?gmid=${encodeURIComponent(eventId)}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });

    if (my99Res.ok) {
      const json = await my99Res.json();
      const t1List = json?.data?.t1 || [];
      const match = t1List.find((x: any) => String(x.gmid) === String(eventId)) || t1List[0];

      if (match && Array.isArray(match.section) && match.section.length > 0) {
        // Transform my99exch section format → DiamondExch oddDatas format
        const oddDatas = match.section.map((sec: any, idx: number) => {
          const oddsArr = sec.odds || [];
          const getOdd = (name: string) => oddsArr.find((o: any) => o.oname === name);
          const b1 = getOdd("back1"), b2 = getOdd("back2"), b3 = getOdd("back3");
          const l1 = getOdd("lay1"), l2 = getOdd("lay2"), l3 = getOdd("lay3");

          return {
            sid: sec.sid || idx + 1,
            rname: sec.nat || `Runner ${idx + 1}`,
            status: sec.gstatus || "ACTIVE",
            b1: b1 ? String(b1.odds) : "0", bs1: b1 ? String(b1.size) : "0",
            b2: b2 ? String(b2.odds) : "0", bs2: b2 ? String(b2.size) : "0",
            b3: b3 ? String(b3.odds) : "0", bs3: b3 ? String(b3.size) : "0",
            l1: l1 ? String(l1.odds) : "0", ls1: l1 ? String(l1.size) : "0",
            l2: l2 ? String(l2.odds) : "0", ls2: l2 ? String(l2.size) : "0",
            l3: l3 ? String(l3.odds) : "0", ls3: l3 ? String(l3.size) : "0",
            min: sec.min || 0,
            max: sec.max || 0,
          };
        });

        const matchOdds = [{
          mid: match.mid || `mo.${eventId}`,
          market: "MATCH_ODDS",
          isPlay: match.iplay || false,
          status: match.status || "OPEN",
          mname: "MATCH_ODDS",
          gtype: null,
          eventId: String(eventId),
          min: match.min || 0,
          max: match.max || 2000,
          mstatus: match.status || "OPEN",
          oddDatas,
        }];

        return NextResponse.json(
          {
            success: true,
            source: "my99exch_direct",
            data: { matchOdds, bookMakerOdds: [], fancyOdds: [], otherMarketOdds: [] },
          },
          { headers: { "Cache-Control": cacheControl } }
        );
      }
    }
  } catch {
    // silent
  }

  // 3. All sources failed — return empty (no mock data)
  return NextResponse.json({
    success: false,
    message: "No live odds available",
    data: { matchOdds: [], bookMakerOdds: [], fancyOdds: [], otherMarketOdds: [] },
  });
}
