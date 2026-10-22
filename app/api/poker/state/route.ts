import { callerFromRequest, fail, serverTiming } from "../../../lib/server/teenpattiAuth";
import { poll, TableError } from "../../../lib/server/poker";
import type { Timing } from "../../../lib/server/teenpatti";

// GET /api/poker/state?table=<id> — advance the table (timers, bots, next hand) and return your view of it.
export async function GET(req: Request) {
  const start = Date.now();
  try {
    const me = await callerFromRequest(req);
    const id = new URL(req.url).searchParams.get("table") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    const timing: Timing = {};
    const r = await poll(id, me.playerId, me.allowed, timing);
    return Response.json(r, { headers: { "Server-Timing": serverTiming(timing, start) } });
  } catch (e) {
    return fail(e);
  }
}
