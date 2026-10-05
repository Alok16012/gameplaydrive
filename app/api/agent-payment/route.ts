import QRCode from "qrcode";
import { deleteRow, insertRow, patchRow, selectOne, upsertRow, userFromToken } from "../../lib/server/supabaseAdmin";

// GET    /api/agent-payment — retrieve payment details.
//        • If caller is an Agent / Admin / Super Admin: returns their own payment details.
//        • If caller is a Player: returns ONLY their direct parent agent's active payment details (strict isolation).
// POST   /api/agent-payment — save / update payment details (Agents & Admins only).
// DELETE /api/agent-payment — remove / delete payment details completely (Agents & Admins only).

interface Profile {
  id: string;
  code: string;
  role: "superadmin" | "admin" | "agent" | "player";
  name: string;
  phone: string | null;
  username: string | null;
  parent_id: string | null;
  status: string;
}

interface PaymentDetails extends Record<string, unknown> {
  agent_id?: string;
  upi_id?: string | null;
  qr_code_url?: string | null;
  payee_name?: string | null;
  phone?: string | null;
  payment_note?: string | null;
  is_active?: boolean;
  updated_at?: string;
}

interface SettingRow {
  key: string;
  value: PaymentDetails;
}

async function loadAgentPaymentDetails(agentId: string): Promise<PaymentDetails | null> {
  // First attempt from agent_payment_details table (if migration 019 has been executed)
  try {
    const row = await selectOne<PaymentDetails>("agent_payment_details", `agent_id=eq.${agentId}`);
    if (row) return row;
  } catch {
    // Table not created yet or schema cache not updated, fallback to app_settings
  }

  // Fallback to app_settings key
  try {
    const setting = await selectOne<SettingRow>("app_settings", `key=eq.agent_payment_${agentId}`);
    if (setting?.value) return setting.value;
  } catch {
    // app_settings lookup failed
  }

  return null;
}

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const profile = await selectOne<Profile>("profiles", `id=eq.${actor.id}`);
  if (!profile || profile.status !== "active") {
    return Response.json({ error: "Account not found or inactive" }, { status: 403 });
  }

  // Case 1: Player requesting payment details
  if (profile.role === "player") {
    if (!profile.parent_id) {
      return Response.json({
        hasPaymentDetails: false,
        message: "No agent is assigned to your player account.",
      });
    }

    const parent = await selectOne<Profile>("profiles", `id=eq.${profile.parent_id}`);
    if (!parent) {
      return Response.json({
        hasPaymentDetails: false,
        message: "Agent account not found.",
      });
    }

    const details = await loadAgentPaymentDetails(parent.id);
    const isActive = details?.is_active ?? true;
    const hasUpiOrQr = Boolean(details?.upi_id?.trim() || details?.qr_code_url?.trim());

    if (!details || !isActive || !hasUpiOrQr) {
      return Response.json({
        hasPaymentDetails: false,
        agentName: parent.name,
        agentCode: parent.code,
        agentPhone: details?.phone || parent.phone,
        message: `Agent ${parent.name} has not set up online UPI/QR details yet. Please contact them directly.`,
      });
    }

    return Response.json({
      hasPaymentDetails: true,
      agentId: parent.id,
      agentName: parent.name,
      agentCode: parent.code,
      agentPhone: details.phone || parent.phone,
      upiId: details.upi_id ?? null,
      payeeName: details.payee_name || parent.name,
      qrCodeUrl: details.qr_code_url ?? null,
      paymentNote: details.payment_note ?? null,
      isActive: true,
    });
  }

  // Case 2: Staff member (Agent / Admin / Super Admin) loading their own settings
  const myDetails = await loadAgentPaymentDetails(profile.id);

  return Response.json({
    isStaff: true,
    role: profile.role,
    agentName: profile.name,
    agentCode: profile.code,
    agentPhone: profile.phone,
    details: {
      upiId: myDetails?.upi_id ?? "",
      qrCodeUrl: myDetails?.qr_code_url ?? "",
      payeeName: myDetails?.payee_name ?? profile.name,
      phone: myDetails?.phone ?? profile.phone ?? "",
      paymentNote: myDetails?.payment_note ?? "Send screenshot after payment with your Player ID to get coins credited.",
      isActive: myDetails?.is_active ?? true,
    },
  });
}

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const profile = await selectOne<Profile>("profiles", `id=eq.${actor.id}`);
  if (!profile || profile.status !== "active") {
    return Response.json({ error: "Account not found or inactive" }, { status: 403 });
  }

  if (profile.role === "player") {
    return Response.json({ error: "Only agents and staff can update payment details" }, { status: 403 });
  }

  const b = await req.json().catch(() => null);
  let upiId = String(b?.upiId ?? "").trim();
  let payeeName = String(b?.payeeName ?? "").trim() || profile.name;
  let phone = String(b?.phone ?? "").trim() || (profile.phone ?? "");
  let paymentNote = String(b?.paymentNote ?? "").trim();
  let qrCodeUrl = String(b?.qrCodeUrl ?? "").trim();
  const isActive = b?.isActive !== false;
  const generateQr = Boolean(b?.generateQr);

  // Validate UPI ID format if provided
  if (upiId) {
    if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId)) {
      return Response.json({ error: "Invalid UPI ID format. Example: yourname@oksbi, mobile@paytm" }, { status: 400 });
    }
  }

  // Validate phone if provided (supports international numbers with country codes: 7 to 15 digits)
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      return Response.json({ error: "Enter a valid phone number (7 to 15 digits including country code)" }, { status: 400 });
    }
  }

  // Generate UPI QR code automatically if requested or if no custom image was provided
  if (upiId && (generateQr || !qrCodeUrl)) {
    try {
      const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&cu=INR`;
      qrCodeUrl = await QRCode.toDataURL(upiUri, {
        width: 480,
        margin: 2,
        color: {
          dark: "#0a0f2c",
          light: "#ffffff",
        },
        errorCorrectionLevel: "H",
      });
    } catch {
      // Ignore QR generation failure and proceed
    }
  }

  const record: PaymentDetails = {
    agent_id: profile.id,
    upi_id: upiId || null,
    qr_code_url: qrCodeUrl || null,
    payee_name: payeeName,
    phone: phone || null,
    payment_note: paymentNote || null,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  // 1. Save to app_settings so it works immediately
  try {
    await upsertRow("app_settings", {
      key: `agent_payment_${profile.id}`,
      value: record,
    });
  } catch (err) {
    console.error("Failed to save to app_settings:", err);
  }

  // 2. Also save to agent_payment_details table (if migration exists)
  try {
    await upsertRow("agent_payment_details", record);
  } catch {
    // Ignore if table does not exist
  }

  // 3. Write to audit_log
  try {
    await insertRow("audit_log", {
      actor_id: profile.id,
      actor_name: profile.username || profile.name,
      action: `${profile.role.toUpperCase()} ${profile.code} • Updated UPI / QR Payment Settings`,
      before: "—",
      after: `UPI: ${upiId || "None"} • Active: ${isActive ? "Yes" : "No"}`,
    });
  } catch (err) {
    console.error("Failed to write to audit_log:", err);
  }

  return Response.json({
    success: true,
    details: {
      upiId: record.upi_id ?? "",
      qrCodeUrl: record.qr_code_url ?? "",
      payeeName: record.payee_name ?? profile.name,
      phone: record.phone ?? profile.phone ?? "",
      paymentNote: record.payment_note ?? "",
      isActive: record.is_active ?? true,
    },
  });
}

export async function DELETE(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const profile = await selectOne<Profile>("profiles", `id=eq.${actor.id}`);
  if (!profile || profile.status !== "active") {
    return Response.json({ error: "Account not found or inactive" }, { status: 403 });
  }

  if (profile.role === "player") {
    return Response.json({ error: "Only agents and staff can delete payment details" }, { status: 403 });
  }

  // 1. Delete from app_settings
  try {
    await deleteRow("app_settings", `key=eq.agent_payment_${profile.id}`);
  } catch (err) {
    console.error("Failed to delete from app_settings:", err);
  }

  // 2. Delete from agent_payment_details table
  try {
    await deleteRow("agent_payment_details", `agent_id=eq.${profile.id}`);
  } catch {
    // If delete fails, attempt to nullify via patch
    try {
      await patchRow("agent_payment_details", `agent_id=eq.${profile.id}`, {
        upi_id: null,
        qr_code_url: null,
        is_active: false,
        payment_note: null,
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Ignore if table does not exist
    }
  }

  // 3. Write to audit_log
  try {
    await insertRow("audit_log", {
      actor_id: profile.id,
      actor_name: profile.username || profile.name,
      action: `${profile.role.toUpperCase()} ${profile.code} • Deleted UPI / QR Payment Method`,
      before: "Configured",
      after: "Deleted / Removed",
    });
  } catch (err) {
    console.error("Failed to write to audit_log:", err);
  }

  return Response.json({
    success: true,
    message: "Payment method deleted successfully",
  });
}

