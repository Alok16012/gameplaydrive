import { lobbyCounts } from "../../../lib/server/teenpatti";

// GET /api/teenpatti/lobby — real players seated at public tables, per boot: { "50": 3, "100": 1 }.
export async function GET() {
  try {
    return Response.json(await lobbyCounts());
  } catch {
    return Response.json({});
  }
}
