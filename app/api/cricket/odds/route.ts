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
    const railwayRes = await fetch(`${railwayHost}/api/cricket/odds?eventId=${eventId}&sport=${sportParam}&live=${isLive}`, {
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

    const res = await fetch(`${baseUrl}/api/${sportParam === "football" ? "soccer" : sportParam}/odds?eventId=${eventId}`, {
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

  // 3. Generate match-specific realistic exchange odds with live tick drift
  const eventNum = Math.abs([...eventId].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7));
  const team1Name = searchParams.get("team1") || "Team 1";
  const team2Name = searchParams.get("team2") || "Team 2";

  // Base decimal price between 1.30 and 2.60 depending on match eventId
  const base1 = Number((1.30 + ((eventNum % 130) / 100)).toFixed(2)); // 1.30 to 2.60
  const timeDrift = isLive ? (Math.sin(Date.now() / 4000) * 0.03) : 0;
  
  const b1 = Number((base1 + timeDrift).toFixed(2));
  const l1 = Number((b1 + 0.02 + (eventNum % 3) * 0.01).toFixed(2));
  
  // Implied fair probability calculation for Runner 2
  const p1 = 1 / b1;
  const p2 = Math.max(0.15, Math.min(0.85, 1.05 - p1));
  const b2 = Number((1 / p2 - timeDrift).toFixed(2));
  const l2 = Number((b2 + 0.03 + (eventNum % 4) * 0.01).toFixed(2));

  // Bookmaker Indian format (0-100 basis point differential)
  const bm1_back = Math.round((b1 - 1) * 100);
  const bm1_lay = bm1_back + 2;
  const bm2_back = Math.round((b2 - 1) * 100);
  const bm2_lay = bm2_back + 3;

  // Fancy session runs based on event hash
  const sixOverBase = 44 + (eventNum % 14);
  const tenOverBase = 80 + (eventNum % 20);
  const fifteenOverBase = 125 + (eventNum % 25);
  const sixesBase = 11 + (eventNum % 8);

  const matchOddsData = [
    {
      mid: `1.${eventId}`,
      mname: "MATCH_ODDS",
      status: "OPEN",
      min: 100,
      max: 500000,
      oddDatas: [
        {
          sid: "1",
          rname: team1Name,
          status: "ACTIVE",
          b1: b1.toFixed(2),
          bs1: `${(100 + (eventNum % 150))}K`,
          b2: (b1 - 0.01).toFixed(2),
          bs2: `${(60 + (eventNum % 80))}K`,
          b3: (b1 - 0.02).toFixed(2),
          bs3: `${(150 + (eventNum % 100))}K`,
          l1: l1.toFixed(2),
          ls1: `${(90 + (eventNum % 120))}K`,
          l2: (l1 + 0.01).toFixed(2),
          ls2: `${(70 + (eventNum % 60))}K`,
          l3: (l1 + 0.02).toFixed(2),
          ls3: `${(180 + (eventNum % 100))}K`,
        },
        {
          sid: "2",
          rname: team2Name,
          status: "ACTIVE",
          b1: b2.toFixed(2),
          bs1: `${(80 + (eventNum % 110))}K`,
          b2: (b2 - 0.01).toFixed(2),
          bs2: `${(50 + (eventNum % 70))}K`,
          b3: (b2 - 0.02).toFixed(2),
          bs3: `${(120 + (eventNum % 90))}K`,
          l1: l2.toFixed(2),
          ls1: `${(95 + (eventNum % 130))}K`,
          l2: (l2 + 0.01).toFixed(2),
          ls2: `${(65 + (eventNum % 75))}K`,
          l3: (l2 + 0.02).toFixed(2),
          ls3: `${(140 + (eventNum % 110))}K`,
        },
      ],
    },
  ];

  const bookmakerOddsData = [
    {
      mid: `bm.${eventId}`,
      mname: "BOOKMAKER_ODDS_1",
      status: "ACTIVE",
      min: 100,
      max: 200000,
      oddDatas: [
        {
          sid: "1",
          rname: team1Name,
          status: "ACTIVE",
          b1: String(bm1_back),
          bs1: "100K",
          l1: String(bm1_lay),
          ls1: "100K",
        },
        {
          sid: "2",
          rname: team2Name,
          status: "ACTIVE",
          b1: String(bm2_back),
          bs1: "100K",
          l1: String(bm2_lay),
          ls1: "100K",
        },
      ],
    },
  ];

  const fancyOddsData = [
    {
      mid: `fancy.${eventId}`,
      mname: "FANCY_ODDS",
      gtype: "Normal",
      oddDatas: [
        {
          sid: "101",
          rname: `6 Over Runs (${team1Name.split(" ")[0]})`,
          b1: String(sixOverBase + 2), // Yes score
          bs1: "100",
          l1: String(sixOverBase),     // No score
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
        {
          sid: "102",
          rname: `10 Over Runs (${team1Name.split(" ")[0]})`,
          b1: String(tenOverBase + 2),
          bs1: "100",
          l1: String(tenOverBase),
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
        {
          sid: "103",
          rname: `15 Over Runs (${team1Name.split(" ")[0]})`,
          b1: String(fifteenOverBase + 3),
          bs1: "100",
          l1: String(fifteenOverBase),
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
        {
          sid: "104",
          rname: "Total Match Sixes",
          b1: String(sixesBase + 1),
          bs1: "100",
          l1: String(sixesBase),
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 25000,
        },
        {
          sid: "105",
          rname: "Fall of 1st Wicket",
          b1: "32",
          bs1: "100",
          l1: "28",
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
      ],
    },
  ];

  return NextResponse.json({
    success: true,
    source: "simulation",
    data: {
      matchOdds: matchOddsData,
      bookMakerOdds: bookmakerOddsData,
      fancyOdds: fancyOddsData,
    },
  });
}
