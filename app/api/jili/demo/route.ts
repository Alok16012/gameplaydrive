import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { jiliDemoUrl } from "../../../lib/server/jili";

// GET /api/jili/demo?game=super-ace — a free-play link for one of our JILI games (signed-in players only; our
// SoftAPI token stays on the server).
export async function GET(req: Request) {
  try {
    await callerFromRequest(req);
    const game = new URL(req.url).searchParams.get("game") ?? "";
    return Response.json({ url: await jiliDemoUrl(game) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Something went wrong" }, { status: 400 });
  }
}
