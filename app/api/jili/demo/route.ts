import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { jiliDemoUrl } from "../../../lib/server/jili";

// GET /api/jili/demo?uid=879 — a free-play link for a JILI game (signed-in players only; our SoftAPI token stays on
// the server).
export async function GET(req: Request) {
  try {
    await callerFromRequest(req);
    const uid = new URL(req.url).searchParams.get("uid") ?? "";
    if (!/^\d{1,9}$/.test(uid)) throw new Error("Unknown game");
    return Response.json({ url: await jiliDemoUrl(uid) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Something went wrong" }, { status: 400 });
  }
}
