import { insertRow, selectOne, upsertRow, userFromToken } from "../../lib/server/supabaseAdmin";

// POST /api/login-event — record the caller's IP address for this sign-in / app open (table from migration 056).
// The same account from the same IP is recorded at most once every 30 minutes, each time also as a "Signed in"
// Audit Log entry about that account (with the IP), which its agent / admin can see (migration 100).

const REPEAT_MS = 30 * 60 * 1000;

/** The visitor's IP (Netlify's header, else the first X-Forwarded-For hop as Vercel sends it). */
function clientIp(req: Request) {
  const h = req.headers;
  return (h.get("x-nf-client-connection-ip") || h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "").trim();
}

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const ip = clientIp(req);
  if (!ip) return Response.json({ ok: false });
  try {
    const since = new Date(Date.now() - REPEAT_MS).toISOString();
    const recent = await selectOne<{ id: number }>(
      "login_events",
      `select=id&user_id=eq.${actor.id}&ip=eq.${encodeURIComponent(ip)}&created_at=gte.${encodeURIComponent(since)}`,
    );
    if (!recent) {
      await insertRow("login_events", { user_id: actor.id, ip, user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300) });
      const me = await selectOne<{ name: string; username: string | null; code: string }>("profiles", `select=name,username,code&id=eq.${actor.id}`);
      await insertRow("audit_log", {
        actor_id: actor.id, actor_name: me?.username || me?.name || "system", target_id: actor.id,
        action: `Signed in${me ? ` • ${me.code} (${me.name})` : ""} • IP ${ip}`, before: null, after: null,
      }).catch((e) => console.warn("Could not write sign-in audit entry:", e));
      await upsertRow("presence", { user_id: actor.id, last_seen: new Date().toISOString() }).catch(() => {});
    }
    return Response.json({ ok: true });
  } catch (e) {
    // Most likely migration 056 hasn't been run yet; never block the sign-in over it.
    console.warn("Could not record login IP:", e);
    return Response.json({ ok: false });
  }
}
