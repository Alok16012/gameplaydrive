import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { nineLaunch } from "../../../lib/server/jili";

// POST /api/nine/launch { coins } — move coins into 9Wickets and open the sportsbook; { url, session, coins }.
export async function POST(req: Request) {
  try {
    const me = await callerFromRequest(req);
    await me.allowed;
    const b = (await req.json().catch(() => ({}))) as { coins?: number };
    const coins = Math.floor(Number(b.coins));
    if (!Number.isSafeInteger(coins) || coins < 10) throw new Error("Take at least 10 coins into 9Wickets");
    return Response.json(await nineLaunch(me.playerId, coins));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.replace(/^.*?: /, "") : "Something went wrong" }, { status: 400 });
  }
}
