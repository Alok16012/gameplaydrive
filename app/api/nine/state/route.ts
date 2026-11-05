import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { jiliRealReady, nineCap, nineOpen } from "../../../lib/server/jili";

// GET /api/nine/state — is 9Wickets set up, the player's open session (if any) and the most coins a session may take.
export async function GET(req: Request) {
  try {
    const me = await callerFromRequest(req);
    await me.allowed;
    const ready = jiliRealReady("9w");
    const [open, cap] = ready ? await Promise.all([nineOpen(me.playerId), nineCap().catch(() => 0)]) : [null, 0];
    return Response.json({ ready, open, cap });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.replace(/^.*?: /, "") : "Something went wrong" }, { status: 400 });
  }
}
