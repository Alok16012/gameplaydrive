import { playerEmail } from "../../lib/loginEmail";
import {
  createAuthUser,
  deleteAuthUser,
  rpc,
  selectOne,
} from "../../lib/server/supabaseAdmin";

interface Profile {
  id: string;
  code: string;
  role: string;
  name: string;
  phone: string | null;
  username: string | null;
  state: string | null;
  parent_id: string | null;
  status: string;
}

async function findParent(referralCode?: string | null): Promise<string | null> {
  if (!referralCode) return null;
  const raw = referralCode.trim();
  if (!raw) return null;

  // 1. Try matching unique account code (e.g. AGT-1234, ADM-1001, GH123456)
  const codeFormatted = raw.toUpperCase();
  let found = await selectOne<{ id: string; role: string; status: string }>(
    "profiles",
    `status=eq.active&code=eq.${encodeURIComponent(codeFormatted)}`
  ).catch(() => null);

  // 2. Try matching username (e.g. agent1, alok_agent)
  if (!found) {
    found = await selectOne<{ id: string; role: string; status: string }>(
      "profiles",
      `status=eq.active&username=eq.${encodeURIComponent(raw.toLowerCase())}`
    ).catch(() => null);
  }

  // 3. Try matching 10-digit mobile number if numeric
  if (!found && /^\d{10}$/.test(raw)) {
    found = await selectOne<{ id: string; role: string; status: string }>(
      "profiles",
      `status=eq.active&phone=eq.${raw}`
    ).catch(() => null);
  }

  // Ensure owner has permission to have players in their downline
  if (found && ["superadmin", "admin", "agent"].includes(found.role)) {
    return found.id;
  }
  return null;
}

async function getSuperAdmin(): Promise<{ id: string } | null> {
  const sa = await selectOne<{ id: string }>("profiles", "role=eq.superadmin&status=eq.active").catch(() => null);
  if (sa) return sa;
  // Fallback to any active admin if superadmin row is not immediately found
  return await selectOne<{ id: string }>("profiles", "role=eq.admin&status=eq.active").catch(() => null);
}

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => null);
    const name = String(b?.name ?? "").trim();
    const phone = String(b?.phone ?? "").replace(/\D/g, "");
    const password = String(b?.password ?? "");
    const state = b?.state ? String(b.state).trim() : null;
    const referralCode = b?.referralCode ? String(b.referralCode).trim() : null;

    if (!name || name.length < 2) {
      return Response.json({ error: "Please enter your full name (at least 2 characters)" }, { status: 400 });
    }
    if (!/^\d{10}$/.test(phone)) {
      return Response.json({ error: "Please enter a valid 10-digit mobile number" }, { status: 400 });
    }
    if (password.length < 6) {
      return Response.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    // 1. Check if phone is already registered in profiles
    const existing = await selectOne<{ id: string; role: string }>("profiles", `phone=eq.${phone}`).catch(() => null);
    if (existing) {
      return Response.json({
        error: "An account with this mobile number already exists. Please login instead.",
        exists: true,
      }, { status: 400 });
    }

    // 2. Resolve SuperAdmin / System actor
    const superAdmin = await getSuperAdmin();
    if (!superAdmin) {
      return Response.json({ error: "Self-registration is temporarily unavailable. Please contact support." }, { status: 500 });
    }

    // 3. Resolve parent downline owner (Referred Agent / Admin or root SuperAdmin)
    let parentId = superAdmin.id;
    if (referralCode) {
      const resolvedParent = await findParent(referralCode);
      if (!resolvedParent) {
        return Response.json({
          error: "Referral / Agent code not found. Please verify the code or clear it.",
        }, { status: 400 });
      }
      parentId = resolvedParent;
    }

    // 4. Create Supabase Auth user
    const email = playerEmail(phone);
    let authUser: { id: string };
    try {
      authUser = await createAuthUser(email, password);
    } catch (authErr) {
      const msg = authErr instanceof Error ? authErr.message : "Auth creation error";
      if (/already been registered|already exists|duplicate key/i.test(msg)) {
        return Response.json({
          error: "This mobile number is already registered. Please login.",
          exists: true,
        }, { status: 400 });
      }
      return Response.json({ error: `Could not create login credentials: ${msg}` }, { status: 400 });
    }

    // 5. Create Profile & Wallet via DB RPC
    let profile: Profile;
    try {
      profile = await rpc<Profile>("create_profile", {
        p_id: authUser.id,
        p_actor: superAdmin.id,
        p_role: "player",
        p_name: name,
        p_phone: phone,
        p_username: null,
        p_parent: parentId,
        p_state: state || null,
      });
    } catch (rpcErr) {
      // Rollback Auth user if profile RPC fails
      await deleteAuthUser(authUser.id).catch(() => {});
      const msg = rpcErr instanceof Error ? rpcErr.message : "Profile creation failed";
      return Response.json({ error: `Could not complete profile registration: ${msg}` }, { status: 400 });
    }

    return Response.json({
      success: true,
      profile: {
        id: profile.id,
        code: profile.code,
        name: profile.name,
        phone: profile.phone,
        state: profile.state,
      },
    });
  } catch (err) {
    console.error("Player self-registration unexpected error:", err);
    return Response.json({ error: "An unexpected error occurred during registration. Please try again." }, { status: 500 });
  }
}
