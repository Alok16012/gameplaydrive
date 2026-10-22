// Table-level orchestration for online Poker, pure like the engine: who is seated, when the next hand starts,
// bots at public tables, and advancing the current hand. The server (app/lib/server/poker.ts) loads a table row,
// calls these, and commits the result atomically. Mirrors app/lib/teenpatti/table.ts.

import { applyCommand, processDue, startHand, type Command, type Ctx, type HandState, type LedgerEntry, type Rng, type Rules, type Seat } from "./engine.ts";
import { cardId, compareKeys, evaluate, fullDeck, type Card } from "./evaluator.ts";

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
  /** Bots only: set on bots seated with a botStack() stack; older bots lack it and are replaced at the next hand. */
  stack?: 1;
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

/**
 * A bot's table stack: like a real player's, between a few lakh and a couple of dozen lakh (scaled up at big
 * boots), most of them at the low end. lo/hi also decide when a bot leaves: below lo/5 it is nearly broke, above
 * 2·hi it has won big and cashes out — either way a new bot with a fresh stack takes the seat.
 */
export function botStackRange(boot: number) {
  return { lo: Math.max(boot * 500, 100_000), hi: Math.max(boot * 2500, 2_500_000) };
}

export function botStack(boot: number, rng: Rng) {
  const { lo, hi } = botStackRange(boot);
  const u = rng.int(1_000_000) / 1_000_000;
  return Math.round(lo + (hi - lo) * u * u);
}

const botStays = (boot: number, bal: number) => {
  const { lo, hi } = botStackRange(boot);
  return bal >= Math.max(boot * 4, lo / 5) && bal <= hi * 2;
};

/** Public tables keep six seats busy with bots; private tables never get any. */
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
    seats.push({ seat, playerId: `bot:${rng.uuid()}`, name, emoji: BOT_EMOJI[rng.int(BOT_EMOJI.length)], bot: true, bal: botStack(t.boot, rng), stack: 1, lastSeen: now });
  }
  return { ...t, seats: seats.sort((a, b) => a.seat - b.seat) };
}

/**
 * Outcome control at the deal. force_loss: the richest bot gets the hand that wins the showdown and the human a
 * hand that looks good but loses (a lower pair, a weaker kicker, a flush draw that misses…) — picked from random
 * deals so it is never the same two hands. force_win: the human gets the winning hand, every bot a weaker one.
 * The deck is still a real shuffle; only the order the cards come out in is chosen. Returns undefined for a fair deal.
 */
export function buildOutcomeDeck(seats: Seat[], prevDealerSeat: number | null, boot: number, balances: Record<string, number>, botBalances: Record<string, number>, outcomeModes: Record<string, string> | undefined, rng: Rng): Card[] | undefined {
  if (!outcomeModes) return undefined;
  const sorted = [...seats].sort((a, b) => a.seat - b.seat);
  const can = (x: Seat) => (x.bot ? botBalances[x.playerId] ?? 0 : balances[x.playerId] ?? 0) >= boot;
  const playing = sorted.filter(can);
  if (playing.length < 2) return undefined;
  const after = prevDealerSeat === null ? -1 : prevDealerSeat;
  const dealer = playing.find((x) => x.seat > after) ?? playing[0];
  const di = playing.indexOf(dealer);
  const order = [...playing.slice(di + 1), ...playing.slice(0, di + 1)];
  const lossIdx = order.findIndex((x) => !x.bot && outcomeModes[x.playerId] === "force_loss");
  const winIdx = order.findIndex((x) => !x.bot && outcomeModes[x.playerId] === "force_win");
  const bots = order.map((x, i) => (x.bot ? i : -1)).filter((i) => i >= 0);
  if (!bots.length || (lossIdx < 0 && winIdx < 0)) return undefined;
  const humanIdx = lossIdx >= 0 ? lossIdx : winIdx;
  const closerIdx = bots.reduce((best, i) => ((botBalances[order[i].playerId] ?? 0) > (botBalances[order[best].playerId] ?? 0) ? i : best), bots[0]);
  const n = order.length;

  // Shuffle, deal, and keep the first shuffle in which the right player holds the best hand and the rest of the
  // table stays below them. Try a few dozen; a plain shuffle gets this often enough.
  for (let attempt = 0; attempt < 60; attempt++) {
    const deck = (() => { const a = fullDeck(); for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; })();
    const board = deck.slice(n * 2, n * 2 + 5);
    const keys = order.map((_, i) => evaluate([...deck.slice(i * 2, i * 2 + 2), ...board]).key);
    const best = keys.reduce((b, k) => (compareKeys(k, b) > 0 ? k : b), keys[0]);
    const holders = keys.map((k, i) => (compareKeys(k, best) === 0 ? i : -1)).filter((i) => i >= 0);
    if (lossIdx >= 0) {
      // The closer alone holds the best hand; the human's hand is at least a pair (so they have a reason to play).
      if (holders.length !== 1 || holders[0] !== closerIdx) continue;
      if (keys[humanIdx][0] < 1) continue;
    } else {
      if (holders.length !== 1 || holders[0] !== humanIdx) continue;
    }
    return deck;
  }
  // No luck with a shuffle: build it. Bring the strongest two hole cards (by final hand) to the winner's slot.
  const deck = (() => { const a = fullDeck(); for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; })();
  const board = deck.slice(n * 2, n * 2 + 5);
  const slots = order.map((_, i) => deck.slice(i * 2, i * 2 + 2));
  let bestI = 0;
  for (let i = 1; i < n; i++) if (compareKeys(evaluate([...slots[i], ...board]).key, evaluate([...slots[bestI], ...board]).key) > 0) bestI = i;
  const want = lossIdx >= 0 ? closerIdx : humanIdx;
  [slots[want], slots[bestI]] = [slots[bestI], slots[want]];
  const used = new Set([...slots.flat(), ...board].map(cardId));
  return [...slots.flat(), ...board, ...deck.filter((c) => !used.has(cardId(c)))];
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
  // Humans who went away leave; bots that are nearly broke, have won big, or predate the stack change leave; public
  // tables refill with new bots on fresh stacks.
  t = { ...t, seats: t.seats.filter((s) => (s.bot ? s.stack === 1 && botStays(t.boot, s.bal ?? 0) : ctx.now - s.lastSeen < AWAY_MS)) };
  t = fillBots(t, ctx.rng, ctx.now);
  const seats: Seat[] = t.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, bot: s.bot }));
  const botBalances = Object.fromEntries(t.seats.filter((s) => s.bot).map((s) => [s.playerId, s.bal ?? 0]));
  const handNo = t.handNo + 1;
  const deck = buildOutcomeDeck(seats, t.dealerSeat, t.boot, ctx.balances, botBalances, ctx.outcomeModes, ctx.rng);
  const r = startHand({
    tableId: t.id, handId: `${t.id}:${handNo}`, handNo, rules: t.rules, seats, prevDealerSeat: t.dealerSeat,
    balances: ctx.balances, botBalances, now: ctx.now, rng: ctx.rng, deck,
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
