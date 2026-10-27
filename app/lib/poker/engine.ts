// Texas Hold'em hand engine — a pure state machine, no I/O, in the same shape as the Classic Teen Patti engine
// (app/lib/teenpatti/engine.ts). Every function takes the current hand and returns a new one plus the ledger
// entries the caller must apply atomically (app/lib/server/poker.ts, migration 070).
// The deal is whatever the caller passes (table.ts may rig it for outcome control); the bots are house bots that
// know every card — see botMove() for how they play.
//
// House rules (the same as the practice table had):
//   • every player at the table puts in the boot (ante); two cards each, five on the board;
//   • four betting rounds (pre-flop, flop, turn, river), each opened by the seat after the dealer:
//     check / call / raise / fold; a raise is to at least double the current bet (or 2 × boot), at most
//     100 × boot and never more than you hold; at most `maxRaises` raises per round;
//   • nobody bets coins they don't have: a player who can't cover a call has to fold (no side pots);
//   • timeout: fold if there is something to call, otherwise check;
//   • showdown: best five of seven, ties split; the platform fee comes off the pot first.

import { compareKeys, evaluate, fullDeck, validateDeal, type Card } from "./evaluator.ts";

export interface Rules {
  /** Ante from everyone at the start of a hand. */
  boot: number;
  /** The highest a bet can be raised to in one betting round. */
  maxBet: number;
  turnTimeoutMs: number;
  /** Platform fee on the pot, in percent (0–25). */
  rakePct: number;
  /** Raises allowed per betting round. */
  maxRaises: number;
}

export const MAX_SEATS = 6;
export const STAGE_NAMES = ["Pre-Flop", "Flop", "Turn", "River", "Showdown"] as const;
/** Board cards on show at a stage: 0 pre-flop, 3 flop, 4 turn, 5 river / showdown. */
export const boardVisible = (stage: number) => (stage <= 0 ? 0 : stage === 1 ? 3 : stage === 2 ? 4 : 5);
/** Bots raise at most this often in one betting round (so a round of bots always ends). */
const BOT_RAISES = 2;

export function validateRules(r: Rules): string | null {
  const posInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!posInt(r.boot)) return "Boot must be a positive whole number";
  if (!posInt(r.maxBet) || r.maxBet < r.boot * 2) return "Max bet must be at least twice the boot";
  if (!posInt(r.turnTimeoutMs)) return "Turn time must be positive";
  if (typeof r.rakePct !== "number" || r.rakePct < 0 || r.rakePct > 25) return "Platform fee must be 0–25%";
  if (!posInt(r.maxRaises)) return "Max raises must be positive";
  return null;
}

export interface Seat { seat: number; playerId: string; name: string; bot: boolean }

export type Phase = "DEALING" | "PLAYING" | "COMPLETED" | "VOIDED";

export interface HandPlayer extends Seat {
  /** Folded players stay participants (their money is in the pot). */
  status: "ACTIVE" | "FOLDED";
  contributed: number;
  /** Put in during the current betting round. */
  bet: number;
  /** Has acted since the last raise this round. */
  acted: boolean;
  /** Every coin in: skipped for the rest of the hand, in for a share of the pot up to what they matched. */
  allIn: boolean;
  foldReason: "FOLD" | "TIMEOUT" | "LEFT" | null;
}

export type LedgerKind = "BOOT" | "BET" | "PAYOUT" | "REFUND";
export interface LedgerEntry {
  /** Unique within the hand — the database refuses a second entry with the same key (exactly-once). */
  key: string;
  playerId: string;
  bot: boolean;
  kind: LedgerKind;
  /** Negative: paid into the pot. Positive: paid out of it. */
  amount: number;
}

export interface Settlement {
  reason: "LAST_STANDING" | "SHOWDOWN" | "VOID";
  winners: { playerId: string; amount: number }[];
  /** Uncalled chips given back (an all-in nobody could fully match), per player. */
  returned?: { playerId: string; amount: number }[];
  /** Players whose cards are public. */
  reveal: string[];
  /** Platform fee kept from the pot. */
  rake: number;
  at: number;
}

export interface HandEvent {
  seq: number;
  at: number;
  type: "BOOT" | "DEAL" | "CHECK" | "CALL" | "RAISE" | "FOLD" | "TIMEOUT" | "LEFT" | "SHOWDOWN" | "SETTLED" | "VOIDED";
  playerId?: string;
  amount?: number;
  /** Public detail only — never cards. */
  note?: string;
}

export interface ProcessedAction { hash: string; ok: boolean; error?: string }

export interface HandState {
  handId: string;
  tableId: string;
  handNo: number;
  version: number;
  phase: Phase;
  /** 0 pre-flop, 1 flop, 2 turn, 3 river, 4 showdown. */
  stage: number;
  rules: Rules;
  dealerSeat: number;
  /** Participating player ids clockwise from the seat after the dealer (the dealer acts last). */
  order: string[];
  players: Record<string, HandPlayer>;
  /** Private. Never leaves the server except through viewFor(). */
  cards: Record<string, Card[]>;
  /** All five board cards, dealt up front; viewFor() shows only the ones turned over. */
  board: Card[];
  turnId: string | null;
  turnDeadline: number | null;
  /** When a bot on turn acts. */
  botActAt: number | null;
  /** The bet everyone must match this round. */
  betLevel: number;
  raises: number;
  botRaises: number;
  pot: number;
  ledger: LedgerEntry[];
  events: HandEvent[];
  processed: Record<string, ProcessedAction>;
  settlement: Settlement | null;
  /** Bots' table stacks (humans' coins live in their wallets). */
  botBalances: Record<string, number>;
  createdAt: number;
}

export interface Rng {
  /** Uniform integer in [0, n). */
  int(n: number): number;
  uuid(): string;
}

export type ActionType = "FOLD" | "CHECK" | "CALL" | "RAISE" | "LEAVE";

export interface Command {
  actionId: string;
  playerId: string;
  handId: string;
  expectedVersion: number;
  type: ActionType;
  /** RAISE: the bet level to raise to. */
  to?: number;
}

export interface Ctx {
  now: number;
  /** Human wallet balances at the time of the command (the database re-checks every debit). */
  balances: Record<string, number>;
  rng: Rng;
  /** Outcome control per human (force_loss / force_win / fair); used when a hand is dealt. */
  outcomeModes?: Record<string, string>;
}

export type ErrorCode =
  | "ACTION_ID_REUSED" | "STALE_HAND" | "STALE_VERSION" | "HAND_OVER" | "NOT_IN_HAND" | "NOT_YOUR_TURN"
  | "INSUFFICIENT_CHIPS" | "CANNOT_CHECK" | "RAISE_RANGE" | "RAISE_LIMIT" | "UNKNOWN_ACTION";

export interface Result {
  state: HandState;
  ledger: LedgerEntry[];
  ok: boolean;
  error?: ErrorCode;
  message?: string;
  /** True when the state changed (version was bumped). */
  changed: boolean;
}

// ------------------------------------------------------------------------------------------------- helpers

const clone = <T,>(x: T): T => structuredClone(x);
const assertInt = (n: number) => {
  if (!Number.isSafeInteger(n)) throw new Error("Chip amount out of range");
  return n;
};

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const active = (s: HandState) => s.order.filter((id) => s.players[id].status === "ACTIVE");

function event(s: HandState, now: number, e: Omit<HandEvent, "seq" | "at">) {
  s.events.push({ seq: s.events.length + 1, at: now, ...e });
}

export function balanceOf(s: HandState, ctx: Ctx, id: string) {
  return s.players[id].bot ? s.botBalances[id] ?? 0 : ctx.balances[id] ?? 0;
}

function pay(s: HandState, out: LedgerEntry[], id: string, kind: LedgerKind, amount: number, balanceBefore?: number) {
  assertInt(amount);
  const p = s.players[id];
  if (amount > 0) {
    const e: LedgerEntry = { key: `${kind}:${s.ledger.length + 1}:${id}`, playerId: id, bot: p.bot, kind, amount: -amount };
    s.ledger.push(e);
    out.push(e);
    p.contributed = assertInt(p.contributed + amount);
    s.pot = assertInt(s.pot + amount);
    if (p.bot) s.botBalances[id] = (s.botBalances[id] ?? 0) - amount;
  }
  // Nothing left behind: all in — no more decisions this hand, in for a share of the pot up to what was matched.
  if (balanceBefore !== undefined && balanceBefore - amount <= 0) p.allIn = true;
}

function credit(s: HandState, out: LedgerEntry[], id: string, kind: "PAYOUT" | "REFUND", amount: number) {
  if (amount <= 0) return;
  const p = s.players[id];
  const e: LedgerEntry = { key: `${kind}:${id}`, playerId: id, bot: p.bot, kind, amount: assertInt(amount) };
  s.ledger.push(e);
  out.push(e);
  if (p.bot) s.botBalances[id] = (s.botBalances[id] ?? 0) + amount;
}

function setTurn(s: HandState, id: string | null, now: number, rng: Rng) {
  s.turnId = id;
  s.turnDeadline = id ? now + s.rules.turnTimeoutMs : null;
  s.botActAt = id && s.players[id].bot ? now + botThinkMs(s, id, rng) : null;
}

/** How long a bot "thinks" before it acts, like a person at the table: a check takes a few seconds, calling a bet longer,
 *  a bet that is big for its stack longest, and now and then it goes into a long think. Always inside the turn clock. */
function botThinkMs(s: HandState, id: string, rng: Rng) {
  const owe = toCall(s, id);
  const stack = s.botBalances[id] ?? 0;
  let ms: number;
  if (owe === 0) ms = 3500 + rng.int(2500); // check: 3.5–6 s (the owner asked for 1.5 s more than a quick 2–4.5 s)
  else if (stack > 0 && owe >= stack * 0.3) ms = 5000 + rng.int(4000); // big call or all in: 5–9 s
  else if (s.board.length === 0 && owe <= s.rules.boot) ms = 2000 + rng.int(2500); // pre-flop, just the boot to call
  else ms = 3000 + rng.int(3500); // facing a bet: 3–6.5 s
  if (rng.int(100) < 12) ms += 2500 + rng.int(3000); // the odd long think
  return Math.max(800, Math.min(ms, s.rules.turnTimeoutMs - 1500));
}

/** What `id` must put in to stay in the round. */
export const toCall = (s: HandState, id: string) => Math.max(0, s.betLevel - s.players[id].bet);

/** The range a player may raise to right now (min may exceed max when they can't afford a raise). */
export function raiseRange(s: HandState, id: string, balance: number) {
  const min = Math.max(s.betLevel * 2, s.rules.boot * 2);
  const max = Math.min(s.rules.maxBet, s.players[id].bet + balance);
  return { min, max };
}

/** Next active player clockwise after `fromId` who still has to act this round. */
function nextToAct(s: HandState, fromId: string): string | null {
  const i = s.order.indexOf(fromId);
  for (let k = 1; k <= s.order.length; k++) {
    const id = s.order[(i + k) % s.order.length];
    const p = s.players[id];
    if (p.status === "ACTIVE" && !p.allIn && !p.acted) return id;
  }
  return null;
}

/** Players still in who can still make a decision (not all in). */
const canAct = (s: HandState) => active(s).filter((id) => !s.players[id].allIn);

function beginRound(s: HandState, now: number, rng: Rng) {
  for (const id of s.order) { s.players[id].bet = 0; s.players[id].acted = false; }
  s.betLevel = 0;
  s.raises = 0;
  s.botRaises = 0;
  const first = s.order.find((id) => s.players[id].status === "ACTIVE" && !s.players[id].allIn) ?? null;
  setTurn(s, first, now, rng);
}

// ------------------------------------------------------------------------------------------------- start

export interface StartInput {
  tableId: string;
  handId: string;
  handNo: number;
  rules: Rules;
  seats: Seat[];
  prevDealerSeat: number | null;
  balances: Record<string, number>;
  botBalances: Record<string, number>;
  now: number;
  rng: Rng;
  /** Tests only: a fixed deck order instead of a shuffle (hole cards two per player in turn order, then the board). */
  deck?: Card[];
}

/** Collects the boot from everyone who can afford it and deals. null when fewer than two can play. */
export function startHand(inp: StartInput): Result | null {
  const err = validateRules(inp.rules);
  if (err) throw new Error(err);
  const seats = [...inp.seats].sort((a, b) => a.seat - b.seat);
  const can = (x: Seat) => (x.bot ? inp.botBalances[x.playerId] ?? 0 : inp.balances[x.playerId] ?? 0) >= inp.rules.boot;
  const playing = seats.filter(can);
  if (playing.length < 2) return null;

  // Dealer: the next occupied participating seat clockwise after the previous dealer.
  const after = inp.prevDealerSeat === null ? -1 : inp.prevDealerSeat;
  const dealer = playing.find((x) => x.seat > after) ?? playing[0];
  const di = playing.indexOf(dealer);
  const orderSeats = [...playing.slice(di + 1), ...playing.slice(0, di + 1)];

  const s: HandState = {
    handId: inp.handId, tableId: inp.tableId, handNo: inp.handNo, version: 1, phase: "DEALING", stage: 0, rules: clone(inp.rules),
    dealerSeat: dealer.seat, order: orderSeats.map((x) => x.playerId), players: {}, cards: {}, board: [],
    turnId: null, turnDeadline: null, botActAt: null, betLevel: 0, raises: 0, botRaises: 0, pot: 0,
    ledger: [], events: [], processed: {}, settlement: null, botBalances: { ...inp.botBalances }, createdAt: inp.now,
  };
  for (const x of orderSeats) s.players[x.playerId] = { ...x, status: "ACTIVE", contributed: 0, bet: 0, acted: false, allIn: false, foldReason: null };

  const deck = inp.deck ?? shuffle(fullDeck(), inp.rng);
  orderSeats.forEach((x, i) => { s.cards[x.playerId] = deck.slice(i * 2, i * 2 + 2); });
  s.board = deck.slice(orderSeats.length * 2, orderSeats.length * 2 + 5);
  try {
    validateDeal(Object.values(s.cards), s.board);
  } catch {
    // An invalid or duplicated deck never reaches the table: the hand is void before anyone pays.
    s.phase = "VOIDED";
    s.settlement = { reason: "VOID", winners: [], reveal: [], rake: 0, at: inp.now };
    event(s, inp.now, { type: "VOIDED", note: "Invalid deck" });
    return { state: s, ledger: [], ok: false, message: "Invalid deck", changed: true };
  }
  const out: LedgerEntry[] = [];
  for (const id of s.order) {
    const bal = s.players[id].bot ? inp.botBalances[id] ?? 0 : inp.balances[id] ?? 0;
    pay(s, out, id, "BOOT", inp.rules.boot, bal);
    event(s, inp.now, { type: "BOOT", playerId: id, amount: inp.rules.boot });
  }
  s.phase = "PLAYING";
  beginRound(s, inp.now, inp.rng);
  // Everyone (but one at most) all in from the ante: nothing to bet, straight to the cards.
  if (canAct(s).length <= 1) runOut(s, out, inp.now);
  return { state: s, ledger: out, ok: true, changed: true };
}

// ------------------------------------------------------------------------------------------------- settlement

/**
 * Pay out the pot, in layers (side pots): a player who went all in for less is only in for the part of the pot they
 * matched. Each layer goes to the best hand among the players still in who put that much in; a layer that only one
 * player reached is their own uncalled money and goes straight back to them (no fee). `rank` orders the players
 * still in, higher = better; with one player left they win every layer they are in.
 */
function settle(s: HandState, out: LedgerEntry[], now: number, reason: Settlement["reason"], rank: (id: string) => number[], reveal: string[]) {
  const left = active(s);
  const won = new Map<string, number>();
  const back = new Map<string, number>();
  let rake = 0;
  const levels = [...new Set(left.map((id) => s.players[id].contributed))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    let layer = 0;
    for (const id of s.order) layer += Math.max(0, Math.min(s.players[id].contributed, level) - prev);
    const eligible = left.filter((id) => s.players[id].contributed >= level);
    if (eligible.length === 1 && reason === "SHOWDOWN") {
      // Only one player this deep at the showdown: the others' part of the layer is theirs, the rest is their own
      // bet that nobody could match — it goes straight back. (When everyone else folded, the whole pot is won.)
      const others = layer - (level - prev);
      const fee = Math.floor((others * s.rules.rakePct) / 100);
      rake += fee;
      if (others - fee > 0) won.set(eligible[0], (won.get(eligible[0]) ?? 0) + others - fee);
      back.set(eligible[0], (back.get(eligible[0]) ?? 0) + (level - prev));
    } else {
      const fee = Math.floor((layer * s.rules.rakePct) / 100);
      rake += fee;
      const pool = layer - fee;
      let best = rank(eligible[0]);
      for (const id of eligible) if (compareKeys(rank(id), best) > 0) best = rank(id);
      const winners = eligible.filter((id) => compareKeys(rank(id), best) === 0);
      const share = Math.floor(pool / winners.length);
      let rest = pool - share * winners.length;
      for (const id of winners) won.set(id, (won.get(id) ?? 0) + share);
      // Odd chips one at a time to the tied winners, clockwise after the dealer (s.order already starts there).
      for (const id of s.order) {
        if (rest === 0) break;
        if (winners.includes(id)) { won.set(id, won.get(id)! + 1); rest--; }
      }
    }
    prev = level;
  }
  for (const [id, amt] of won) credit(s, out, id, "PAYOUT", amt);
  for (const [id, amt] of back) credit(s, out, id, "REFUND", amt);
  s.settlement = {
    reason, winners: [...won].filter(([, amount]) => amount > 0).map(([playerId, amount]) => ({ playerId, amount })),
    returned: [...back].filter(([, amount]) => amount > 0).map(([playerId, amount]) => ({ playerId, amount })),
    reveal, rake, at: now,
  };
  s.phase = "COMPLETED";
  s.turnId = null;
  s.turnDeadline = null;
  s.botActAt = null;
  event(s, now, { type: "SETTLED", note: reason });
}

function showdown(s: HandState, out: LedgerEntry[], now: number) {
  s.stage = 4;
  const left = active(s);
  event(s, now, { type: "SHOWDOWN" });
  const keys = new Map(left.map((id) => [id, evaluate([...s.cards[id], ...s.board]).key]));
  settle(s, out, now, "SHOWDOWN", (id) => keys.get(id)!, left);
}

/** No betting left (everyone but one at most is all in): turn the rest of the board and show down. */
function runOut(s: HandState, out: LedgerEntry[], now: number) {
  while (s.stage < 3) {
    s.stage += 1;
    event(s, now, { type: "DEAL", note: STAGE_NAMES[s.stage] });
  }
  s.turnId = null; s.turnDeadline = null; s.botActAt = null;
  showdown(s, out, now);
}

/** After an action by the player on turn: one survivor wins; otherwise the next to act, or the next street. */
function afterAction(s: HandState, out: LedgerEntry[], now: number, rng: Rng, from: string) {
  const left = active(s);
  if (left.length === 1) return settle(s, out, now, "LAST_STANDING", () => [1], []);
  const next = nextToAct(s, from);
  if (next) return setTurn(s, next, now, rng);
  // Betting round over: with nobody left to bet against, run the board out; otherwise the next card(s), or the
  // showdown after the river.
  if (canAct(s).length <= 1) return runOut(s, out, now);
  s.stage += 1;
  if (s.stage >= 4) return showdown(s, out, now);
  event(s, now, { type: "DEAL", note: STAGE_NAMES[s.stage] });
  beginRound(s, now, rng);
}

/** Void the hand and give everyone back exactly what they put in (once — the refund keys are unique). */
export function voidHand(state: HandState, now: number, note: string): Result {
  if (state.phase === "COMPLETED" || state.phase === "VOIDED") return { state, ledger: [], ok: false, error: "HAND_OVER", changed: false };
  const s = clone(state);
  const out: LedgerEntry[] = [];
  for (const id of s.order) credit(s, out, id, "REFUND", s.players[id].contributed);
  s.phase = "VOIDED";
  s.settlement = { reason: "VOID", winners: [], reveal: [], rake: 0, at: now };
  s.turnId = null; s.turnDeadline = null; s.botActAt = null;
  event(s, now, { type: "VOIDED", note });
  s.version++;
  return { state: s, ledger: out, ok: true, changed: true };
}

// ------------------------------------------------------------------------------------------------- deadlines & bots

/**
 * Resolve everything that has fallen due by `now`: turn timeouts (fold, or check when there is nothing to call)
 * and bot moves. Called before every command and on every poll.
 */
export function processDue(state: HandState, ctx: Ctx): Result {
  let s = state;
  const ledger: LedgerEntry[] = [];
  let changed = false;
  for (let guard = 0; guard < 64; guard++) {
    if (s.phase !== "PLAYING" || !s.turnId) break;
    let step: Result | null = null;
    const botDue = s.players[s.turnId].bot && s.botActAt !== null && ctx.now >= s.botActAt;
    // Each due item is resolved at the moment it fell due, so a late poll replays the timeline exactly.
    if (s.turnDeadline !== null && ctx.now >= s.turnDeadline && !(botDue && s.botActAt! < s.turnDeadline)) {
      const who = s.turnId;
      const at = { ...ctx, now: s.turnDeadline };
      step = internal(s, at, (x, out) => {
        const p = x.players[who];
        if (toCall(x, who) > 0) {
          p.status = "FOLDED";
          p.foldReason = "TIMEOUT";
          event(x, at.now, { type: "TIMEOUT", playerId: who, note: "Folded" });
        } else {
          event(x, at.now, { type: "TIMEOUT", playerId: who, note: "Checked" });
        }
        p.acted = true;
        afterAction(x, out, at.now, at.rng, who);
      });
    } else if (botDue) {
      step = botMove(s, { ...ctx, now: s.botActAt! });
    }
    if (!step) break;
    s = step.state;
    ledger.push(...step.ledger);
    changed = true;
  }
  return { state: s, ledger, ok: true, changed };
}

function internal(s0: HandState, ctx: Ctx, f: (s: HandState, out: LedgerEntry[]) => void): Result {
  const s = clone(s0);
  const out: LedgerEntry[] = [];
  f(s, out);
  s.version++;
  return { state: s, ledger: out, ok: true, changed: true };
}

/**
 * How good a hand is, 0 (rubbish) … 1 (the nuts), from two hole cards and the board so far. Before the flop:
 * pairs, high cards, suited and connected cards. After it: the made hand (discounting what the board gives
 * everyone), top pair, and flush draws. Bots only ever look at their own cards and the public board.
 */
export function handStrength(hole: Card[], board: Card[]): number {
  const [a, b] = hole.map((c) => c.r).sort((x, y) => y - x);
  if (board.length < 3) {
    if (a === b) return Math.min(1, 0.55 + (a / 14) * 0.45);
    let st = ((a + b) / 28) * 0.55;
    if (hole[0].s === hole[1].s) st += 0.07;
    const gap = a - b;
    st += gap === 1 ? 0.06 : gap === 2 ? 0.03 : 0;
    if (a === 14) st += 0.05;
    return Math.min(1, st);
  }
  const all = [...hole, ...board];
  const key = evaluate(all).key;
  const cat = key[0];
  const BY_CAT = [0.12, 0.38, 0.62, 0.72, 0.8, 0.85, 0.93, 0.98, 1, 1];
  let st = BY_CAT[cat] ?? 0.12;
  const boardCat = board.length >= 5 ? evaluate(board).key[0] : new Set(board.map((c) => c.r)).size < board.length ? 1 : 0;
  if (cat <= boardCat) st *= 0.5; // just playing the board
  const topBoard = Math.max(...board.map((c) => c.r));
  if (cat === 1 && (key[1] ?? 0) >= topBoard) st += 0.12; // top pair or an overpair
  if (board.length < 5) {
    const suits: Record<string, number> = {};
    for (const c of all) suits[c.s] = (suits[c.s] ?? 0) + 1;
    if (Object.values(suits).some((n) => n === 4) && hole.some((c) => suits[c.s] === 4)) st += 0.15; // flush draw
  }
  return Math.min(1, st);
}

/** Chance (0–1) a bot folds: weak hands fold more, and more so against bigger bets; nothing to call, no fold. */
export function foldChance(strength: number, call: number, boot: number, preflop: boolean): number {
  if (call <= 0) return 0;
  const pressure = Math.min(1, call / (boot * 4));
  const p = strength < 0.2 ? 0.55 + 0.35 * pressure
    : strength < 0.35 ? 0.2 + 0.4 * pressure
    : strength < 0.5 ? 0.05 + 0.2 * pressure
    : strength < 0.65 ? 0.02 + 0.06 * pressure
    : 0;
  return preflop && pressure <= 0.25 ? p * 0.6 : p;
}

/** Best possible hand right now for `id` given the board on show (hole + visible board, padded by the full board
 *  when fewer than five cards are out — the house knows the rest of the board). */
function finalKey(s: HandState, id: string) {
  return evaluate([...s.cards[id], ...s.board]).key;
}

/**
 * House bots, in the same shape as Teen Patti's. One bot — the "closer", the active bot that wins at the showdown
 * (the house knows the whole deal) — carries the house's side: while it beats the human it never folds, calls
 * everything and raises now and then, so a force_loss human loses a pot worth having at the showdown. When the human
 * holds the winning hand, every bot folds early: the human wins the antes and a bet or two, not a pot the bots
 * built. The other bots play their cards like people: fold weak hands against bets, call with fair hands, raise
 * with strong ones. Ties with the human: the closer plays on (a split pot is fine).
 */
function botMove(s: HandState, ctx: Ctx): Result {
  const id = s.turnId!;
  const r = ctx.rng;
  const act = (type: ActionType, to?: number) => applyInternal(s, { actionId: `bot:${s.version}`, playerId: id, handId: s.handId, expectedVersion: s.version, type, to }, ctx);
  const bal = balanceOf(s, ctx, id);
  const call = toCall(s, id);
  const board = s.board.slice(0, boardVisible(s.stage));
  const strength = handStrength(s.cards[id], board);

  const activeBots = active(s).filter((pid) => s.players[pid].bot);
  const activeHumans = active(s).filter((pid) => !s.players[pid].bot);
  // The closer: the active bot with the best final hand, among those who can keep paying (a short stack can't see
  // the hand through, so it plays like the others).
  const deep = activeBots.filter((b) => (s.botBalances[b] ?? 0) >= Math.max(toCall(s, b), s.rules.boot * 4));
  const pool = deep.length ? deep : activeBots;
  let closer = pool[0];
  for (const b of pool) if (compareKeys(finalKey(s, b), finalKey(s, closer)) > 0) closer = b;
  const isCloser = id === closer;
  const beatsHumans = activeHumans.length > 0 && activeHumans.every((h) => compareKeys(finalKey(s, id), finalKey(s, h)) > 0);

  const callOrCheck = () => {
    const res = call > 0 ? act("CALL") : act("CHECK");
    return res.ok ? res : act("FOLD");
  };
  const tryRaise = (big: boolean) => {
    if (s.raises >= s.rules.maxRaises || s.botRaises >= BOT_RAISES) return null;
    const { min, max } = raiseRange(s, id, bal);
    const want = min * (big ? 2 : 1);
    const to = Math.min(max, Math.max(min, Math.floor(want / s.rules.boot) * s.rules.boot));
    if (to < min || to > bal + s.players[id].bet) return null;
    // Keep enough behind for the rest of the hand.
    if (bal - (to - s.players[id].bet) < s.rules.boot * 4) return null;
    const res = act("RAISE", to);
    return res.ok ? res : null;
  };

  // Someone is all in and that is the bet to match: everyone matches it — the full amount, or every coin they have
  // when that is less (a call for less puts the bot all in too). Nobody folds to an all-in.
  const facingAllIn = call > 0 && active(s).some((pid) => pid !== id && s.players[pid].allIn && s.players[pid].bet >= s.betLevel);
  if (facingAllIn) return callOrCheck();

  // No human left: wrap up fast — everyone but the closer folds, the closer checks or calls.
  if (activeHumans.length === 0) {
    if (!isCloser && activeBots.length > 1) return act("FOLD");
    return callOrCheck();
  }

  // Beaten by the human (a force_win deal, or a fair deal that went the player's way): no bot feeds a pot it will
  // lose. Check when it's free, call once while the bet is small, then fold — so the human wins with real cards but
  // only the antes and a bet or two, never a pot the bots built.
  const losing = !beatsHumans && !activeHumans.every((h) => compareKeys(finalKey(s, id), finalKey(s, h)) === 0);
  if (losing) {
    if (call === 0) return callOrCheck();
    const inFor = s.players[id].contributed;
    const giveUp = call > s.rules.boot * 2 || inFor >= s.rules.boot * 4 || s.pot >= s.rules.boot * 12 || board.length >= 4;
    return giveUp ? act("FOLD") : callOrCheck();
  }

  if (isCloser) {
    // Never folds. Can't cover the call (shouldn't happen: the richest bot is dealt the winning hand): call what it can.
    if (call > bal) return callOrCheck();
    // Raise sometimes while beating the human, so the pot is worth something; more often on later streets.
    const raiseChance = beatsHumans ? (board.length === 0 ? 25 : board.length === 3 ? 35 : 45) : 10;
    if (r.int(100) < raiseChance) {
      const res = tryRaise(beatsHumans && board.length >= 4 && r.int(100) < 40);
      if (res) return res;
    }
    return callOrCheck();
  }

  // Supporting bots: play their cards. Fold weak hands against a bet, call fair hands, raise strong ones; a bet
  // bigger than the stack is called all in only with a strong hand.
  if (call > bal) return strength > 0.8 ? callOrCheck() : act("FOLD");
  if (r.int(1000) < Math.round(foldChance(strength, call, s.rules.boot, board.length === 0) * 1000)) return act("FOLD");
  const raiseChance = strength > 0.8 ? 45 : strength > 0.65 ? 22 : strength > 0.45 ? 8 : 3;
  if (r.int(100) < raiseChance) {
    const res = tryRaise(strength > 0.8 && r.int(100) < 40);
    if (res) return res;
  }
  return callOrCheck();
}

// ------------------------------------------------------------------------------------------------- commands

/** Hash of the parts of a command that define it (for idempotency). */
export function commandHash(c: Command) {
  return [c.playerId, c.handId, c.expectedVersion, c.type, c.to ?? ""].join("|");
}

/**
 * Apply one player command. Order: idempotency → hand/version → due timers → legality → payment → ending.
 * A rejected command leaves the state untouched.
 */
export function applyCommand(state: HandState, cmd: Command, ctx: Ctx): Result {
  const hash = commandHash(cmd);
  const prev = state.processed[cmd.actionId];
  if (prev) {
    if (prev.hash !== hash) return reject(state, "ACTION_ID_REUSED", "This action id was already used for a different action");
    return { state, ledger: [], ok: prev.ok, error: prev.error as ErrorCode | undefined, changed: false };
  }
  if (cmd.handId !== state.handId) return reject(state, "STALE_HAND", "That hand is over");
  if (cmd.type !== "LEAVE" && cmd.expectedVersion !== state.version) return reject(state, "STALE_VERSION", "The table moved on — try again");

  const due = processDue(state, ctx);
  const res = applyInternal(due.state, cmd, ctx);
  if (!res.ok) return { ...res, state: due.state, ledger: due.ledger, changed: due.changed };
  if (!res.changed) return { state: due.state, ledger: due.ledger, ok: true, changed: due.changed };
  const s = res.state;
  s.processed[cmd.actionId] = { hash, ok: true };
  return { state: s, ledger: [...due.ledger, ...res.ledger], ok: true, changed: true };
}

function reject(state: HandState, error: ErrorCode, message: string): Result {
  return { state, ledger: [], ok: false, error, message, changed: false };
}

function applyInternal(state: HandState, cmd: Command, ctx: Ctx): Result {
  const s = state;
  const id = cmd.playerId;
  const p = s.players[id];
  if (s.phase !== "PLAYING") return reject(s, "HAND_OVER", "This hand is over");
  if (!p) return reject(s, "NOT_IN_HAND", "You are not in this hand");
  if (cmd.type === "LEAVE") return leave(s, id, ctx);
  if (p.status !== "ACTIVE") return reject(s, "NOT_IN_HAND", "You have folded");
  if (s.turnId !== id) return reject(s, "NOT_YOUR_TURN", "Not your turn");
  const call = toCall(s, id);

  switch (cmd.type) {
    case "FOLD":
      return internal(s, ctx, (x, out) => {
        x.players[id].status = "FOLDED";
        x.players[id].foldReason = "FOLD";
        x.players[id].acted = true;
        event(x, ctx.now, { type: "FOLD", playerId: id });
        afterAction(x, out, ctx.now, ctx.rng, id);
      });

    case "CHECK":
    case "CALL": {
      if (cmd.type === "CHECK" && call > 0) return reject(s, "CANNOT_CHECK", `There is ${call} to call`);
      const bal = balanceOf(s, ctx, id);
      if (call > 0 && bal <= 0) return reject(s, "INSUFFICIENT_CHIPS", "No coins left to call with");
      // Can't cover the call: all in for what's there, in for a share of the pot up to that much.
      const amount = Math.min(call, bal);
      return internal(s, ctx, (x, out) => {
        if (call > 0) {
          pay(x, out, id, "BET", amount, bal);
          x.players[id].bet += amount;
          event(x, ctx.now, { type: "CALL", playerId: id, amount, note: x.players[id].allIn ? "All in" : undefined });
        } else event(x, ctx.now, { type: "CHECK", playerId: id });
        x.players[id].acted = true;
        afterAction(x, out, ctx.now, ctx.rng, id);
      });
    }

    case "RAISE": {
      const to = cmd.to;
      if (s.raises >= s.rules.maxRaises) return reject(s, "RAISE_LIMIT", "No more raises this round — call or fold");
      const bal = balanceOf(s, ctx, id);
      const { min, max } = raiseRange(s, id, bal);
      if (typeof to !== "number" || !Number.isSafeInteger(to)) return reject(s, "RAISE_RANGE", "Pick a raise amount");
      // Everything in: a raise for less than the minimum is allowed when it is every coin the player has (it does
      // not reopen the betting for those who already acted, as in any card room).
      const shove = to === p.bet + bal && to > s.betLevel && to <= s.rules.maxBet;
      if (!shove) {
        if (max < min && p.bet + bal > s.betLevel) return reject(s, "RAISE_RANGE", `Short of a full raise: all in to ${p.bet + bal}, call or fold`);
        if (max < min) return reject(s, "INSUFFICIENT_CHIPS", "Not enough coins to raise");
        if (to < min || to > max) return reject(s, "RAISE_RANGE", `Raise to between ${min} and ${max}`);
      }
      const amount = to - p.bet;
      const full = to >= min;
      return internal(s, ctx, (x, out) => {
        pay(x, out, id, "BET", amount, bal);
        x.players[id].bet = to;
        x.betLevel = to;
        if (full) {
          x.raises++;
          if (x.players[id].bot) x.botRaises++;
          for (const o of x.order) x.players[o].acted = o === id;
        } else {
          // Short all-in: the others only need to match it; whoever has acted stays acted.
          for (const o of x.order) if (x.players[o].bet < to) x.players[o].acted = o === id;
          x.players[id].acted = true;
        }
        event(x, ctx.now, { type: "RAISE", playerId: id, amount: to, note: x.players[id].allIn ? "All in" : undefined });
        afterAction(x, out, ctx.now, ctx.rng, id);
      });
    }
  }
  return reject(s, "UNKNOWN_ACTION", "Unknown action");
}

function leave(s0: HandState, id: string, ctx: Ctx): Result {
  if (s0.players[id].status !== "ACTIVE") return { state: s0, ledger: [], ok: true, changed: false };
  return internal(s0, ctx, (s, out) => {
    s.players[id].status = "FOLDED";
    s.players[id].foldReason = "LEFT";
    s.players[id].acted = true;
    event(s, ctx.now, { type: "LEFT", playerId: id });
    if (s.turnId === id) return afterAction(s, out, ctx.now, ctx.rng, id);
    const left = active(s);
    if (left.length === 1) settle(s, out, ctx.now, "LAST_STANDING", () => [1], []);
    // The one who left was the last player who could still bet: nothing to wait for, run the board out.
    else if (s.turnId === null && canAct(s).length <= 1 && s.phase === "PLAYING") runOut(s, out, ctx.now);
  });
}

// ------------------------------------------------------------------------------------------------- checks

/** Money invariants: pot = all contributions; once settled, payouts + fee = pot; once void, refunds = contributions. */
export function checkInvariants(s: HandState) {
  const paidIn = -s.ledger.filter((e) => e.amount < 0).reduce((t, e) => t + e.amount, 0);
  if (paidIn !== s.pot) throw new Error(`pot ${s.pot} != contributions ${paidIn}`);
  const sumContrib = Object.values(s.players).reduce((t, p) => t + p.contributed, 0);
  if (sumContrib !== s.pot) throw new Error("player contributions do not add up to the pot");
  const keys = new Set(s.ledger.map((e) => e.key));
  if (keys.size !== s.ledger.length) throw new Error("duplicate ledger key");
  const payouts = s.ledger.filter((e) => e.kind === "PAYOUT").reduce((t, e) => t + e.amount, 0);
  const refunds = s.ledger.filter((e) => e.kind === "REFUND").reduce((t, e) => t + e.amount, 0);
  if (s.phase === "COMPLETED" && payouts + refunds + (s.settlement?.rake ?? 0) !== s.pot) throw new Error(`payouts ${payouts} + returned ${refunds} + fee != pot ${s.pot}`);
  if (s.phase === "VOIDED" && refunds !== s.pot) throw new Error(`refunds ${refunds} != pot ${s.pot}`);
  if (s.phase !== "COMPLETED" && payouts) throw new Error("payout before settlement");
  for (const id of s.order) {
    const p = s.players[id];
    if (p.status === "ACTIVE" && s.phase === "PLAYING" && p.bet > s.betLevel) throw new Error("a bet above the bet level");
  }
}
