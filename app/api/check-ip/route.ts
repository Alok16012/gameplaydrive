import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch("https://apis.diamondexchapi.com/check-ip", {
      cache: "no-store",
    });
    const text = await res.text();
    return NextResponse.json({
      success: true,
      message: "This is the exact outbound Server Public IP seen by DiamondExch API",
      diamondExchOutput: text.trim(),
    });
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      error: err.message,
    });
  }
}
