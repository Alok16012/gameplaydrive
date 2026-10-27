import { callerFromRequest, fail } from "../../../lib/server/teenpattiAuth";
import { chessState } from "../../../lib/server/chess";
import { TableError } from "../../../lib/server/teenpatti";

// GET /api/chess/state?table=<id> — your view of a Chess-with-a-friend table (ends the game if a clock ran out).
export async function GET(req: Request) {
  try {
    const me = await callerFromRequest(req);
    const id = new URL(req.url).searchParams.get("table") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    return Response.json(await chessState(id, me.playerId));
  } catch (e) {
    return fail(e);
  }
}
