import { fail, playerFromRequest } from "../../../lib/server/teenpattiAuth";
import { poll, TableError } from "../../../lib/server/teenpatti";

// GET /api/teenpatti/state?table=<id> — advance the table (timers, bots, next hand) and return your view of it.
export async function GET(req: Request) {
  try {
    const me = await playerFromRequest(req);
    const id = new URL(req.url).searchParams.get("table") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    return Response.json(await poll(id, me.playerId));
  } catch (e) {
    return fail(e);
  }
}
