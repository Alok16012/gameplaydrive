// Server side of Classic Teen Patti: loads a table row, runs the pure engine / table logic, and commits the result
// atomically through tp2_commit (migration 066) with a compare-and-swap on the row version. Concurrent requests
// for one table are serialised by that: the loser gets TP2_STALE and simply reloads and retries. Import from route
// handlers only (service role).

import { randomInt, randomUUID } from "node:crypto";
import { insertRow, rpc, selectAll, selectOne } from "./supabaseAdmin";
import type { Command, Ctx, HandState, Rng, Rules } from "../teenpatti/engine";
import { advanceTable, command, fillBots, seatOf, setSittingOut, sitDown, standUp, touch, waitingForPlayers, type TableLedgerEntry, type TableSeat, type TableState } from "../teenpatti/table";
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
  // The row and the (usually cached) config are fetched side by side.
  const [r, cfg] = await Promise.all([selectOne<Row>("tp2_tables", `select=*&id=eq.${id}`), gameCfg()]);
  if (!r) return null;
  const t = fromRow(r);
  const live = rulesFromCfg(t.boot, cfg);
  // The pot limit is overlaid too, so a change here reaches tables created earlier.
  return { ...t, rules: { ...t.rules, turnTimeoutMs: live.turnTimeoutMs, blindLimit: live.blindLimit, rakePct: live.rakePct, potCap: live.potCap } };
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
  return rulesFromCfg(boot, await gameCfg());
}

/** Pot limit per boot (the owner's table, 2026-10-24; 10 and 25 added 2026-10-27 at the same 300× as 50 / 100): a hand goes to a forced showdown once the pot reaches it.
 *  Other boots (private tables) get 165× the boot, the ratio of the biggest public table. */
export const POT_CAPS: Record<number, number> = { 10: 3_000, 25: 7_500, 50: 15_000, 100: 30_000, 500: 125_000, 1000: 165_000 };
export const potCapFor = (boot: number) => POT_CAPS[boot] ?? Math.max(boot * 7, boot * 165);

function rulesFromCfg(boot: number, cfg: Record<string, unknown>): Rules {
  const turn = Number(cfg?.turn) || 15;
  const blindLimit = Math.max(1, Number(cfg?.blind_limit) || 3);
  const rakePct = cfg?.rake === undefined || cfg?.rake === null ? 5 : Math.min(25, Math.max(0, Number(cfg.rake) || 0));
  return { boot, maxBaseStake: boot * 128, potCap: potCapFor(boot), turnTimeoutMs: turn * 1000, sideshowTimeoutMs: 10000, maxTurnActions: null, minBlind: 1, blindLimit, rakePct };
}

async function balancesOf(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const rows = await selectAll<{ user_id: string; coins: number }>("wallets", `select=user_id,coins&user_id=in.(${ids.join(",")})`);
  return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.coins)]));
}

const outcomeCache = new Map<string, { mode: string; exp: number }>();

async function outcomeModesOf(humanIds: string[]): Promise<Record<string, string>> {
  if (!humanIds.length) return {};
  const res: Record<string, string> = {};
  const now = Date.now();
  await Promise.all(
    humanIds.map(async (uid) => {
      const cached = outcomeCache.get(uid);
      if (cached && cached.exp > now) {
        res[uid] = cached.mode;
        return;
      }
      try {
        const m = await rpc<string>("get_outcome_mode", { p_user_id: uid, p_game: "teen-patti" });
        const mode = m || "fair";
        res[uid] = mode;
        outcomeCache.set(uid, { mode, exp: now + 5000 });
      } catch {
        res[uid] = "fair";
      }
    })
  );
  return res;
}

/**
 * Everything a step needs, in one round trip: the table row, plus the wallets and outcome modes of the players we
 * expect to find at it (the caller), fetched side by side. Anyone else seated is looked up afterwards (an extra
 * round trip only at tables with more than one human).
 */
async function loadAll(id: string, expected: string[]) {
  const [t, bal, modes] = await Promise.all([loadTable(id), balancesOf(expected), outcomeModesOf(expected)]);
  if (!t) return null;
  const humans = t.seats.filter((s) => !s.bot).map((s) => s.playerId);
  const missing = humans.filter((h) => !expected.includes(h));
  if (missing.length) {
    const [b2, m2] = await Promise.all([balancesOf(missing), outcomeModesOf(missing)]);
    Object.assign(bal, b2);
    Object.assign(modes, m2);
  }
  // Outcome modes only for the people seated (a player about to sit down has none yet).
  for (const k of Object.keys(modes)) if (!humans.includes(k)) delete modes[k];
  return { t, balances: bal, outcomeModes: modes };
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

/** Milliseconds spent loading and committing, for the Server-Timing header. */
export type Timing = { load?: number; commit?: number; tries?: number };

/**
 * Load → step → commit, retrying when another request got there first. The step must be pure (it is re-run on a
 * fresh load); ledger entries carry unique keys so a retry after a lost commit never pays twice. `players`: humans
 * expected at the table (the caller), loaded together with the row. `allowed`: the caller's profile check — awaited
 * before anything is committed or returned.
 */
export async function withTable<T>(id: string, step: Step<T>, players: string[] = [], allowed?: Promise<unknown>, timing: Timing = {}): Promise<{ table: TableState; balances: Record<string, number>; result: T; now: number }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    timing.tries = attempt + 1;
    const t0 = Date.now();
    const loaded = await loadAll(id, players);
    timing.load = (timing.load ?? 0) + Date.now() - t0;
    if (allowed) await allowed;
    if (!loaded) throw new TableError("Table not found", 404);
    const { t, balances, outcomeModes } = loaded;
    const now = Date.now();
    const { version, ...state } = t;
    const r = step(state, { now, balances, outcomeModes, rng });
    const patch = patchOf(state, r.table);
    if (!Object.keys(patch).length && !r.ledger.length) return { table: r.table, balances, result: r.result, now };
    const t1 = Date.now();
    try {
      await rpc("tp2_commit", {
        p_table: id, p_expected: version, p_patch: patch,
        p_ledger: r.ledger.filter((e) => !e.bot).map((e) => ({ handId: e.handId, handNo: e.handNo, key: e.key, playerId: e.playerId, kind: e.kind, amount: e.amount })),
      });
      timing.commit = (timing.commit ?? 0) + Date.now() - t1;
      // Wallets moved: report the balances the step saw adjusted by what it did.
      for (const e of r.ledger) if (!e.bot) balances[e.playerId] = (balances[e.playerId] ?? 0) + e.amount;
      return { table: r.table, balances, result: r.result, now };
    } catch (e) {
      timing.commit = (timing.commit ?? 0) + Date.now() - t1;
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
export async function poll(id: string, viewerId: string, allowed?: Promise<unknown>, timing?: Timing) {
  const r = await withTable(id, (t, ctx) => {
    const me = seatOf(t, viewerId);
    if (!me) throw new TableError("You are not at this table", 403);
    // Presence is written at most every 10 s so polling doesn't churn the row.
    const table = ctx.now - me.lastSeen > 10000 ? touch(t, viewerId, ctx.now) : t;
    const adv = advanceTable(table, ctx);
    return { table: adv.table, ledger: adv.ledger, result: null };
  }, [viewerId], allowed, timing);
  return respond(r.table, viewerId, r.balances, r.now);
}

export async function act(id: string, playerId: string, cmd: Omit<Command, "playerId">, allowed?: Promise<unknown>, timing?: Timing) {
  const r = await withTable(id, (t, ctx) => {
    if (!seatOf(t, playerId)) throw new TableError("You are not at this table", 403);
    const adv = advanceTable(t, ctx);
    const c = command(adv.table, { ...cmd, playerId }, ctx);
    const after = advanceTable(c.table, ctx); // a settlement may schedule the next hand
    return { table: after.table, ledger: [...adv.ledger, ...c.ledger, ...after.ledger], result: { ok: c.ok, error: c.error, message: c.message } };
  }, [playerId], allowed, timing);
  return { ...r.result, state: respond(r.table, playerId, r.balances, r.now) };
}

/** Pack (if in a hand) and give the seat up. */
export async function leave(id: string, playerId: string, allowed?: Promise<unknown>) {
  await withTable(id, (t, ctx) => {
    if (!seatOf(t, playerId)) return { table: t, ledger: [], result: null };
    const adv = advanceTable(t, ctx);
    const c = command(adv.table, { actionId: `leave:${ctx.now}:${playerId}`, playerId, handId: adv.table.hand?.handId ?? "", expectedVersion: 0, type: "LEAVE" }, ctx);
    const table = standUp(c.table, playerId);
    const after = advanceTable(table, ctx);
    return { table: after.table, ledger: [...adv.ledger, ...c.ledger, ...after.ledger], result: null };
  }, [playerId], allowed);
}

/** Sit out from the next hand (the current one plays on) or come back in; returns your view of the table. */
export async function sitOut(id: string, playerId: string, on: boolean, allowed?: Promise<unknown>) {
  await withTable(id, (t) => {
    if (!seatOf(t, playerId)) throw new TableError("You are not at this table");
    return { table: setSittingOut(t, playerId, on), ledger: [], result: null };
  }, [playerId], allowed);
  return poll(id, playerId);
}

export interface TableResponse {
  table: {
    id: string; code: string | null; boot: number; handNo: number; nextHandAt: number | null; waiting: boolean; serverNow: number;
    rules: Rules;
    seats: { seat: number; playerId: string; name: string; emoji: string; bot: boolean; bal: number | null; away: boolean; sittingOut?: boolean }[];
  };
  view: HandView | null;
  balance: number;
  /** The viewer's player id (they may be seated but not in the hand, e.g. sitting out). */
  you: string;
}

function respond(t: TableState, viewerId: string, balances: Record<string, number>, now: number): TableResponse {
  const balance = balances[viewerId] ?? 0;
  // A bot's stack as it stands right now: the hand's running figure (down with every boot and chaal, up when it
  // wins) while it is in the hand; the seat's figure otherwise.
  const hb = t.hand?.botBalances ?? {};
  const botBal = (s: TableSeat) => Math.max(0, Math.round(s.playerId in hb ? hb[s.playerId] : s.bal ?? 0));
  return {
    table: {
      id: t.id, code: t.code, boot: t.boot, handNo: t.handNo, nextHandAt: t.nextHandAt, waiting: waitingForPlayers(t, balances, now), serverNow: now, rules: t.rules,
      seats: t.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, emoji: s.emoji, bot: s.bot, bal: s.bot ? botBal(s) : null, away: !s.bot && now - s.lastSeen > 20000, ...(s.sittingOut ? { sittingOut: true } : {}) })),
    },
    view: t.hand ? viewFor(t.hand, viewerId, balance) : null,
    balance,
    you: viewerId,
  };
}

/** Public tables with room, best first (most humans), for one boot. */
export async function findPublic(boot: number, avoid?: string) {
  const rows = await selectAll<Row>("tp2_tables", `select=*&boot=eq.${boot}&code=is.null&order=updated_at.desc&limit=50`);
  const now = Date.now();
  // Switch table passes the table being left, so the player lands somewhere else.
  const open = rows.map(fromRow).filter((t) => t.id !== avoid && t.seats.filter((s) => !s.bot).length < 6);
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
