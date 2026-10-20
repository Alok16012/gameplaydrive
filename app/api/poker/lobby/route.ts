import { lobbyCounts } from "../../../lib/server/poker";

// GET /api/poker/lobby — real players seated at public poker tables, per boot: { "20": 3, "100": 1 }.
export async function GET() {
  try {
    return Response.json(await lobbyCounts());
  } catch {
    return Response.json({});
  }
}
