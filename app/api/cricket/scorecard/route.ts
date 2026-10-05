import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "34157338";
  const apiKey = process.env.DIAMONDEXCH_API_KEY || process.env.CRICKET_API_KEY;
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";

  if (apiKey) {
    return NextResponse.redirect(`${baseUrl}/api/scorecard?eventId=${eventId}&sport=cricket`);
  }

  // Fallback radar score simulation data
  return NextResponse.json({
    success: true,
    eventId,
    score: {
      team1: "IND",
      team2: "AUS",
      battingTeam: "IND",
      runs: 168,
      wickets: 4,
      overs: "16.2",
      target: 183,
      crr: "10.28",
      rrr: "3.95",
      batsmen: [
        { name: "Virat Kohli*", runs: 64, balls: 42, fours: 5, sixes: 2, strikeRate: "152.3" },
        { name: "Hardik Pandya", runs: 28, balls: 14, fours: 2, sixes: 2, strikeRate: "200.0" },
      ],
      bowler: { name: "Mitchell Starc", overs: "3.2", maidens: 0, runs: 34, wickets: 2, econ: "10.2" },
      recentBalls: ["1", "4", "0", "6", "W", "2", "1", "4"],
      lastWicket: "Suryakumar Yadav c Maxwell b Starc 35 (19b)",
    },
  });
}
