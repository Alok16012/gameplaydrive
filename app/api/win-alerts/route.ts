import { rpc, selectAll, userFromToken } from "../../lib/server/supabaseAdmin";

// GET /api/win-alerts?days=7 — players whose net winnings (wins + refunds − bets) in the last `days` days have
// reached twice what they deposited in that time (coins sent by an agent or minted to them); days=0 is all time.
// The Super Admin sees every player; anyone else only players in their downline. Figures come from win_alerts()
// (migration 090), computed in the database.

type Profile = { id: string; parent_id: string | null; role: string };

export interface WinAlert {
  id: string; code: string; name: string; username: string | null; parent_id: string | null;
  deposits: number; bets: number; wins: number; refunds: number; net: number; multiple: number; balance: number;
  lastWinAt: string | null;
}

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(0, Math.floor(raw))) : 7;

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

    const all = await rpc<WinAlert[]>("win_alerts", { p_days: days });
    const alerts = (all ?? []).filter((a) => !visible || visible.has(a.id)).map((a) => ({ ...a, multiple: Number(a.multiple) }));
    return Response.json({ alerts, days });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return Response.json({ error: /win_alerts/.test(msg) ? "Run migration 090 first" : "Could not load alerts" }, { status: 500 });
  }
}
