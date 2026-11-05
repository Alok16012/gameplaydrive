import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { nineCashout } from "../../../lib/server/jili";

// POST /api/nine/cashout — bring the player's 9Wickets balance back to coins and close the session; { coins, balance }.
export async function POST(req: Request) {
  try {
    const me = await callerFromRequest(req);
    await me.allowed;
    return Response.json(await nineCashout(me.playerId));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.replace(/^.*?: /, "") : "Something went wrong" }, { status: 400 });
  }
}
