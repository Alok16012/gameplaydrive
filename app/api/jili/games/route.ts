import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { jiliGames } from "../../../lib/server/jili";

// GET /api/jili/games — the JILI catalogue for the in-app lobby: { games: [{ uid, name, category, logo }] }.
export async function GET(req: Request) {
  try {
    await callerFromRequest(req);
    return Response.json({ games: await jiliGames() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Something went wrong" }, { status: 400 });
  }
}
