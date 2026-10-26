// Table-level orchestration for Classic Teen Patti, pure like the engine: who is seated, when the next hand
// starts, bots at public tables, and advancing the current hand. The server (app/lib/server/teenpatti.ts) loads a
// table row, calls these, and commits the result atomically.

import { applyCommand, processDue, startHand, type Command, type Ctx, type HandState, type LedgerEntry, type Rng, type Rules, type Seat } from "./engine.ts";
import { fullDeck, cardId, type Card, evaluate, compareKeys } from "./evaluator.ts";

export const TABLE_SEATS = 6;
/** Between hands. */
export const NEXT_HAND_MS = 8000;
/** A human who hasn't polled for this long is given up for gone at the next hand. */
export const AWAY_MS = 60000;
/** With fewer than two players able to pay the boot, try again this often. */
const WAIT_RETRY_MS = 4000;

/** Three distinct random cards from `pool` that satisfy `pred` (removed from the pool), or null after `tries` draws. */
function drawHand(pool: Card[], ri: (n: number) => number, pred: (h: Card[]) => boolean, tries = 400): Card[] | null {
  if (pool.length < 3) return null;
  for (let t = 0; t < tries; t++) {
    const a = ri(pool.length);
    let b = ri(pool.length - 1);
    if (b >= a) b++;
    let c = ri(pool.length - 2);
    if (c >= Math.min(a, b)) c++;
    if (c >= Math.max(a, b)) c++;
    const h = [pool[a], pool[b], pool[c]];
    if (!pred(h)) continue;
    for (const x of h) pool.splice(pool.indexOf(x), 1);
    return h;
  }
  return null;
}

const beats = (a: Card[], b: Card[]) => compareKeys(evaluate(a).key, evaluate(b).key) > 0;
const category = (h: Card[]) => evaluate(h).key[0]; // 1 high card … 6 trail

/**
 * A rigged deal, built from random cards so no two hands look alike: in a force_loss deal the human gets a hand worth
 * playing (usually a pair or better, sometimes just a high card) and the deepest-stacked bot a hand that beats it;
 * in a force_win deal the human gets a good hand and every bot a lesser one. The other bots get hands around the
 * human's — some above it (they stay in the hand a while), most below — so the table plays out differently each
 * time. Any other human at the table gets a hand that can't spoil the result.
 */
function buildEngagingTeenPattiDeck(
  seats: Seat[],
  prevDealerSeat: number | null,
  boot: number,
  balances: Record<string, number>,
  botBalances: Record<string, number>,
  outcomeModes?: Record<string, string>,
  rng?: Rng
): Card[] | undefined {
  if (!outcomeModes) return undefined;
  const ri = (n: number) => (n <= 1 ? 0 : rng ? rng.int(n) : Math.floor(Math.random() * n));
  const sortedSeats = [...seats].sort((a, b) => a.seat - b.seat);
  const can = (x: Seat) => (x.bot ? botBalances[x.playerId] ?? 0 : balances[x.playerId] ?? 0) >= boot;
  const playing = sortedSeats.filter(can);
  if (playing.length < 2) return undefined;

  const after = prevDealerSeat === null ? -1 : prevDealerSeat;
  const dealer = playing.find((x) => x.seat > after) ?? playing[0];
  const di = playing.indexOf(dealer);
  const orderSeats = [...playing.slice(di + 1), ...playing.slice(0, di + 1)];

  const lossIdx = orderSeats.findIndex((s) => !s.bot && outcomeModes[s.playerId] === "force_loss");
  const winIdx = orderSeats.findIndex((s) => !s.bot && outcomeModes[s.playerId] === "force_win");
  const botIndices = orderSeats.map((s, i) => (s.bot ? i : -1)).filter((i) => i >= 0);
  if (botIndices.length === 0 || (lossIdx < 0 && winIdx < 0)) return undefined;
  const humanIdx = lossIdx >= 0 ? lossIdx : winIdx;
  const loss = lossIdx >= 0;
  // The bot dealt the deciding hand is the one with the deepest stack, so it can keep up with a human who raises
  // hard (a short-stacked bot would run out of coins before the show).
  const richestBot = botIndices.reduce((best, i) => ((botBalances[orderSeats[i].playerId] ?? 0) > (botBalances[orderSeats[best].playerId] ?? 0) ? i : best), botIndices[0]);

  const pool = fullDeck();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const hands = new Map<number, Card[]>();

  // The human's hand: worth playing — a pair or better most of the time, otherwise a high card with a face card in it.
  const wantPair = ri(100) < (loss ? 60 : 75);
  let human = drawHand(pool, ri, (h) => (wantPair ? category(h) >= 2 && category(h) <= (loss ? 5 : 6) : category(h) === 1 && evaluate(h).key[1] >= 12));
  if (!human) human = drawHand(pool, ri, () => true)!;
  // The deciding bot: above the human in a force_loss deal, below it in a force_win deal. If nothing above the
  // human turns up (they hold near the top), the two swap: the bot takes that hand and the human a lesser one.
  let key = loss ? drawHand(pool, ri, (h) => beats(h, human!)) : drawHand(pool, ri, (h) => beats(human!, h) && category(h) >= (ri(100) < 60 ? 2 : 1));
  if (!key && loss) {
    key = human;
    human = drawHand(pool, ri, (h) => beats(key!, h) && category(h) >= 2) ?? drawHand(pool, ri, (h) => beats(key!, h))!;
  }
  if (!key) key = drawHand(pool, ri, (h) => beats(human!, h))!;
  hands.set(humanIdx, human);
  hands.set(richestBot, key);

  // The other bots: each gets a hand above the human (loss: 45%, win: never) or below it, so some stay a while and
  // others pack early — in no fixed order.
  for (const bi of botIndices) {
    if (bi === richestBot) continue;
    const above = loss && ri(100) < 45;
    const h = (above ? drawHand(pool, ri, (x) => beats(x, human!)) : null) ?? drawHand(pool, ri, (x) => beats(human!, x)) ?? drawHand(pool, ri, () => true)!;
    hands.set(bi, h);
  }
  // Any other human: below whichever side is meant to win.
  const top = loss ? key : human;
  for (let i = 0; i < orderSeats.length; i++) {
    if (hands.has(i)) continue;
    hands.set(i, drawHand(pool, ri, (x) => beats(top, x)) ?? drawHand(pool, ri, () => true)!);
  }

  const deck: Card[] = [];
  for (let i = 0; i < orderSeats.length; i++) deck.push(...hands.get(i)!);
  deck.push(...pool);
  return deck;
}

export interface TableSeat {
  seat: number;
  playerId: string;
  name: string;
  emoji: string;
  bot: boolean;
  /** Bots only: their table stack. */
  bal?: number;
  /** Bots only: set on bots seated with a botStack() stack. Bots from before it (topped up to identical crore-size
   *  stacks) lack it and are replaced at their table's next hand. */
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

/** Ledger entry plus what the database needs to key it. */
export type TableLedgerEntry = LedgerEntry & { handId: string; handNo: number };

export interface Advance { table: TableState; ledger: TableLedgerEntry[]; changed: boolean }

const live = (h: HandState | null): h is HandState => !!h && (h.phase === "PLAYING" || h.phase === "SIDESHOW_PENDING");
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
    // Make room by standing up a bot — one that isn't in the current hand if possible. A bot still in the hand
    // plays it out from the hand state and simply isn't dealt in again.
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
 * A bot's table stack: a little under the table's pot limit — 15% to 20% below it — rounded to a believable figure
 * and never the same as another bot's at the table. lo/hi also decide when a bot leaves: below lo/3 it is nearly
 * broke, above the pot limit it has won big and cashes out — either way a new bot with a fresh stack takes the
 * seat. (Without a pot limit, a few hundred boots.)
 */
export function botStackRange(boot: number, potCap?: number | null) {
  if (potCap) return { lo: Math.max(boot * 20, Math.round(potCap * 0.8)), hi: Math.max(boot * 20, Math.round(potCap * 0.85)) };
  return { lo: Math.max(boot * 500, 100_000), hi: Math.max(boot * 2500, 2_500_000) };
}

export function botStack(boot: number, rng: Rng, potCap?: number | null, avoid?: Set<number>) {
  const { lo, hi } = botStackRange(boot, potCap);
  // Rounded to a believable figure (nearest 50 at small boots, nearest 500 at big ones); re-rolled while it matches
  // another bot's stack at the table.
  const step = boot >= 500 ? 500 : 50;
  const roll = () => Math.min(hi, Math.max(lo, Math.round((lo + (hi - lo) * (rng.int(1_000_000) / 1_000_000)) / step) * step));
  let v = roll();
  for (let i = 0; avoid?.has(v) && i < 30; i++) v = roll();
  return v;
};

/**
 * Between hands, bots keep their stacks near the table's pot limit, the way regulars top up: one that has slipped
 * more than ~30% under the limit either adds coins (back to a fresh stack, same seat and name) or leaves; one that
 * has won past the limit cashes out. Either way the seats show stacks a little under the pot limit, never a few
 * boots. Returns the bots to keep, with any topped-up stacks.
 */
function settleBotStacks(t: TableState, rng: Rng): TableSeat[] {
  const { lo, hi } = botStackRange(t.boot, t.rules.potCap);
  const floor = Math.max(t.boot * 4, Math.round(lo * 0.875)); // 70% of the pot limit
  const cap = t.rules.potCap ?? hi;
  const stacks = new Set(t.seats.filter((s) => s.bot).map((s) => s.bal ?? 0));
  const keep: TableSeat[] = [];
  for (const s of t.seats) {
    if (!s.bot || s.stack !== 1) continue;
    const bal = s.bal ?? 0;
    if (bal > cap) continue; // won past the limit: cashes out
    if (bal >= floor) { keep.push(s); continue; }
    if (rng.int(100) < 60) {
      const fresh = botStack(t.boot, rng, t.rules.potCap, stacks);
      stacks.add(fresh);
      keep.push({ ...s, bal: fresh });
    }
  }
  return keep;
}

/** Small string hash (FNV-1a with a final mix), for per-bot traits that must not change between loads. */
function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** How long a bot stays at a table before it gets up: 2 to 5 minutes, its own figure. */
const botStayMs = (playerId: string) => 120_000 + (hashOf(playerId) % 180_000);

/**
 * Bots come and go like real players: between hands, bots that have sat past their stay leave — at most two per
 * hand, the longest-overdue first — and fillBots() seats newcomers with fresh names and stacks in their place. A
 * bot's lastSeen is the time it sat down (only humans' lastSeen moves with their polls).
 */
function rotateBots(bots: TableSeat[], now: number): TableSeat[] {
  const due = bots.filter((s) => now - s.lastSeen > botStayMs(s.playerId)).sort((a, b) => (now - a.lastSeen - botStayMs(a.playerId)) < (now - b.lastSeen - botStayMs(b.playerId)) ? 1 : -1);
  const leaving = new Set(due.slice(0, 2).map((s) => s.playerId));
  return bots.filter((s) => !leaving.has(s.playerId));
}

/** Public tables keep six seats busy with bots; private tables never get any. */
export function fillBots(t: TableState, rng: Rng, now: number): TableState {
  if (t.code) return t;
  const seats = [...t.seats];
  const taken = new Set(seats.map((s) => s.seat));
  const used = new Set(seats.map((s) => s.name));
  const stacks = new Set(seats.filter((s) => s.bot).map((s) => s.bal ?? 0));
  let seat = 0;
  while (seats.length < TABLE_SEATS) {
    while (taken.has(seat)) seat++;
    taken.add(seat);
    let name = BOT_NAMES[rng.int(BOT_NAMES.length)];
    for (let i = 0; used.has(name) && i < 20; i++) name = BOT_NAMES[rng.int(BOT_NAMES.length)];
    used.add(name);
    const bal = botStack(t.boot, rng, t.rules.potCap, stacks);
    stacks.add(bal);
    seats.push({ seat, playerId: `bot:${rng.uuid()}`, name, emoji: BOT_EMOJI[rng.int(BOT_EMOJI.length)], bot: true, bal, stack: 1, lastSeen: now });
  }
  return { ...t, seats: seats.sort((a, b) => a.seat - b.seat) };
}

/** Humans at the table right now (seated, not away). */
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
    // Bring the bots' stacks back to their seats and schedule the next hand.
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
  // Humans who went away leave; bots top up, stay or leave by their stack (settleBotStacks); public tables refill
  // with new bots on fresh stacks.
  const bots = rotateBots(settleBotStacks(t, ctx.rng), ctx.now);
  t = { ...t, seats: [...t.seats.filter((s) => !s.bot && ctx.now - s.lastSeen < AWAY_MS), ...bots].sort((a, b) => a.seat - b.seat) };
  t = fillBots(t, ctx.rng, ctx.now);
  const seats: Seat[] = t.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, bot: s.bot }));
  const botBalances = Object.fromEntries(t.seats.filter((s) => s.bot).map((s) => [s.playerId, s.bal ?? 0]));
  const handNo = t.handNo + 1;
  const deck = buildEngagingTeenPattiDeck(seats, t.dealerSeat, t.boot, ctx.balances, botBalances, ctx.outcomeModes, ctx.rng);
  const r = startHand({
    tableId: t.id, handId: `${t.id}:${handNo}`, handNo, rules: t.rules, seats, prevDealerSeat: t.dealerSeat,
    balances: ctx.balances, botBalances, now: ctx.now, rng: ctx.rng, deck,
  });
  if (!r) {
    // Fewer than two can pay the boot: wait, and check again shortly.
    return { table: { ...t, nextHandAt: ctx.now + WAIT_RETRY_MS }, ledger: [], changed: true };
  }
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
