import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { jiliLaunch, jiliRealReady } from "../../../lib/server/jili";

// GET /api/jili/launch?uid=879 — open a JILI game with the player's coins; { url, balance }.
// GET /api/jili/launch?check=1 — { ready } (is real-coin play set up on this server?).
export async function GET(req: Request) {
  try {
    const me = await callerFromRequest(req);
    const q = new URL(req.url).searchParams;
    if (q.get("check") === "1") return Response.json({ ready: jiliRealReady() });
    const uid = q.get("uid") ?? "";
    if (!/^\d{1,9}$/.test(uid)) throw new Error("Unknown game");
    return Response.json(await jiliLaunch(me.playerId, uid));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.replace(/^.*?: /, "") : "Something went wrong" }, { status: 400 });
  }
}
