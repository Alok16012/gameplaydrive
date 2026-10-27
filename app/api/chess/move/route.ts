import { body, callerFromRequest, fail } from "../../../lib/server/teenpattiAuth";
import { chessMove } from "../../../lib/server/chess";
import { TableError } from "../../../lib/server/teenpatti";

// POST /api/chess/move { table, from: [r, c], to: [r, c], promo? } — play your move; returns the table as it stands.
export async function POST(req: Request) {
  try {
    const me = await callerFromRequest(req);
    const b = await body<{ table?: string; from?: number[]; to?: number[]; promo?: string }>(req);
    const id = String(b.table ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TableError("Missing table");
    const sq = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n) && n >= 0 && n < 8);
    if (!sq(b.from) || !sq(b.to)) throw new TableError("Bad move");
    return Response.json(await chessMove(id, me.playerId, b.from as [number, number], b.to as [number, number], b.promo));
  } catch (e) {
    return fail(e);
  }
}
