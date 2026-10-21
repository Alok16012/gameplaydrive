import { body, callerFromRequest, fail, serverTiming } from "../../../lib/server/teenpattiAuth";
import { act, TableError, type Timing } from "../../../lib/server/teenpatti";
import type { ActionType } from "../../../lib/teenpatti/engine";

// POST /api/teenpatti/act { table, actionId, handId, expectedVersion, type, requestId? }
// The player's identity comes from the token, never the body. Replays with the same actionId are safe.
const TYPES = new Set<ActionType>(["SEE_CARDS", "BET_MIN", "BET_DOUBLE", "PACK", "SHOW", "SIDESHOW_REQUEST", "SIDESHOW_ACCEPT", "SIDESHOW_REJECT"]);

export async function POST(req: Request) {
  const start = Date.now();
  try {
    const me = await callerFromRequest(req);
    const b = await body<{ table?: string; actionId?: string; handId?: string; expectedVersion?: number; type?: ActionType; requestId?: string }>(req);
    const id = String(b.table ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    if (!b.type || !TYPES.has(b.type)) throw new TableError("Unknown action");
    const actionId = String(b.actionId ?? "");
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(actionId)) throw new TableError("Missing action id");
    const timing: Timing = {};
    const r = await act(id, me.playerId, {
      actionId, handId: String(b.handId ?? ""), expectedVersion: Math.floor(Number(b.expectedVersion)), type: b.type,
      requestId: b.requestId ? String(b.requestId) : undefined,
    }, me.allowed, timing);
    return Response.json(r, { status: r.ok ? 200 : 409, headers: { "Server-Timing": serverTiming(timing, start) } });
  } catch (e) {
    return fail(e);
  }
}
