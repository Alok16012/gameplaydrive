import { body, callerFromRequest, fail } from "../../../lib/server/teenpattiAuth";
import { leave, TableError } from "../../../lib/server/teenpatti";

// POST /api/teenpatti/leave { table } — pack if you're in a hand and give up the seat. Nothing is refunded.
export async function POST(req: Request) {
  try {
    const me = await callerFromRequest(req);
    const b = await body<{ table?: string }>(req);
    const id = String(b.table ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    await leave(id, me.playerId, me.allowed);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
