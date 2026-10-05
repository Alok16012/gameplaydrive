import { NextRequest, NextResponse } from "next/server";
import { GET as getSportsMatches } from "../../../api/sports/matches/route";

export async function GET(req: NextRequest) {
  return getSportsMatches(req);
}
