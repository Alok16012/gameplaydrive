import { selectAll, selectOne, upsertRow, userFromToken } from "../../lib/server/supabaseAdmin";

// GET  /api/account-meta?id=<accountId> — Fetch exchange partnership & points metadata for an account.
//      With an id it also returns live `stats`: the client P/L of every player under that account (from the ledger)
//      and each side's share of it per the saved User Part / Our Part.
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
      const meta = allMeta[id] || null;
      const stats = await liveStats(id, meta).catch((err) => {
        console.warn("Could not compute client P/L:", err);
        return null;
      });
      return Response.json({ meta, stats });
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
  // Client P/L and points are computed from the ledger, never stored.
  delete metaUpdate.clientPL;
  delete metaUpdate.availablePts;
  for (const k of ["userPart", "ourPart"] as const) {
    if (metaUpdate[k] === undefined) continue;
    const v = Number(metaUpdate[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return Response.json({ error: "User Part / Our Part must be between 0 and 100" }, { status: 400 });
    }
    metaUpdate[k] = v;
  }
  if ((metaUpdate.userPart ?? 0) + (metaUpdate.ourPart ?? 0) > 100) {
    return Response.json({ error: "User Part + Our Part cannot be more than 100" }, { status: 400 });
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

export interface AccountStats {
  /** Net win (+) / loss (−) of all players under the account, from bets, wins and refunds. */
  clientPL: number;
  /** The account's own share: −clientPL × userPart%. Positive means profit for them. */
  userShare: number;
  /** Upline's share: −clientPL × ourPart%. */
  ourShare: number;
  pts: number;
  players: number;
}

async function liveStats(id: string, meta: UserExchangeMeta | null): Promise<AccountStats> {
  const profiles = await selectAll<{ id: string; parent_id: string | null; role: string }>(
    "profiles",
    "select=id,parent_id,role"
  );
  const kids = new Map<string, string[]>();
  for (const p of profiles) {
    if (!p.parent_id) continue;
    kids.set(p.parent_id, [...(kids.get(p.parent_id) || []), p.id]);
  }
  const role = new Map(profiles.map((p) => [p.id, p.role]));
  const players: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (role.get(cur) === "player") players.push(cur);
    stack.push(...(kids.get(cur) || []));
  }

  let clientPL = 0;
  for (let i = 0; i < players.length; i += 100) {
    const ids = players.slice(i, i + 100).join(",");
    const rows = await selectAll<{ amount: number }>(
      "ledger",
      `select=amount&order=id&kind=in.(bet,win,refund)&user_id=in.(${ids})`
    );
    for (const r of rows) clientPL += Number(r.amount);
  }

  const wallet = await selectOne<{ coins: number }>("wallets", `select=coins&user_id=eq.${id}`);
  const userPart = meta?.userPart ?? 87;
  const ourPart = meta?.ourPart ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100 || 0;
  return {
    clientPL,
    userShare: round((-clientPL * userPart) / 100),
    ourShare: round((-clientPL * ourPart) / 100),
    pts: Number(wallet?.coins ?? 0),
    players: players.length,
  };
}
