import { rpc, selectAll, userFromToken } from "../../lib/server/supabaseAdmin";

// GET /api/pl — lifetime game P&L of every account the caller may see: { pl: { [accountId]: net } }, where net is
// the account's own wins + refunds − bets (open cricket stakes not counted as lost). Accounts with no bets are
// left out. The Super Admin sees everyone; anyone else themselves and their downline. Needs migration 059.

type Profile = { id: string; parent_id: string | null; role: string };

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  try {
    const profiles = await selectAll<Profile>("profiles", "select=id,parent_id,role");
    const me = profiles.find((p) => p.id === actor.id);
    if (!me || me.role === "player") return Response.json({ error: "Not allowed" }, { status: 403 });

    let visible: Set<string> | null = null;
    if (me.role !== "superadmin") {
      const kids = new Map<string, string[]>();
      for (const p of profiles) if (p.parent_id) kids.set(p.parent_id, [...(kids.get(p.parent_id) ?? []), p.id]);
      visible = new Set<string>();
      const stack = [me.id];
      while (stack.length) {
        const cur = stack.pop()!;
        visible.add(cur);
        stack.push(...(kids.get(cur) ?? []));
      }
    }

    const rows = await rpc<{ user_id: string; net: number }[]>("game_pl_by_user", {});
    const pl: Record<string, number> = {};
    for (const r of rows) if (!visible || visible.has(r.user_id)) pl[r.user_id] = Number(r.net);
    return Response.json({ pl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return Response.json({ error: /game_pl_by_user/.test(msg) ? "Run migration 059 first" : "Could not load P&L" }, { status: 500 });
  }
}
