// Server side of Classic Teen Patti: loads a table row, runs the pure engine / table logic, and commits the result
// atomically through tp2_commit (migration 066) with a compare-and-swap on the row version. Concurrent requests
// for one table are serialised by that: the loser gets TP2_STALE and simply reloads and retries. Import from route
// handlers only (service role).

import { randomInt, randomUUID } from "node:crypto";
import { insertRow, rpc, selectAll, selectOne } from "./supabaseAdmin";
import type { Command, Ctx, HandState, Rng, Rules } from "../teenpatti/engine";
import { advanceTable, command, fillBots, seatOf, sitDown, standUp, touch, waitingForPlayers, type TableLedgerEntry, type TableSeat, type TableState } from "../teenpatti/table";
import { viewFor, type HandView } from "../teenpatti/view";

/** Cryptographically secure RNG for the deal. */
export const rng: Rng = { int: (n) => (n <= 1 ? 0 : randomInt(n)), uuid: () => randomUUID() };

interface Row {
  id: string; code: string | null; boot: number; rules: Rules; seats: TableSeat[]; dealer_seat: number | null;
  hand_no: number; hand: HandState | null; next_hand_at: string | null; version: number;
}

const fromRow = (r: Row): TableState & { version: number } => ({
  id: r.id, code: r.code, boot: Number(r.boot), rules: r.rules, seats: r.seats ?? [], dealerSeat: r.dealer_seat,
  handNo: r.hand_no, hand: r.hand, nextHandAt: r.next_hand_at ? new Date(r.next_hand_at).getTime() : null, version: Number(r.version),
});

/** The table row, with the admin's current settings (fee, turn time, blind limit) laid over the rules saved with
 *  it — so a change in Game Config applies to every table from its next hand, not only to new tables. */
export async function loadTable(id: string) {
  const r = await selectOne<Row>("tp2_tables", `select=*&id=eq.${id}`);
  if (!r) return null;
  const t = fromRow(r);
  const live = await rulesFor(t.boot);
  return { ...t, rules: { ...t.rules, turnTimeoutMs: live.turnTimeoutMs, blindLimit: live.blindLimit, rakePct: live.rakePct } };
}

/** Admin → Game Config for Teen Patti, refreshed every 30 s (one lookup serves every poll in that window). */
let cfgCache: { at: number; cfg: Record<string, unknown> } | null = null;
async function gameCfg(): Promise<Record<string, unknown>> {
  if (cfgCache && Date.now() - cfgCache.at < 30000) return cfgCache.cfg;
  const cfg = await rpc<Record<string, unknown>>("game_cfg", { p_game: "teen-patti" }).catch(() => cfgCache?.cfg ?? ({} as Record<string, unknown>));
  cfgCache = { at: Date.now(), cfg: cfg ?? {} };
  return cfgCache.cfg;
}

/** Table rules from the Admin → Game Config settings for Teen Patti (fee, turn time, blind limit). */
export async function rulesFor(boot: number): Promise<Rules> {
  const cfg = await gameCfg();
  const turn = Number(cfg?.turn) || 15;
  const blindLimit = Math.max(1, Number(cfg?.blind_limit) || 3);
  const rakePct = cfg?.rake === undefined || cfg?.rake === null ? 5 : Math.min(25, Math.max(0, Number(cfg.rake) || 0));
  return { boot, maxBaseStake: boot * 128, potCap: boot * 1024, turnTimeoutMs: turn * 1000, sideshowTimeoutMs: 10000, maxTurnActions: null, minBlind: 1, blindLimit, rakePct };
}

async function balancesFor(t: TableState, extra: string[] = []): Promise<Record<string, number>> {
  const ids = [...new Set([...t.seats.filter((s) => !s.bot).map((s) => s.playerId), ...extra])];
  if (!ids.length) return {};
  const rows = await selectAll<{ user_id: string; coins: number }>("wallets", `select=user_id,coins&user_id=in.(${ids.join(",")})`);
  return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.coins)]));
}

function patchOf(before: TableState, after: TableState) {
  const p: Record<string, unknown> = {};
  if (after.seats !== before.seats) p.seats = after.seats;
  if (after.dealerSeat !== before.dealerSeat) p.dealerSeat = after.dealerSeat;
  if (after.handNo !== before.handNo) p.handNo = after.handNo;
  if (after.hand !== before.hand) p.hand = after.hand;
  if (after.nextHandAt !== before.nextHandAt) p.nextHandAt = after.nextHandAt === null ? null : new Date(after.nextHandAt).toISOString();
  return p;
}

export class TableError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Step<T> = (t: TableState, ctx: Ctx) => { table: TableState; ledger: TableLedgerEntry[]; result: T };

/**
 * Load → step → commit, retrying when another request got there first. The step must be pure (it is re-run on a
 * fresh load); ledger entries carry unique keys so a retry after a lost commit never pays twice.
 */
export async function withTable<T>(id: string, step: Step<T>, extraPlayers: string[] = []): Promise<{ table: TableState; balances: Record<string, number>; result: T; now: number }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const t = await loadTable(id);
    if (!t) throw new TableError("Table not found", 404);
    // Balances of everyone seated, plus a player about to sit down (so they can be dealt into this hand).
    const balances = await balancesFor(t, extraPlayers);
    const now = Date.now();
    const { version, ...state } = t;
    const r = step(state, { now, balances, rng });
    const patch = patchOf(state, r.table);
    if (!Object.keys(patch).length && !r.ledger.length) return { table: r.table, balances, result: r.result, now };
    try {
      await rpc("tp2_commit", {
        p_table: id, p_expected: version, p_patch: patch,
        p_ledger: r.ledger.filter((e) => !e.bot).map((e) => ({ handId: e.handId, handNo: e.handNo, key: e.key, playerId: e.playerId, kind: e.kind, amount: e.amount })),
      });
      // Wallets moved: report the balances the step saw adjusted by what it did.
      for (const e of r.ledger) if (!e.bot) balances[e.playerId] = (balances[e.playerId] ?? 0) + e.amount;
      return { table: r.table, balances, result: r.result, now };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/TP2_STALE/.test(msg)) continue;
      if (/TP2_INSUFFICIENT/.test(msg)) throw new TableError("Not enough coins", 400);
      if (/tp2_commit|tp2_tables/.test(msg)) throw new TableError("Teen Patti isn't set up yet: run migration 066", 500);
      throw e;
    }
  }
  throw new TableError("The table is busy — try again", 409);
}

/** Bring the table up to date (timers, bots, next hand) and return it. */
export const advance = (id: string) => withTable(id, (t, ctx) => ({ ...advanceTable(t, ctx), result: null }));

export async function createTable(boot: number, code: string | null) {
  const rules = await rulesFor(boot);
  const rows = (await insertRow("tp2_tables", { boot, rules, code, seats: [] })) as { id: string }[];
  return rows[0].id;
}

/** Seat a player at a table, bumping an idle bot if needed. */
export async function join(id: string, player: { playerId: string; name: string; emoji: string }) {
  return withTable(id, (t, ctx) => {
    const sat = sitDown(t, player, ctx.now);
    if (sat.error) throw new TableError(sat.error);
    let table = sat.table;
    if (!table.code) table = fillBots(table, ctx.rng, ctx.now);
    const adv = advanceTable(table, ctx);
    return { table: adv.table, ledger: adv.ledger, result: null };
  }, [player.playerId]);
}

/** Presence + timers; returns the viewer's filtered view. */
export async function poll(id: string, viewerId: string) {
  const r = await withTable(id, (t, ctx) => {
    const me = seatOf(t, viewerId);
    if (!me) throw new TableError("You are not at this table", 403);
    // Presence is written at most every 10 s so polling doesn't churn the row.
    const table = ctx.now - me.lastSeen > 10000 ? touch(t, viewerId, ctx.now) : t;
    const adv = advanceTable(table, ctx);
    return { table: adv.table, ledger: adv.ledger, result: null };
  });
  return respond(r.table, viewerId, r.balances, r.now);
}

export async function act(id: string, playerId: string, cmd: Omit<Command, "playerId">) {
  const r = await withTable(id, (t, ctx) => {
    if (!seatOf(t, playerId)) throw new TableError("You are not at this table", 403);
    const adv = advanceTable(t, ctx);
    const c = command(adv.table, { ...cmd, playerId }, ctx);
    const after = advanceTable(c.table, ctx); // a settlement may schedule the next hand
    return { table: after.table, ledger: [...adv.ledger, ...c.ledger, ...after.ledger], result: { ok: c.ok, error: c.error, message: c.message } };
  });
  return { ...r.result, state: respond(r.table, playerId, r.balances, r.now) };
}

/** Pack (if in a hand) and give the seat up. */
export async function leave(id: string, playerId: string) {
  await withTable(id, (t, ctx) => {
    if (!seatOf(t, playerId)) return { table: t, ledger: [], result: null };
    const adv = advanceTable(t, ctx);
    const c = command(adv.table, { actionId: `leave:${ctx.now}:${playerId}`, playerId, handId: adv.table.hand?.handId ?? "", expectedVersion: 0, type: "LEAVE" }, ctx);
    const table = standUp(c.table, playerId);
    const after = advanceTable(table, ctx);
    return { table: after.table, ledger: [...adv.ledger, ...c.ledger, ...after.ledger], result: null };
  });
}

export interface TableResponse {
  table: {
    id: string; code: string | null; boot: number; handNo: number; nextHandAt: number | null; waiting: boolean; serverNow: number;
    rules: Rules;
    seats: { seat: number; playerId: string; name: string; emoji: string; bot: boolean; bal: number | null; away: boolean }[];
  };
  view: HandView | null;
  balance: number;
}

function respond(t: TableState, viewerId: string, balances: Record<string, number>, now: number): TableResponse {
  const balance = balances[viewerId] ?? 0;
  return {
    table: {
      id: t.id, code: t.code, boot: t.boot, handNo: t.handNo, nextHandAt: t.nextHandAt, waiting: waitingForPlayers(t, balances, now), serverNow: now, rules: t.rules,
      seats: t.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, emoji: s.emoji, bot: s.bot, bal: s.bot ? s.bal ?? 0 : null, away: !s.bot && now - s.lastSeen > 20000 })),
    },
    view: t.hand ? viewFor(t.hand, viewerId, balance) : null,
    balance,
  };
}

/** Public tables with room, best first (most humans), for one boot. */
export async function findPublic(boot: number) {
  const rows = await selectAll<Row>("tp2_tables", `select=*&boot=eq.${boot}&code=is.null&order=updated_at.desc&limit=50`);
  const now = Date.now();
  const open = rows.map(fromRow).filter((t) => t.seats.filter((s) => !s.bot).length < 6);
  open.sort((a, b) => b.seats.filter((s) => !s.bot && now - s.lastSeen < 60000).length - a.seats.filter((s) => !s.bot && now - s.lastSeen < 60000).length);
  return open[0] ?? null;
}

export async function byCode(code: string) {
  const r = await selectOne<Row>("tp2_tables", `select=*&code=eq.${encodeURIComponent(code.toUpperCase())}`);
  return r ? fromRow(r) : null;
}

/** Humans seated right now at public tables, per boot. */
export async function lobbyCounts() {
  const since = new Date(Date.now() - 10 * 60000).toISOString();
  const rows = await selectAll<Row>("tp2_tables", `select=id,boot,seats,code,rules,dealer_seat,hand_no,next_hand_at,version&code=is.null&updated_at=gte.${since}`);
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const r of rows) {
    const n = (r.seats ?? []).filter((s) => !s.bot && now - s.lastSeen < 60000).length;
    if (n) out[String(r.boot)] = (out[String(r.boot)] ?? 0) + n;
  }
  return out;
}
