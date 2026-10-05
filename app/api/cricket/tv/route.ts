import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "34157338";
  const apiKey = process.env.DIAMONDEXCH_API_KEY || process.env.CRICKET_API_KEY;
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";

  if (apiKey) {
    return NextResponse.redirect(`${baseUrl}/api/tv?eventId=${eventId}&sport=cricket`);
  }

  return NextResponse.json({
    success: true,
    eventId,
    streamUrl: null,
    message: "Live TV stream available when DIAMONDEXCH_API_KEY is configured.",
  });
}
