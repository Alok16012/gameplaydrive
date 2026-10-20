import { body, fail, playerFromRequest } from "../../../lib/server/teenpattiAuth";
import { act, TableError } from "../../../lib/server/poker";
import type { ActionType } from "../../../lib/poker/engine";

// POST /api/poker/act { table, actionId, handId, expectedVersion, type, to? }
// The player's identity comes from the token, never the body. Replays with the same actionId are safe.
const TYPES = new Set<ActionType>(["FOLD", "CHECK", "CALL", "RAISE"]);

export async function POST(req: Request) {
  try {
    const me = await playerFromRequest(req);
    const b = await body<{ table?: string; actionId?: string; handId?: string; expectedVersion?: number; type?: ActionType; to?: number }>(req);
    const id = String(b.table ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    if (!b.type || !TYPES.has(b.type)) throw new TableError("Unknown action");
    const actionId = String(b.actionId ?? "");
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(actionId)) throw new TableError("Missing action id");
    const r = await act(id, me.playerId, {
      actionId, handId: String(b.handId ?? ""), expectedVersion: Math.floor(Number(b.expectedVersion)), type: b.type,
      to: b.type === "RAISE" ? Math.floor(Number(b.to)) : undefined,
    });
    return Response.json(r, { status: r.ok ? 200 : 409 });
  } catch (e) {
    return fail(e);
  }
}
