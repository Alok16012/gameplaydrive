import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { nineBets } from "../../../lib/server/jili";

// GET /api/nine/bets — the player's 9Wickets match bets of the last 7 days, newest first.
export async function GET(req: Request) {
  try {
    const me = await callerFromRequest(req);
    await me.allowed;
    return Response.json({ bets: await nineBets(me.playerId) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.replace(/^.*?: /, "") : "Something went wrong" }, { status: 400 });
  }
}
