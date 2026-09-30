import { staffEmail, playerEmail } from "../../lib/loginEmail";
import { createAuthUser, deleteAuthUser, rpc, userFromToken } from "../../lib/server/supabaseAdmin";

// POST /api/accounts — create an admin, agent or player login under the signed-in account.
// The hierarchy rules (who may create whom, and under which owner) are enforced in public.create_profile.

const ROLES = ["admin", "agent", "player"] as const;

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const b = await req.json().catch(() => null);
  const role = b?.role as (typeof ROLES)[number];
  const name = String(b?.name ?? "").trim();
  const phone = String(b?.phone ?? "");
  const username = b?.username ? String(b.username).trim().toLowerCase() : null;
  const password = String(b?.password ?? "");
  if (!ROLES.includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });
  if (!name) return Response.json({ error: "Enter a name" }, { status: 400 });
  if (phone && !/^\d{10}$/.test(phone)) return Response.json({ error: "Enter a 10-digit mobile number" }, { status: 400 });
  if (role === "player" && !phone) return Response.json({ error: "Players need a mobile number to sign in" }, { status: 400 });
  if (role !== "player" && !/^[a-z0-9._]{3,}$/.test(username ?? "")) return Response.json({ error: "Username: at least 3 letters, numbers, dots or underscores" }, { status: 400 });
  if (password.length < 6) return Response.json({ error: "Password must be at least 6 characters" }, { status: 400 });

  let authId: string | null = null;
  try {
    const email = role === "player" ? playerEmail(phone) : staffEmail(username!);
    authId = (await createAuthUser(email, password)).id;
    const profile = await rpc("create_profile", {
      p_id: authId, p_actor: actor.id, p_role: role, p_name: name, p_phone: phone || null,
      p_username: role === "player" ? null : username, p_parent: b?.parentId ?? null, p_state: b?.state ?? null,
    });
    return Response.json({ profile });
  } catch (e) {
    if (authId) await deleteAuthUser(authId).catch(() => {});
    const msg = e instanceof Error ? e.message : "Could not create account";
    const friendly = /already been registered|already exists|duplicate key/i.test(msg)
      ? role === "player" ? "A player with this mobile number already exists" : "That username or mobile number is taken"
      : msg;
    return Response.json({ error: friendly }, { status: 400 });
  }
}
