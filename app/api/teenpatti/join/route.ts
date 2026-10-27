import { body, checkCanPlay, fail, playerFromRequest } from "../../../lib/server/teenpattiAuth";
import { byCode, createTable, findPublic, join, poll } from "../../../lib/server/teenpatti";
import { TableError } from "../../../lib/server/teenpatti";

// POST /api/teenpatti/join { boot } | { code } — sit at a public table for that boot (joining the fullest one
// with room, or opening a new one) or at a friend's private table. Returns the table and your view.
export async function POST(req: Request) {
  try {
    const me = await playerFromRequest(req);
    const b = await body<{ boot?: number; code?: string; avoid?: string }>(req);
    let table = b.code ? await byCode(String(b.code).trim()) : null;
    if (b.code && !table) throw new TableError("No table with that code", 404);
    const boot = table ? table.boot : Math.floor(Number(b.boot));
    if (!Number.isSafeInteger(boot) || boot <= 0) throw new TableError("Pick a boot amount");
    await checkCanPlay(me.playerId, boot);
    if (!table) table = await findPublic(boot, b.avoid);
    const id = table ? table.id : await createTable(boot, null);
    await join(id, me);
    return Response.json(await poll(id, me.playerId));
  } catch (e) {
    return fail(e);
  }
}
