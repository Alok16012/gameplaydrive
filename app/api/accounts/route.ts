import { staffEmail, playerEmail } from "../../lib/loginEmail";
import {
  createAuthUser,
  deleteAuthUser,
  deleteRow,
  insertRow,
  patchRow,
  rpc,
  selectOne,
  updateAuthUser,
  upsertRow,
  userFromToken,
} from "../../lib/server/supabaseAdmin";

// POST   /api/accounts — create an admin, agent or player login under the signed-in account.
// PATCH  /api/accounts — edit an account's details (and optionally set a new password).
// DELETE /api/accounts — delete an admin, agent or player account (Super Admin only).
// The hierarchy rules are enforced in the database: public.create_profile and public.update_profile.

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
    const profile = await rpc<Profile>("create_profile", {
      p_id: authId, p_actor: actor.id, p_role: role, p_name: name, p_phone: phone || null,
      p_username: role === "player" ? null : username, p_parent: b?.parentId ?? null, p_state: b?.state ?? null,
    });

    if (b?.meta && authId) {
      try {
        const row = await selectOne<{ key: string; value: Record<string, unknown> }>(
          "app_settings",
          "key=eq.accounts_exchange_meta"
        );
        const allMeta = row?.value || {};
        allMeta[authId] = b.meta;
        await upsertRow("app_settings", {
          key: "accounts_exchange_meta",
          value: allMeta,
        });
      } catch (mErr) {
        console.warn("Could not save initial account meta:", mErr);
      }
    }

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

interface Profile { id: string; role: string; name: string; phone: string | null; username: string | null; state: string | null; code?: string; status?: string }
const loginOf = (p: Profile) => (p.role === "player" ? (p.phone ? playerEmail(p.phone) : null) : p.username ? staffEmail(p.username) : null);

export async function PATCH(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const b = await req.json().catch(() => null);
  const id = String(b?.id ?? "");
  const password = b?.password ? String(b.password) : "";
  if (!id) return Response.json({ error: "Missing account" }, { status: 400 });
  if (password && password.length < 6) return Response.json({ error: "Password must be at least 6 characters" }, { status: 400 });

  let res: { old: Profile; new: Profile };
  try {
    // Checks the editor may edit this account, validates the details and writes the audit log.
    res = await rpc("update_profile", {
      p_actor: actor.id, p_target: id, p_name: b?.name ?? "", p_phone: b?.phone ?? "", p_username: b?.username ?? "",
      p_state: b?.state ?? "", p_password_reset: !!password,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not save";
    return Response.json({ error: /could not find the function/i.test(msg) ? "Editing isn't switched on yet: the database needs migration 007" : msg }, { status: 400 });
  }

  // Keep the login in step: players sign in with their mobile number, staff with their username.
  const before = loginOf(res.old), after = loginOf(res.new);
  try {
    if ((after && after !== before) || password) {
      await updateAuthUser(id, { ...(after && after !== before ? { email: after } : {}), ...(password ? { password } : {}) });
    }
  } catch (e) {
    // Put the details back so the account still matches its login.
    await patchRow("profiles", `id=eq.${id}`, { name: res.old.name, phone: res.old.phone, username: res.old.username, state: res.old.state }).catch(() => {});
    const msg = e instanceof Error ? e.message : "";
    return Response.json({ error: /already|exists|registered/i.test(msg) ? "That mobile number or username is already used by a login" : "Could not update the login — nothing was changed" }, { status: 400 });
  }
  return Response.json({ profile: res.new });
}

export async function DELETE(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  // 1. Verify caller is Super Admin
  const actorProfile = await selectOne<Profile>("profiles", `id=eq.${actor.id}`);
  if (!actorProfile || actorProfile.status !== "active" || actorProfile.role !== "superadmin") {
    return Response.json({ error: "Only Super Admin can delete accounts" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  let id = searchParams.get("id");
  if (!id) {
    const body = await req.json().catch(() => null);
    id = body?.id ? String(body.id) : null;
  }
  if (!id) return Response.json({ error: "Missing account ID" }, { status: 400 });

  if (id === actor.id) {
    return Response.json({ error: "Super Admin cannot delete their own account" }, { status: 400 });
  }

  const target = await selectOne<Profile>("profiles", `id=eq.${id}`);
  if (!target) return Response.json({ error: "Account not found" }, { status: 404 });

  if (target.role === "superadmin") {
    return Response.json({ error: "Super Admin account cannot be deleted" }, { status: 400 });
  }

  // 2. Reassign any children downlines to Super Admin (actor.id) so foreign keys aren't violated
  try {
    await patchRow("profiles", `parent_id=eq.${id}`, { parent_id: actor.id });
  } catch (err) {
    console.error("Failed to reassign downlines:", err);
  }

  // 3. Remove agent payment details and app_settings if target was an agent/admin
  try {
    await deleteRow("agent_payment_details", `agent_id=eq.${id}`);
  } catch {}
  try {
    await deleteRow("app_settings", `key=eq.agent_payment_${id}`);
  } catch {}

  // 4. Delete Auth user (cascades to profiles, wallets, ledger, etc.)
  let authDeleted = false;
  try {
    await deleteAuthUser(id);
    authDeleted = true;
  } catch (err) {
    console.error("deleteAuthUser error:", err);
  }

  // 5. Delete profile directly in case auth user didn't cascade
  try {
    await deleteRow("profiles", `id=eq.${id}`);
  } catch (err) {
    if (!authDeleted) {
      const msg = err instanceof Error ? err.message : "Failed to delete account";
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  // 6. Write to audit_log
  try {
    await insertRow("audit_log", {
      actor_id: actor.id,
      actor_name: actorProfile.username || actorProfile.name,
      action: `SUPERADMIN • Deleted ${target.role.toUpperCase()} ${target.code || ""} (${target.name})`,
      before: `Role: ${target.role} • Name: ${target.name}`,
      after: "Deleted permanently",
    });
  } catch (err) {
    console.error("Audit log error:", err);
  }

  return Response.json({ success: true, message: `${target.name} deleted successfully` });
}

