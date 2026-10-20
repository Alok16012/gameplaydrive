// Table-level orchestration for online Poker, pure like the engine: who is seated, when the next hand starts,
// bots at public tables, and advancing the current hand. The server (app/lib/server/poker.ts) loads a table row,
// calls these, and commits the result atomically. Mirrors app/lib/teenpatti/table.ts.

import { applyCommand, processDue, startHand, type Command, type Ctx, type HandState, type LedgerEntry, type Rng, type Rules, type Seat } from "./engine.ts";

export const TABLE_SEATS = 6;
/** Between hands. */
export const NEXT_HAND_MS = 8000;
/** A human who hasn't polled for this long is given up for gone at the next hand. */
export const AWAY_MS = 60000;
/** With fewer than two players able to pay the boot, try again this often. */
const WAIT_RETRY_MS = 4000;

export interface TableSeat {
  seat: number;
  playerId: string;
  name: string;
  emoji: string;
  bot: boolean;
  /** Bots only: their table stack. */
  bal?: number;
  lastSeen: number;
}

export interface TableState {
  id: string;
  code: string | null;
  boot: number;
  rules: Rules;
  seats: TableSeat[];
  dealerSeat: number | null;
  handNo: number;
  hand: HandState | null;
  nextHandAt: number | null;
}

export type TableLedgerEntry = LedgerEntry & { handId: string; handNo: number };

export interface Advance { table: TableState; ledger: TableLedgerEntry[]; changed: boolean }

const live = (h: HandState | null): h is HandState => !!h && h.phase === "PLAYING";
const ended = (h: HandState | null) => !!h && (h.phase === "COMPLETED" || h.phase === "VOIDED");
const tag = (h: HandState, ledger: LedgerEntry[]): TableLedgerEntry[] => ledger.map((e) => ({ ...e, handId: h.handId, handNo: h.handNo }));

export function seatOf(t: TableState, playerId: string) {
  return t.seats.find((s) => s.playerId === playerId) ?? null;
}

/** Seat a player (or refresh their presence). Fails when every seat is taken by someone still in play. */
export function sitDown(t: TableState, p: { playerId: string; name: string; emoji: string }, now: number): { table: TableState; error?: string } {
  const cur = seatOf(t, p.playerId);
  if (cur) return { table: { ...t, seats: t.seats.map((s) => (s.playerId === p.playerId ? { ...s, lastSeen: now } : s)) } };
  let seats = [...t.seats];
  if (seats.length >= TABLE_SEATS) {
    const inHand = new Set(live(t.hand) ? Object.keys(t.hand.players) : []);
    const bump = seats.find((s) => s.bot && !inHand.has(s.playerId)) ?? seats.find((s) => s.bot);
    if (!bump) return { table: t, error: "This table is full" };
    seats = seats.filter((s) => s !== bump);
  }
  const taken = new Set(seats.map((s) => s.seat));
  let seat = 0;
  while (taken.has(seat)) seat++;
  seats.push({ seat, playerId: p.playerId, name: p.name, emoji: p.emoji, bot: false, lastSeen: now });
  return { table: { ...t, seats: seats.sort((a, b) => a.seat - b.seat) } };
}

export function standUp(t: TableState, playerId: string): TableState {
  return { ...t, seats: t.seats.filter((s) => s.playerId !== playerId) };
}

export function touch(t: TableState, playerId: string, now: number): TableState {
  return { ...t, seats: t.seats.map((s) => (s.playerId === playerId ? { ...s, lastSeen: now } : s)) };
}

const BOT_NAMES = ["Rahul", "Priya", "Aman", "Sneha", "Vikram", "Pooja", "Arjun", "Neha", "Rohit", "Kavya", "Sameer", "Divya", "Karan", "Anjali", "Imran", "Meera"];
const BOT_EMOJI = ["👨🏽", "👩🏻", "🧔🏾", "👨🏻‍🦱", "👩🏽‍🦱", "🧑🏼", "👱🏽‍♂️", "👩🏾", "🧑🏽‍🦰", "👨🏿", "👩🏼‍🦰", "🧕🏽"];

/** Public tables keep six seats busy with fair-playing bots; private tables never get any. */
export function fillBots(t: TableState, rng: Rng, now: number): TableState {
  if (t.code) return t;
  const seats = [...t.seats];
  const taken = new Set(seats.map((s) => s.seat));
  const used = new Set(seats.map((s) => s.name));
  let seat = 0;
  while (seats.length < TABLE_SEATS) {
    while (taken.has(seat)) seat++;
    taken.add(seat);
    let name = BOT_NAMES[rng.int(BOT_NAMES.length)];
    for (let i = 0; used.has(name) && i < 20; i++) name = BOT_NAMES[rng.int(BOT_NAMES.length)];
    used.add(name);
    seats.push({ seat, playerId: `bot:${rng.uuid()}`, name, emoji: BOT_EMOJI[rng.int(BOT_EMOJI.length)], bot: true, bal: t.boot * (60 + rng.int(200)), lastSeen: now });
  }
  return { ...t, seats: seats.sort((a, b) => a.seat - b.seat) };
}

export const humansPresent = (t: TableState, now: number) => t.seats.filter((s) => !s.bot && now - s.lastSeen < AWAY_MS).length;

/**
 * Move the table forward to `now`: due timers and bot moves in the current hand, then — once it has ended and the
 * break is over — the next hand. Balances are the humans' current wallet coins.
 */
export function advanceTable(t0: TableState, ctx: Ctx): Advance {
  let t = t0;
  const ledger: TableLedgerEntry[] = [];
  let changed = false;

  if (live(t.hand)) {
    const r = processDue(t.hand, ctx);
    if (r.changed) {
      t = { ...t, hand: r.state };
      ledger.push(...tag(r.state, r.ledger));
      changed = true;
    }
  }

  if (ended(t.hand) && t.nextHandAt === null) {
    const h = t.hand!;
    t = {
      ...t,
      seats: t.seats.map((s) => (s.bot && s.playerId in h.botBalances ? { ...s, bal: h.botBalances[s.playerId] } : s)),
      nextHandAt: (h.settlement?.at ?? ctx.now) + NEXT_HAND_MS,
    };
    changed = true;
  }

  if ((t.hand === null || ended(t.hand)) && (t.nextHandAt === null || ctx.now >= t.nextHandAt)) {
    const r = beginHand(t, ctx);
    if (r) {
      t = r.table;
      ledger.push(...r.ledger);
      changed = true;
    }
  }
  return { table: t, ledger, changed };
}

function beginHand(t0: TableState, ctx: Ctx): Advance | null {
  let t = t0;
  // Humans who went away leave; bots that can't cover a few boots leave; public tables refill.
  t = { ...t, seats: t.seats.filter((s) => (s.bot ? (s.bal ?? 0) >= t.boot * 4 : ctx.now - s.lastSeen < AWAY_MS)) };
  t = fillBots(t, ctx.rng, ctx.now);
  const seats: Seat[] = t.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, bot: s.bot }));
  const botBalances = Object.fromEntries(t.seats.filter((s) => s.bot).map((s) => [s.playerId, s.bal ?? 0]));
  const handNo = t.handNo + 1;
  const r = startHand({
    tableId: t.id, handId: `${t.id}:${handNo}`, handNo, rules: t.rules, seats, prevDealerSeat: t.dealerSeat,
    balances: ctx.balances, botBalances, now: ctx.now, rng: ctx.rng,
  });
  if (!r) return { table: { ...t, nextHandAt: ctx.now + WAIT_RETRY_MS }, ledger: [], changed: true };
  const h = r.state;
  t = { ...t, hand: h, handNo, dealerSeat: h.dealerSeat, nextHandAt: null };
  return { table: t, ledger: tag(h, r.ledger), changed: true };
}

/** Apply a player's command to the current hand (timers first, as the engine does). */
export function command(t: TableState, cmd: Command, ctx: Ctx): Advance & { ok: boolean; error?: string; message?: string } {
  if (!live(t.hand) || !t.hand.players[cmd.playerId]) {
    return { table: t, ledger: [], changed: false, ok: false, error: "NOT_IN_HAND", message: "You are not in this hand" };
  }
  const r = applyCommand(t.hand, cmd, ctx);
  const table = r.changed ? { ...t, hand: r.state } : t;
  return { table, ledger: tag(r.state, r.ledger), changed: r.changed, ok: r.ok, error: r.error, message: r.message };
}

/** Can fewer than two seated players pay the boot right now? (The screen says "waiting" instead of counting down.) */
export function waitingForPlayers(t: TableState, balances: Record<string, number>, now: number) {
  const can = t.seats.filter((s) => (s.bot ? (s.bal ?? 0) >= t.boot : (balances[s.playerId] ?? 0) >= t.boot && now - s.lastSeen < AWAY_MS));
  return can.length < 2;
}
