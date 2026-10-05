import { NextRequest, NextResponse } from "next/server";

// Redirect to DiamondExch live TV stream
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("eventId") || "34157338";
  const baseUrl = process.env.DIAMONDEXCH_BASE_URL || "https://apis.diamondexchapi.com";

  return NextResponse.redirect(`${baseUrl}/api/tv?eventId=${eventId}&sport=cricket`, {
    status: 302,
  });
}
