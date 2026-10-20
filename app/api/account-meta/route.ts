import { selectAll, selectOne, upsertRow, userFromToken } from "../../lib/server/supabaseAdmin";

// GET  /api/account-meta?id=<accountId> — Fetch exchange partnership & points metadata for an account.
//      With an id it also returns live `stats` from the ledger: the account's own deposits / withdrawals, and the
//      turnover, client P/L and open exposure of every player under it (or of the player itself), plus each side's
//      share of the P/L per the saved User Part / Our Part. Needs the caller's token; only the Super Admin and the
//      account's upline may read it.
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
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  try {
    const row = await selectOne<{ key: string; value: Record<string, UserExchangeMeta> }>(
      "app_settings",
      "key=eq.accounts_exchange_meta"
    );
    const allMeta = row?.value || {};
    if (id) {
      const meta = allMeta[id] || null;
      const profiles = await selectAll<Profile>("profiles", "select=id,parent_id,role");
      if (!canSee(profiles, actor.id, id)) return Response.json({ error: "Not allowed" }, { status: 403 });
      const stats = await liveStats(id, meta, profiles).catch((err) => {
        console.warn("Could not compute client P/L:", err);
        return null;
      });
      return Response.json({ meta, stats });
    }
    const me = await selectOne<Profile>("profiles", `select=id,parent_id,role&id=eq.${actor.id}`);
    if (me?.role !== "superadmin") return Response.json({ error: "Not allowed" }, { status: 403 });
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

type Profile = { id: string; parent_id: string | null; role: string };

/** The Super Admin sees everyone; anyone else only themselves and their downline. */
function canSee(profiles: Profile[], actorId: string, targetId: string) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  if (byId.get(actorId)?.role === "superadmin") return true;
  for (let cur = byId.get(targetId); cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    if (cur.id === actorId) return true;
  }
  return false;
}

export interface AccountStats {
  /** Settled net win (+) / loss (−) of the players under the account (or the player itself): bets, wins, refunds,
   *  with stakes still riding on open cricket bets left out until they settle. */
  clientPL: number;
  /** The account's own share: −clientPL × userPart%. Positive means profit for them. */
  userShare: number;
  /** Upline's share: −clientPL × ourPart%. */
  ourShare: number;
  /** Current wallet balance. */
  pts: number;
  players: number;
  /** Coins put into / taken out of this account's own wallet (transfers, mints, burns). */
  deposits: number;
  withdrawals: number;
  /** Total staked, and paid back as wins + refunds, by those players. */
  turnover: number;
  returns: number;
  /** Coins locked in open cricket bets, and how many such bets. */
  exposure: number;
  openBets: number;
}

async function liveStats(id: string, meta: UserExchangeMeta | null, profiles: Profile[]): Promise<AccountStats> {
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

  let gameNet = 0;
  let turnover = 0;
  let returns = 0;
  let exposure = 0;
  let openBets = 0;
  for (let i = 0; i < players.length; i += 100) {
    const ids = players.slice(i, i + 100).join(",");
    const [rows, open] = await Promise.all([
      selectAll<{ amount: number; kind: string }>("ledger", `select=amount,kind&order=id&kind=in.(bet,win,refund)&user_id=in.(${ids})`),
      selectAll<{ exposure: number }>("sport_bets", `select=exposure&order=id&status=eq.OPEN&user_id=in.(${ids})`),
    ]);
    for (const r of rows) {
      const amt = Number(r.amount);
      gameNet += amt;
      if (r.kind === "bet") turnover -= amt;
      else returns += amt;
    }
    for (const b of open) exposure += Number(b.exposure);
    openBets += open.length;
  }
  // An open cricket bet's exposure is already debited as a bet; it is neither won nor lost yet.
  const clientPL = gameNet + exposure;

  let deposits = 0;
  let withdrawals = 0;
  const own = await selectAll<{ amount: number }>("ledger", `select=amount&order=id&kind=in.(transfer_in,transfer_out,mint,burn)&user_id=eq.${id}`);
  for (const r of own) {
    const amt = Number(r.amount);
    if (amt > 0) deposits += amt;
    else withdrawals -= amt;
  }

  const wallet = await selectOne<{ coins: number }>("wallets", `select=coins&user_id=eq.${id}`);
  const userPart = meta?.userPart ?? 0;
  const ourPart = meta?.ourPart ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100 || 0;
  return {
    clientPL,
    userShare: round((-clientPL * userPart) / 100),
    ourShare: round((-clientPL * ourPart) / 100),
    pts: Number(wallet?.coins ?? 0),
    players: players.length,
    deposits,
    withdrawals,
    turnover,
    returns,
    exposure,
    openBets,
  };
}
