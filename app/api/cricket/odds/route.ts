import { NextRequest, NextResponse } from "next/server";
import { cricketFeed, toMatchOdds } from "../../../lib/server/oddsApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Match Winner odds of one cricket match, from The Odds API (it has no bookmaker / fancy / session markets).
// no-store: Netlify's CDN ignores query strings, so caching here would serve one event's odds for another.
export async function GET(req: NextRequest) {
  const eventId = new URL(req.url).searchParams.get("eventId") || "";
  const feed = await cricketFeed();
  const e = feed.events.find((x) => x.id === eventId);
  return NextResponse.json(
    { success: !!e, message: e ? undefined : feed.error ?? "No odds for this match", updatedAt: feed.fetchedAt || null, data: { matchOdds: e ? toMatchOdds(e, feed) : null } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
