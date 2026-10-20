import { insertRow, selectOne, upsertRow, userFromToken } from "../../lib/server/supabaseAdmin";

// GET  /api/support-contact — fetch current WhatsApp support and "Contact for ID" configuration
// POST /api/support-contact — update WhatsApp support number, custom note and pre-filled message (Super Admin & Admin)

export interface SupportContactSettings {
  whatsapp?: string;
  note?: string;
  message?: string;
}

const DEFAULT_MESSAGE = "Hello, I want to get an ID for Khelobaazi. Please create my account.";

export async function GET() {
  try {
    const row = await selectOne<{ key: string; value: SupportContactSettings }>(
      "app_settings",
      "key=eq.support"
    );
    const value = row?.value || {};
    return Response.json({
      whatsapp: value.whatsapp || "",
      note: value.note || "24x7 Instant ID & Quick Support",
      message: value.message || DEFAULT_MESSAGE,
    });
  } catch (err) {
    console.warn("Could not fetch support settings:", err);
    return Response.json({
      whatsapp: "",
      note: "24x7 Instant ID & Quick Support",
      message: DEFAULT_MESSAGE,
    });
  }
}

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  // Verify actor has superadmin or admin role
  const profile = await selectOne<{ role: string; name: string; username: string | null }>(
    "profiles",
    `id=eq.${actor.id}`
  );
  if (!profile || !["superadmin", "admin"].includes(profile.role)) {
    return Response.json(
      { error: "Only an Admin or Super Admin can change the WhatsApp contact settings" },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => null);
  const rawNum = String(body?.whatsapp ?? "").trim();
  let num = rawNum.replace(/\D/g, "");

  if (num.length === 10) {
    num = "91" + num;
  }

  if (num !== "" && (num.length < 11 || num.length > 15)) {
    return Response.json(
      { error: "Please enter a valid 10-digit mobile number or full number with country code" },
      { status: 400 }
    );
  }

  const note = String(body?.note ?? "").trim().slice(0, 140);
  const message = String(body?.message ?? "").trim().slice(0, 300) || DEFAULT_MESSAGE;

  try {
    const prev = await selectOne<{ key: string; value: SupportContactSettings }>(
      "app_settings",
      "key=eq.support"
    );

    const newSetting: SupportContactSettings = {
      whatsapp: num || undefined,
      note: note || undefined,
      message: message || undefined,
    };

    await upsertRow("app_settings", {
      key: "support",
      value: newSetting,
    });

    // Write to audit log
    await insertRow("audit_log", {
      actor_id: actor.id,
      actor_name: profile.username || profile.name || "Admin",
      action: "WhatsApp contact for ID changed",
      before: JSON.stringify(prev?.value || {}),
      after: JSON.stringify(newSetting),
    }).catch((e) => console.warn("Audit log error:", e));

    return Response.json({
      success: true,
      support: {
        whatsapp: num,
        note,
        message,
      },
    });
  } catch (err) {
    console.error("Failed to save support contact:", err);
    return Response.json({ error: "Failed to save support settings" }, { status: 500 });
  }
}
