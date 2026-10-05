import { NextResponse } from "next/server";

export async function GET() {
  const result: Record<string, any> = {
    timestamp: new Date().toISOString(),
  };

  // 1. Get true outbound Public IPv4 of the server
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    const ipJson = await ipRes.json();
    result.serverOutboundIP = ipJson.ip;
  } catch (err: any) {
    result.serverOutboundIPError = err.message;
  }

  // 2. Test DiamondExch Check-IP endpoint
  try {
    const dRes = await fetch("https://apis.diamondexchapi.com/check-ip", { cache: "no-store" });
    result.diamondExchCheckIpStatus = dRes.status;
    result.diamondExchCheckIpBody = (await dRes.text()).slice(0, 300);
  } catch (err: any) {
    result.diamondExchCheckIpError = err.message;
  }

  // 3. Test DiamondExch Cricket Matches endpoint
  try {
    const matchRes = await fetch("https://apis.diamondexchapi.com/api/cricket/matches", {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      cache: "no-store",
    });
    result.diamondExchMatchesStatus = matchRes.status;
    const matchText = await matchRes.text();
    result.diamondExchMatchesBody = matchText.slice(0, 400);
  } catch (err: any) {
    result.diamondExchMatchesError = err.message;
  }

  return NextResponse.json(result);
}

