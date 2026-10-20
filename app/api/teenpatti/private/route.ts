import { randomInt } from "node:crypto";
import { body, checkCanPlay, fail, playerFromRequest } from "../../../lib/server/teenpattiAuth";
import { byCode, createTable, join, TableError } from "../../../lib/server/teenpatti";

// POST /api/teenpatti/private { boot } — open a private table (friends only, no bots) and sit down. Returns { code }.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function POST(req: Request) {
  try {
    const me = await playerFromRequest(req);
    const b = await body<{ boot?: number }>(req);
    const boot = Math.floor(Number(b.boot));
    if (!Number.isSafeInteger(boot) || boot < 1) throw new TableError("Pick a boot of at least 1 coin");
    await checkCanPlay(me.playerId, boot);
    let code = "";
    for (let i = 0; i < 10; i++) {
      code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      if (!(await byCode(code))) break;
    }
    const id = await createTable(boot, code);
    await join(id, me);
    return Response.json({ code, id });
  } catch (e) {
    return fail(e);
  }
}
