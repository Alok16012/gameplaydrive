import { body, callerFromRequest, fail } from "../../../lib/server/teenpattiAuth";
import { sitOut, TableError } from "../../../lib/server/teenpatti";

// POST /api/teenpatti/sitout { table, on } — sit out from the next hand (keeping the seat) or come back in.
export async function POST(req: Request) {
  try {
    const me = await callerFromRequest(req);
    const b = await body<{ table?: string; on?: boolean }>(req);
    const id = String(b.table ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    return Response.json(await sitOut(id, me.playerId, b.on !== false, me.allowed));
  } catch (e) {
    return fail(e);
  }
}
