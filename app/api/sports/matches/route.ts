import { NextResponse } from "next/server";
import { cricketFeed, toMatch } from "../../../lib/server/oddsApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Cricket matches with their Match Winner odds, from The Odds API (app/lib/server/oddsApi.ts). Nothing is made up:
// if the API has no data, the list is empty and `message` says why.
export async function GET() {
  const feed = await cricketFeed();
  return NextResponse.json(
    { success: feed.events.length > 0, message: feed.error, updatedAt: feed.fetchedAt || null, data: feed.events.map((e) => toMatch(e, feed)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
