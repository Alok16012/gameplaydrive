import { selectOne, upsertRow, userFromToken } from "../../lib/server/supabaseAdmin";

// GET  /api/account-meta?id=<accountId> — Fetch exchange partnership & points metadata for an account.
// POST /api/account-meta — Update exchange partnership & points metadata for an account.

export interface UserExchangeMeta {
  partnershipName?: string;
  userPart?: number;
  ourPart?: number;
  remark?: string;
  city?: string;
  creditPts?: number;
  availablePts?: number;
  clientPL?: number;
  exposure?: number;
  casinoPts?: number;
  sportsPts?: number;
  thirdPartyPts?: number;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  try {
    const row = await selectOne<{ key: string; value: Record<string, UserExchangeMeta> }>(
      "app_settings",
      "key=eq.accounts_exchange_meta"
    );
    const allMeta = row?.value || {};
    if (id) {
      return Response.json({ meta: allMeta[id] || null });
    }
    return Response.json({ meta: allMeta });
  } catch (err) {
    console.warn("Could not fetch accounts_exchange_meta:", err);
    return Response.json({ meta: {} });
  }
}

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  const metaUpdate = body?.meta as UserExchangeMeta | undefined;

  if (!id || !metaUpdate) {
    return Response.json({ error: "Missing account ID or meta data" }, { status: 400 });
  }

  try {
    const row = await selectOne<{ key: string; value: Record<string, UserExchangeMeta> }>(
      "app_settings",
      "key=eq.accounts_exchange_meta"
    );
    const allMeta = row?.value || {};
    allMeta[id] = {
      ...(allMeta[id] || {}),
      ...metaUpdate,
    };

    await upsertRow("app_settings", {
      key: "accounts_exchange_meta",
      value: allMeta,
    });

    return Response.json({ success: true, meta: allMeta[id] });
  } catch (err) {
    console.error("Failed to save accounts_exchange_meta:", err);
    return Response.json({ error: "Failed to save metadata" }, { status: 500 });
  }
}
