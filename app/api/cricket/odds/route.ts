import { NextRequest, NextResponse } from "next/server";

// DiamondExch Match Odds, Bookmaker & Fancy API proxy
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "34157338";
  const apiKey = process.env.DIAMONDEXCH_API_KEY || process.env.CRICKET_API_KEY;
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";

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

    const res = await fetch(`${baseUrl}/api/cricket/odds?eventId=${eventId}`, {
      headers,
      cache: "no-store",
    });

    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        const data = json?.data?.data || json?.data || json;
        if (data && (data.matchOdds || data.match_odds || data.bookMakerOdds || data.fancyOdds)) {
          return NextResponse.json({
            success: true,
            source: "diamondexch_live",
            data,
          });
        }
      }
    }
  } catch (err) {
    console.warn("Live DiamondExch Odds fetch exception:", err);
  }

  // Generate realistic fluctuating odds for the requested match
  const time = Date.now() / 1000;
  const drift = (Math.sin(time / 5) * 0.05);

  const matchOddsData = [
    {
      mid: "1.241309100",
      mname: "MATCH_ODDS",
      status: "OPEN",
      min: 100,
      max: 500000,
      oddDatas: [
        {
          sid: "1",
          rname: "Team 1",
          status: "ACTIVE",
          b1: (1.62 + drift).toFixed(2),
          bs1: "154200",
          b2: (1.61 + drift).toFixed(2),
          bs2: "89000",
          b3: (1.60 + drift).toFixed(2),
          bs3: "210000",
          l1: (1.65 + drift).toFixed(2),
          ls1: "125000",
          l2: (1.66 + drift).toFixed(2),
          ls2: "92000",
          l3: (1.67 + drift).toFixed(2),
          ls3: "180000",
        },
        {
          sid: "2",
          rname: "Team 2",
          status: "ACTIVE",
          b1: (2.54 - drift).toFixed(2),
          bs1: "95000",
          b2: (2.52 - drift).toFixed(2),
          bs2: "62000",
          b3: (2.50 - drift).toFixed(2),
          bs3: "140000",
          l1: (2.60 - drift).toFixed(2),
          ls1: "110000",
          l2: (2.62 - drift).toFixed(2),
          ls2: "75000",
          l3: (2.64 - drift).toFixed(2),
          ls3: "130000",
        },
      ],
    },
  ];

  const bookmakerOddsData = [
    {
      mid: "7399926127946",
      mname: "BOOKMAKER_ODDS_1",
      status: "ACTIVE",
      min: 100,
      max: 200000,
      oddDatas: [
        {
          sid: "1",
          rname: "Team 1 (Bookmaker)",
          status: "ACTIVE",
          b1: "62",
          bs1: "100000",
          l1: "65",
          ls1: "100000",
        },
        {
          sid: "2",
          rname: "Team 2 (Bookmaker)",
          status: "ACTIVE",
          b1: "154",
          bs1: "100000",
          l1: "160",
          ls1: "100000",
        },
      ],
    },
  ];

  const fancyOddsData = [
    {
      mid: "303988021090",
      mname: "FANCY_ODDS",
      gtype: "Normal",
      oddDatas: [
        {
          sid: "101",
          rname: "6 Over Runs Team 1",
          b1: "48", // Yes score
          bs1: "100", // Yes price
          l1: "46", // No score
          ls1: "100", // No price
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
        {
          sid: "102",
          rname: "10 Over Runs Team 1",
          b1: "86",
          bs1: "100",
          l1: "84",
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
        {
          sid: "103",
          rname: "15 Over Runs Team 1",
          b1: "135",
          bs1: "100",
          l1: "132",
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 50000,
        },
        {
          sid: "104",
          rname: "Total Match Sixes",
          b1: "14",
          bs1: "100",
          l1: "13",
          ls1: "100",
          status: "ACTIVE",
          min: 100,
          max: 25000,
        },
        {
          sid: "105",
          rname: "Fall of Next Wicket (Runs)",
          b1: "185",
          bs1: "100",
          l1: "180",
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
