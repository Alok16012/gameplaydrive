import { callerFromRequest } from "../../../lib/server/teenpattiAuth";
import { jiliGames, jiliHidden } from "../../../lib/server/jili";
import { selectOne } from "../../../lib/server/supabaseAdmin";

// GET /api/jili/games — the JILI catalogue for the in-app lobby: { games: [{ uid, name, category, logo }] }, without
// the games the Super Admin switched off. ?all=1 (Super Admin only) returns every game with its "hidden" flag, for
// Admin → JILI Games.
export async function GET(req: Request) {
  try {
    const me = await callerFromRequest(req);
    const [games, hidden] = await Promise.all([jiliGames(), jiliHidden()]);
    if (new URL(req.url).searchParams.get("all") === "1") {
      const p = await selectOne<{ role: string }>("profiles", `select=role&id=eq.${me.playerId}`);
      if (p?.role !== "superadmin") return Response.json({ error: "Not allowed" }, { status: 403 });
      return Response.json({ games: games.map((g) => ({ ...g, hidden: hidden.has(g.uid) })) });
    }
    return Response.json({ games: games.filter((g) => !hidden.has(g.uid)) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Something went wrong" }, { status: 400 });
  }
}
