import { selectAll, userFromToken } from "../../lib/server/supabaseAdmin";

// GET /api/ip-alerts?days=7 — IP addresses that more than one account signed in from within the last `days`
// days (default 7, at most 30), newest first. The Super Admin sees every account; anyone else only themselves and
// their downline, and an IP is reported only when at least two of those accounts used it.

type Profile = { id: string; parent_id: string | null; role: string; code: string; name: string; username: string | null };

export interface IpAlert {
  ip: string;
  lastAt: string;
  accounts: { id: string; code: string; name: string; role: string; username: string | null; logins: number; lastAt: string; device: string }[];
}

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const days = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const profiles = await selectAll<Profile>("profiles", "select=id,parent_id,role,code,name,username");
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const me = byId.get(actor.id);
    if (!me || me.role === "player") return Response.json({ error: "Not allowed" }, { status: 403 });

    // Accounts the caller may see: everyone for the Super Admin, otherwise themselves and their downline.
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

    const events = await selectAll<{ user_id: string; ip: string; user_agent: string | null; created_at: string }>(
      "login_events",
      `select=user_id,ip,user_agent,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc`,
    );

    const byIp = new Map<string, Map<string, IpAlert["accounts"][number]>>();
    for (const e of events) {
      if (visible && !visible.has(e.user_id)) continue;
      const p = byId.get(e.user_id);
      if (!p) continue;
      const users = byIp.get(e.ip) ?? new Map();
      const u = users.get(e.user_id);
      // Events come newest first, so the first one seen per account is its latest.
      if (u) u.logins += 1;
      else users.set(e.user_id, { id: p.id, code: p.code, name: p.name, role: p.role, username: p.username, logins: 1, lastAt: e.created_at, device: device(e.user_agent) });
      byIp.set(e.ip, users);
    }

    const alerts: IpAlert[] = [];
    for (const [ip, users] of byIp) {
      if (users.size < 2) continue;
      const accounts = [...users.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      alerts.push({ ip, lastAt: accounts[0].lastAt, accounts });
    }
    alerts.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return Response.json({ alerts, days });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return Response.json({ error: /login_events/.test(msg) ? "Run migration 056 first" : "Could not load alerts" }, { status: 500 });
  }
}

/** A short device label from a user agent, e.g. "Android • Chrome". */
function device(ua: string | null) {
  if (!ua) return "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" • ");
}
