import { loginEmail } from "../../lib/loginEmail";
import {
  insertRow,
  patchRow,
  selectOne,
  updateAuthUser,
  userFromToken,
} from "../../lib/server/supabaseAdmin";

// POST /api/change-password — let any signed-in user change their own password.
//   Body: { oldPassword: string, newPassword: string }
// The old password is verified by attempting a Supabase sign-in. On success the auth password
// is updated via the admin API and must_change_password is cleared.
//
// PATCH /api/change-password — let a higher-ranking user reset a subordinate's password.
//   Body: { targetId: string, newPassword: string }
// The actor must be above the target in the hierarchy (enforced here).

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

interface Profile {
  id: string;
  role: string;
  name: string;
  phone: string | null;
  username: string | null;
  parent_id: string | null;
  status: string;
}

const RANK: Record<string, number> = { superadmin: 0, admin: 1, agent: 2, player: 3 };

/** Walk up the parent chain to check `actorId` is an ancestor of `targetId`. */
async function isAncestor(actorId: string, targetId: string): Promise<boolean> {
  let current = targetId;
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const row = await selectOne<{ parent_id: string | null }>("profiles", `id=eq.${current}&select=parent_id`);
    if (!row?.parent_id) return false;
    if (row.parent_id === actorId) return true;
    if (seen.has(row.parent_id)) return false;
    seen.add(row.parent_id);
    current = row.parent_id;
  }
  return false;
}

// ── Self password change ──────────────────────────────────────────────
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const b = await req.json().catch(() => null);
  const oldPassword = String(b?.oldPassword ?? "");
  const newPassword = String(b?.newPassword ?? "");

  if (!oldPassword) return Response.json({ error: "Enter your current password" }, { status: 400 });
  if (newPassword.length < 6) return Response.json({ error: "New password must be at least 6 characters" }, { status: 400 });
  if (oldPassword === newPassword) return Response.json({ error: "New password must be different from the current one" }, { status: 400 });

  // Look up the actor's profile to find their login email
  const profile = await selectOne<Profile>("profiles", `id=eq.${actor.id}`);
  if (!profile) return Response.json({ error: "Account not found" }, { status: 404 });

  const email = loginEmail(profile);
  if (!email) return Response.json({ error: "Cannot determine login credentials" }, { status: 400 });

  // Verify old password by attempting a sign-in
  const verifyRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: oldPassword }),
    cache: "no-store",
  });
  if (!verifyRes.ok) {
    return Response.json({ error: "Current password is incorrect" }, { status: 400 });
  }

  // Set the new password via admin API
  try {
    await updateAuthUser(actor.id, { password: newPassword });
  } catch (e) {
    return Response.json({ error: "Failed to update password. Please try again." }, { status: 500 });
  }

  // Clear must_change_password flag
  try {
    await patchRow("profiles", `id=eq.${actor.id}`, { must_change_password: false });
  } catch {
    // Non-critical: the password was changed even if the flag didn't clear
  }

  // Audit log
  try {
    await insertRow("audit_log", {
      actor_id: actor.id,
      actor_name: profile.username || profile.name,
      action: "Changed password",
      before: "—",
      after: "Password updated by user",
    });
  } catch {}

  return Response.json({ success: true });
}

// ── Superior resets subordinate's password ────────────────────────────
export async function PATCH(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const b = await req.json().catch(() => null);
  const targetId = String(b?.targetId ?? "");
  const newPassword = String(b?.newPassword ?? "");

  if (!targetId) return Response.json({ error: "Missing target account" }, { status: 400 });
  if (newPassword.length < 6) return Response.json({ error: "New password must be at least 6 characters" }, { status: 400 });

  const actorProfile = await selectOne<Profile>("profiles", `id=eq.${actor.id}`);
  const targetProfile = await selectOne<Profile>("profiles", `id=eq.${targetId}`);
  if (!actorProfile) return Response.json({ error: "Your account was not found" }, { status: 404 });
  if (!targetProfile) return Response.json({ error: "Target account not found" }, { status: 404 });

  // Hierarchy check: actor must outrank target
  if (RANK[actorProfile.role] >= RANK[targetProfile.role]) {
    return Response.json({ error: "You can only change passwords of accounts below your role" }, { status: 403 });
  }

  // For admins and agents, also check they are in the target's ancestor chain
  if (actorProfile.role !== "superadmin") {
    const ancestor = await isAncestor(actor.id, targetId);
    if (!ancestor) {
      return Response.json({ error: "You can only change passwords of accounts in your own network" }, { status: 403 });
    }
  }

  // Set the new password
  try {
    await updateAuthUser(targetId, { password: newPassword });
  } catch (e) {
    return Response.json({ error: "Failed to update password. Please try again." }, { status: 500 });
  }

  // Set must_change_password so the user is forced to change on next login
  try {
    await patchRow("profiles", `id=eq.${targetId}`, { must_change_password: true });
  } catch {
    // Non-critical
  }

  // Audit log
  try {
    await insertRow("audit_log", {
      actor_id: actor.id,
      actor_name: actorProfile.username || actorProfile.name,
      action: "Password reset",
      before: "—",
      after: `Reset password for ${targetProfile.role} ${targetProfile.name} (${targetProfile.id})`,
    });
  } catch {}

  return Response.json({ success: true });
}
