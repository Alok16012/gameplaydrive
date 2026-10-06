import { NextResponse } from "next/server";

export async function GET() {
  const result: Record<string, any> = {
    timestamp: new Date().toISOString(),
  };

  // 1. Check Railway Proxy Outbound IP (The actual proxy that calls DiamondExch)
  const railwayHost = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "https://game-server-production-cc2c.up.railway.app";
  try {
    const rRes = await fetch(`${railwayHost}/check-ip`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (rRes.ok) {
      const rJson = await rRes.json();
      result.MAIN_WHITELIST_IP = rJson.railwayPublicIP;
      result.railwayProxyStatus = rJson;
    }
  } catch (err: any) {
    result.railwayProxyError = err.message;
  }

  // 2. Vercel Serverless Egress IP (Dynamic)
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    result.vercelDynamicIP_DO_NOT_WHITELIST = (await ipRes.json()).ip;
  } catch (err: any) {
    result.vercelDynamicIPError = err.message;
  }

  return NextResponse.json(result);
}

