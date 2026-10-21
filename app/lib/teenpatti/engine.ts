// Classic Teen Patti hand engine — a pure state machine, no I/O. Every function takes the current hand state and
// returns a new one plus the ledger entries the caller must apply atomically (see service.ts / migration 066).
// Fair play only: the server deals with an unbiased shuffle and nothing here looks at who should win.
//
// House rules in short (full text: app/lib/teenpatti/RULES.md):
//   boot from every participant, all start BLIND; turn order clockwise from the seat after the dealer;
//   blind: min = base, double = 2·base → base = paid; seen: min = 2·base, double = 4·base → base = paid / 2;
//   PACK on your turn; SHOW with exactly two left (seen-vs-blind not allowed, tie → requester loses);
//   SIDESHOW with 3+ left against the last bettor (both seen), fee 2·base, tie → requester packs;
//   pot ≥ potCap or action count ≥ maxTurnActions → forced showdown among everyone left (ties split).

import { cardId, compareHands, compareKeys, evaluate, fullDeck, validateRoster, type Card } from "./evaluator.ts";

export interface Rules {
  boot: number;
  maxBaseStake: number;
  /** Forced showdown once the pot reaches this. null = off. */
  potCap: number | null;
  turnTimeoutMs: number;
  sideshowTimeoutMs: number;
  /** Forced showdown after this many bets + sideshow requests + packs. null = off. */
  maxTurnActions: number | null;
  /** Blind chaals a player must play before they may see their cards (default 1). */
  minBlind?: number;
  /** After this many blind chaals a player is seen automatically when their turn comes (default 3). */
  blindLimit?: number;
  /** Platform fee taken off the pot before the payout, in percent (default 0). Admin → Game Config. */
  rakePct?: number;
}
export const rakePctOf = (r: Rules) => Math.min(25, Math.max(0, r.rakePct ?? 0));
export const DEFAULT_MIN_BLIND = 1;
export const DEFAULT_BLIND_LIMIT = 3;
export const minBlindOf = (r: Rules) => r.minBlind ?? DEFAULT_MIN_BLIND;
export const blindLimitOf = (r: Rules) => r.blindLimit ?? DEFAULT_BLIND_LIMIT;

export const MAX_SEATS = 6;

export function validateRules(r: Rules, maxPlayers = MAX_SEATS): string | null {
  const posInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!posInt(r.boot)) return "Boot must be a positive whole number";
  if (!posInt(r.maxBaseStake) || r.maxBaseStake < r.boot) return "Max base stake must be at least the boot";
  if (r.potCap !== null && (!posInt(r.potCap) || r.potCap <= r.boot * maxPlayers)) return "Pot cap must exceed the largest starting pot";
  if (!posInt(r.turnTimeoutMs) || !posInt(r.sideshowTimeoutMs)) return "Timeouts must be positive";
  if (r.maxTurnActions !== null && !posInt(r.maxTurnActions)) return "Max turn actions must be positive";
  if (r.rakePct !== undefined && (typeof r.rakePct !== "number" || r.rakePct < 0 || r.rakePct > 25)) return "Platform fee must be 0–25%";
  const mb = minBlindOf(r), bl = blindLimitOf(r);
  if (!Number.isInteger(mb) || mb < 0 || !posInt(bl) || bl < mb) return "Blind limit must be at least the minimum blind count";
  return null;
}

export interface Seat { seat: number; playerId: string; name: string; bot: boolean }

export type Phase = "WAITING" | "DEALING" | "PLAYING" | "SIDESHOW_PENDING" | "SETTLING" | "COMPLETED" | "VOIDED";

export interface HandPlayer extends Seat {
  /** Participation in this hand. Packed players stay participants (their money is in the pot). */
  status: "ACTIVE" | "PACKED";
  seen: boolean;
  /** Blind chaals played this hand. */
  blinds: number;
  contributed: number;
  packReason: "PACK" | "TIMEOUT" | "LEFT" | "SIDESHOW" | null;
}

export type LedgerKind = "BOOT" | "BET" | "SHOW_FEE" | "SIDESHOW_FEE" | "PAYOUT" | "REFUND";
export interface LedgerEntry {
  /** Unique within the hand — the database refuses a second entry with the same key (exactly-once). */
  key: string;
  playerId: string;
  bot: boolean;
  kind: LedgerKind;
  /** Negative: paid into the pot. Positive: paid out of it. */
  amount: number;
}

export interface PendingSideshow { requestId: string; requesterId: string; targetId: string; deadline: number }

export interface Settlement {
  reason: "LAST_STANDING" | "SHOW" | "FORCED_SHOWDOWN" | "VOID";
  winners: { playerId: string; amount: number }[];
  /** Players whose cards are public. */
  reveal: string[];
  requesterId?: string;
  /** Platform fee kept from the pot. */
  rake: number;
  at: number;
}

export interface HandEvent {
  seq: number;
  at: number;
  type: "BOOT" | "SEE" | "BET" | "PACK" | "TIMEOUT" | "LEFT" | "SHOW" | "SIDESHOW_REQUEST" | "SIDESHOW_ACCEPT" | "SIDESHOW_REJECT" | "SIDESHOW_TIMEOUT" | "SIDESHOW_CANCEL" | "SIDESHOW_RESULT" | "FORCED_SHOWDOWN" | "SETTLED" | "VOIDED";
  playerId?: string;
  amount?: number;
  /** Public detail only — never cards. */
  note?: string;
}

/** A side show result, visible only to its two players. */
export interface SideshowOutcome { requesterId: string; targetId: string; loserId: string; at: number }

export interface ProcessedAction { hash: string; ok: boolean; error?: string }

export interface HandState {
  handId: string;
  tableId: string;
  handNo: number;
  version: number;
  phase: Phase;
  rules: Rules;
  dealerSeat: number;
  /** Participating player ids in clockwise seat order. */
  order: string[];
  players: Record<string, HandPlayer>;
  /** Private. Never leaves the server except through viewFor(). */
  cards: Record<string, Card[]>;
  turnId: string | null;
  turnDeadline: number | null;
  /** When a bot on turn (or a bot asked for a side show) acts. */
  botActAt: number | null;
  baseStake: number;
  pot: number;
  lastBettorId: string | null;
  pending: PendingSideshow | null;
  actionCount: number;
  ledger: LedgerEntry[];
  events: HandEvent[];
  sideshows: SideshowOutcome[];
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

export type ActionType =
  | "SEE_CARDS" | "BET_MIN" | "BET_DOUBLE" | "PACK" | "SHOW"
  | "SIDESHOW_REQUEST" | "SIDESHOW_ACCEPT" | "SIDESHOW_REJECT" | "LEAVE";

export interface Command {
  actionId: string;
  playerId: string;
  handId: string;
  expectedVersion: number;
  type: ActionType;
  /** SIDESHOW_ACCEPT / SIDESHOW_REJECT: the request being answered. */
  requestId?: string;
}

export interface Ctx {
  now: number;
  /** Human wallet balances at the time of the command (the database re-checks every debit). */
  balances: Record<string, number>;
  rng: Rng;
  outcomeModes?: Record<string, string>;
}

export type ErrorCode =
  | "ACTION_ID_REUSED" | "STALE_HAND" | "STALE_VERSION" | "HAND_OVER" | "NOT_IN_HAND" | "NOT_YOUR_TURN" | "SIDESHOW_PENDING"
  | "INSUFFICIENT_CHIPS" | "MAX_STAKE" | "SHOW_NOT_ALLOWED" | "SIDESHOW_NOT_ALLOWED" | "NO_SIDESHOW" | "UNKNOWN_ACTION" | "BLIND_FIRST";

export interface Result {
  state: HandState;
  /** Ledger entries created by this step, to apply atomically with the state. */
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

/** Unbiased Fisher–Yates with the given RNG. */
export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const active = (s: HandState) => s.order.filter((id) => s.players[id].status === "ACTIVE");

/** Next ACTIVE participant clockwise after `fromId` (which may itself be packed). */
function nextActive(s: HandState, fromId: string): string | null {
  const i = s.order.indexOf(fromId);
  for (let k = 1; k <= s.order.length; k++) {
    const id = s.order[(i + k) % s.order.length];
    if (s.players[id].status === "ACTIVE" && id !== fromId) return id;
  }
  return null;
}

function event(s: HandState, now: number, e: Omit<HandEvent, "seq" | "at">) {
  s.events.push({ seq: s.events.length + 1, at: now, ...e });
}

function balanceOf(s: HandState, ctx: Ctx, id: string) {
  return s.players[id].bot ? s.botBalances[id] ?? 0 : ctx.balances[id] ?? 0;
}

function pay(s: HandState, out: LedgerEntry[], id: string, kind: LedgerKind, amount: number) {
  assertInt(amount);
  const p = s.players[id];
  const e: LedgerEntry = { key: `${kind}:${s.ledger.length + 1}:${id}`, playerId: id, bot: p.bot, kind, amount: -amount };
  s.ledger.push(e);
  out.push(e);
  p.contributed = assertInt(p.contributed + amount);
  s.pot = assertInt(s.pot + amount);
  if (p.bot) s.botBalances[id] = (s.botBalances[id] ?? 0) - amount;
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
  // Blind limit: a player who has played all their blind chaals sees their cards as their turn comes round.
  if (id && !s.players[id].seen && s.players[id].blinds >= blindLimitOf(s.rules)) {
    s.players[id].seen = true;
    event(s, now, { type: "SEE", playerId: id, note: "Blind limit" });
  }
  s.turnId = id;
  s.turnDeadline = id ? now + s.rules.turnTimeoutMs : null;
  s.botActAt = id && s.players[id].bot ? now + botDelay(s, rng) : null;
}

/** Bots take 1.5–4 s (never past the deadline). */
function botDelay(s: HandState, rng: Rng) {
  return Math.min(1500 + rng.int(2500), s.rules.turnTimeoutMs - 500);
}

const reachedCap = (s: HandState) => s.rules.potCap !== null && s.pot >= s.rules.potCap;
const reachedActions = (s: HandState) => s.rules.maxTurnActions !== null && s.actionCount >= s.rules.maxTurnActions;

// ------------------------------------------------------------------------------------------------- start

export interface StartInput {
  tableId: string;
  handId: string;
  handNo: number;
  rules: Rules;
  /** Occupied seats (seat numbers 0..5). Mid-hand joiners are simply seated for the next hand. */
  seats: Seat[];
  /** Dealer of the previous hand, or null for the first one. */
  prevDealerSeat: number | null;
  balances: Record<string, number>;
  botBalances: Record<string, number>;
  now: number;
  rng: Rng;
  /** Tests only: a fixed deck order instead of a shuffle. */
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
  // Clockwise order starting with the first player after the dealer; the dealer acts last.
  const di = playing.indexOf(dealer);
  const orderSeats = [...playing.slice(di + 1), ...playing.slice(0, di + 1)];

  const s: HandState = {
    handId: inp.handId, tableId: inp.tableId, handNo: inp.handNo, version: 1, phase: "DEALING", rules: clone(inp.rules),
    dealerSeat: dealer.seat, order: orderSeats.map((x) => x.playerId), players: {}, cards: {},
    turnId: null, turnDeadline: null, botActAt: null, baseStake: inp.rules.boot, pot: 0, lastBettorId: null, pending: null,
    actionCount: 0, ledger: [], events: [], sideshows: [], processed: {}, settlement: null,
    botBalances: { ...inp.botBalances }, createdAt: inp.now,
  };
  for (const x of orderSeats) s.players[x.playerId] = { ...x, status: "ACTIVE", seen: false, blinds: 0, contributed: 0, packReason: null };

  const deck = inp.deck ?? shuffle(fullDeck(), inp.rng);
  orderSeats.forEach((x, i) => { s.cards[x.playerId] = deck.slice(i * 3, i * 3 + 3); });
  const out: LedgerEntry[] = [];
  try {
    validateRoster(Object.values(s.cards));
  } catch {
    // An invalid or duplicated deck never reaches the table: the hand is void before anyone pays.
    s.phase = "VOIDED";
    s.settlement = { reason: "VOID", winners: [], reveal: [], rake: 0, at: inp.now };
    event(s, inp.now, { type: "VOIDED", note: "Invalid deck" });
    return { state: s, ledger: [], ok: false, message: "Invalid deck", changed: true };
  }
  for (const id of s.order) {
    pay(s, out, id, "BOOT", inp.rules.boot);
    event(s, inp.now, { type: "BOOT", playerId: id, amount: inp.rules.boot });
  }
  s.phase = "PLAYING";
  setTurn(s, s.order[0], inp.now, inp.rng);
  return { state: s, ledger: out, ok: true, changed: true };
}

// ------------------------------------------------------------------------------------------------- settlement

function settle(s: HandState, out: LedgerEntry[], now: number, reason: Settlement["reason"], winners: string[], reveal: string[], requesterId?: string) {
  s.phase = "SETTLING";
  // The platform fee comes off the pot first; the winners share what is left.
  const rake = Math.floor((s.pot * rakePctOf(s.rules)) / 100);
  const pool = s.pot - rake;
  const share = Math.floor(pool / winners.length);
  let rest = pool - share * winners.length;
  const amounts = new Map(winners.map((w) => [w, share]));
  // Odd chips one at a time to the tied winners, clockwise after the dealer (s.order already starts there).
  for (const id of s.order) {
    if (rest === 0) break;
    if (amounts.has(id)) { amounts.set(id, amounts.get(id)! + 1); rest--; }
  }
  for (const [id, amt] of amounts) credit(s, out, id, "PAYOUT", amt);
  s.settlement = { reason, winners: [...amounts].map(([playerId, amount]) => ({ playerId, amount })), reveal, requesterId, rake, at: now };
  s.phase = "COMPLETED";
  s.turnId = null;
  s.turnDeadline = null;
  s.botActAt = null;
  s.pending = null;
  event(s, now, { type: "SETTLED", note: reason });
}

function forcedShowdown(s: HandState, out: LedgerEntry[], now: number) {
  const left = active(s);
  event(s, now, { type: "FORCED_SHOWDOWN" });
  const keys = new Map(left.map((id) => [id, evaluate(s.cards[id]).key]));
  let best = keys.get(left[0])!;
  for (const k of keys.values()) if (compareKeys(k, best) > 0) best = k;
  const winners = left.filter((id) => compareKeys(keys.get(id)!, best) === 0);
  settle(s, out, now, "FORCED_SHOWDOWN", winners, left);
}

/** After a bet / pack / timeout / leave: one survivor wins; a reached limit forces a showdown; else next turn. */
function afterAction(s: HandState, out: LedgerEntry[], now: number, rng: Rng, from: string, advance: boolean) {
  const left = active(s);
  if (left.length === 1) return settle(s, out, now, "LAST_STANDING", left, []);
  if (reachedCap(s) || reachedActions(s)) return forcedShowdown(s, out, now);
  if (advance) setTurn(s, nextActive(s, from), now, rng);
}

/** Void the hand and give everyone back exactly what they put in (once — the refund keys are unique). */
export function voidHand(state: HandState, now: number, note: string): Result {
  if (state.phase === "COMPLETED" || state.phase === "VOIDED") return { state, ledger: [], ok: false, error: "HAND_OVER", changed: false };
  const s = clone(state);
  const out: LedgerEntry[] = [];
  for (const id of s.order) credit(s, out, id, "REFUND", s.players[id].contributed);
  s.phase = "VOIDED";
  s.settlement = { reason: "VOID", winners: [], reveal: [], rake: 0, at: now };
  s.turnId = null; s.turnDeadline = null; s.botActAt = null; s.pending = null;
  event(s, now, { type: "VOIDED", note });
  s.version++;
  return { state: s, ledger: out, ok: true, changed: true };
}

// ------------------------------------------------------------------------------------------------- amounts

export function betAmount(s: HandState, id: string, double: boolean) {
  const seen = s.players[id].seen;
  const amount = s.baseStake * (seen ? 2 : 1) * (double ? 2 : 1);
  return { amount, newBase: seen ? amount / 2 : amount };
}

/** Why a SHOW is not allowed right now for `id` (null = allowed), and its fee. */
export function showCheck(s: HandState, id: string): { reason: string | null; fee: number } {
  const p = s.players[id];
  const fee = p.seen ? 2 * s.baseStake : s.baseStake;
  const left = active(s);
  if (left.length !== 2) return { reason: "Show needs exactly two players left", fee };
  const opp = left.find((x) => x !== id)!;
  if (p.seen && !s.players[opp].seen) return { reason: "A seen player can't ask a blind player for a show", fee };
  return { reason: null, fee };
}

/** Why a SIDESHOW is not allowed right now for `id` (null = allowed), its target and fee. */
export function sideshowCheck(s: HandState, id: string): { reason: string | null; targetId: string | null; fee: number } {
  const fee = 2 * s.baseStake;
  const t = s.lastBettorId;
  if (!s.players[id].seen) return { reason: "See your cards first", targetId: null, fee };
  if (active(s).length < 3) return { reason: "Side show needs three or more players", targetId: null, fee };
  if (!t || t === id) return { reason: "No previous bettor to ask", targetId: null, fee };
  if (s.players[t].status !== "ACTIVE") return { reason: "The last bettor has packed", targetId: null, fee };
  if (!s.players[t].seen) return { reason: "The last bettor is still blind", targetId: null, fee };
  return { reason: null, targetId: t, fee };
}

// ------------------------------------------------------------------------------------------------- deadlines & bots

/**
 * Resolve everything that has fallen due by `now`: sideshow response timeouts (auto-reject), turn timeouts
 * (auto-pack) and bot moves. Called before every command and on every poll.
 */
export function processDue(state: HandState, ctx: Ctx): Result {
  let s = state;
  const ledger: LedgerEntry[] = [];
  let changed = false;
  for (let guard = 0; guard < 64; guard++) {
    if (s.phase !== "PLAYING" && s.phase !== "SIDESHOW_PENDING") break;
    let step: Result | null = null;
    // Each due item is resolved at the moment it fell due, so a late poll replays the timeline exactly: the next
    // player's clock starts when the previous one ran out, not when someone happened to look.
    if (s.phase === "SIDESHOW_PENDING" && s.pending) {
      const p = s.pending;
      if (ctx.now >= p.deadline) {
        const at = { ...ctx, now: p.deadline };
        step = internal(s, at, (x, out) => answerSideshow(x, out, at, false, "SIDESHOW_TIMEOUT"));
      } else if (s.players[p.targetId].bot && s.botActAt !== null && ctx.now >= s.botActAt) {
        const at = { ...ctx, now: s.botActAt };
        const accept = botAcceptsSideshow(s, p.targetId, ctx.rng);
        step = internal(s, at, (x, out) => answerSideshow(x, out, at, accept, accept ? "SIDESHOW_ACCEPT" : "SIDESHOW_REJECT"));
      }
    } else if (s.turnId) {
      const botDue = s.players[s.turnId].bot && s.botActAt !== null && ctx.now >= s.botActAt;
      if (s.turnDeadline !== null && ctx.now >= s.turnDeadline && !(botDue && s.botActAt! < s.turnDeadline)) {
        const who = s.turnId;
        const at = { ...ctx, now: s.turnDeadline };
        step = internal(s, at, (x, out) => {
          x.players[who].status = "PACKED";
          x.players[who].packReason = "TIMEOUT";
          x.actionCount++;
          event(x, at.now, { type: "TIMEOUT", playerId: who });
          afterAction(x, out, at.now, at.rng, who, true);
        });
      } else if (botDue) {
        step = botMove(s, { ...ctx, now: s.botActAt! });
      }
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

/** Fair bot: it only knows its own cards (once seen), the pot and the stakes. */
function botMove(s: HandState, ctx: Ctx): Result {
  const id = s.turnId!;
  const r = ctx.rng;
  let st = s;
  const act = (type: ActionType) => applyInternal(st, { actionId: `bot:${st.version}`, playerId: id, handId: st.handId, expectedVersion: st.version, type }, ctx);

  // Check if there are active force_loss human players
  const activeLossHumans = Object.entries(ctx.outcomeModes ?? {})
    .filter(([uid, m]) => m === "force_loss" && st.players[uid]?.status === "ACTIVE")
    .map(([uid]) => uid);

  const isWinningBotForLoss =
    activeLossHumans.length > 0 &&
    activeLossHumans.every((hid) => !st.cards[hid] || compareHands(st.cards[id], st.cards[hid]) >= 0);

  if (!st.players[id].seen && (r.int(100) < 45 || st.events.filter((e) => e.playerId === id && e.type === "BET").length >= 2 || isWinningBotForLoss)) {
    const seen = act("SEE_CARDS");
    st = seen.state;
  }
  const p = st.players[id];
  const ev = p.seen ? evaluate(st.cards[id]) : null;
  const cat = ev ? ev.key[0] : 0;
  const strongHigh = ev && cat === 1 ? ev.key[1] >= 13 : false;
  const left = active(st).length;
  const pressure = st.baseStake / st.rules.boot; // how far the stakes have climbed

  const tryAct = (...types: ActionType[]): Result | null => {
    for (const t of types) {
      const res = act(t);
      if (res.ok) return res;
    }
    return null;
  };

  let res: Result | null = null;
  if (isWinningBotForLoss) {
    // THIS BOT HOLDS THE WINNING CARDS AGAINST FORCE_LOSS PLAYERS: NEVER PACK!
    if (left === 2) {
      if (pressure >= 4 || r.int(100) < 40) {
        res = tryAct("SHOW", "BET_DOUBLE", "BET_MIN");
      } else {
        res = tryAct("BET_DOUBLE", "BET_MIN", "SHOW");
      }
    } else {
      res = tryAct("BET_DOUBLE", "BET_MIN");
    }
    return res ?? tryAct("BET_MIN", "SHOW") ?? act("BET_MIN");
  }

  if (p.seen) {
    const weak = cat === 1 && !strongHigh;
    const packChance = weak ? Math.min(85, 25 + pressure * 6) : cat === 1 ? 15 + pressure * 2 : cat === 2 ? Math.min(40, pressure * 3) : 0;
    if (r.int(100) < packChance) res = tryAct("PACK");
    else if (left === 2 && (cat >= 3 || pressure >= 8 || r.int(100) < 25)) res = tryAct("SHOW", "BET_MIN", "PACK");
    else if (left >= 3 && cat >= 2 && r.int(100) < 20) res = tryAct("SIDESHOW_REQUEST", "BET_MIN", "PACK");
    else if (cat >= 4 && r.int(100) < 50) res = tryAct("BET_DOUBLE", "BET_MIN", "PACK");
    else res = tryAct("BET_MIN", "PACK");
  } else {
    res = r.int(100) < 15 ? tryAct("BET_DOUBLE", "BET_MIN", "PACK") : tryAct("BET_MIN", "PACK");
  }
  return res ?? act("PACK");
}

function botAcceptsSideshow(s: HandState, id: string, r: Rng) {
  const reqId = s.pending?.requesterId;
  if (reqId && s.cards[reqId] && s.cards[id]) {
    // If bot has better or equal cards, requester will lose the sideshow and pack
    if (compareHands(s.cards[id], s.cards[reqId]) >= 0) return true;
  }
  const cat = evaluate(s.cards[id]).key[0];
  return cat >= 2 || r.int(100) < 40;
}

// ------------------------------------------------------------------------------------------------- commands

/** Hash of the parts of a command that define it (for idempotency). */
export function commandHash(c: Command) {
  return [c.playerId, c.handId, c.expectedVersion, c.type, c.requestId ?? ""].join("|");
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
  if (!res.ok) {
    // The due timers still happened even though the command didn't.
    return { ...res, state: due.state, ledger: due.ledger, changed: due.changed };
  }
  // A no-op (e.g. SEE_CARDS when already seen) changes nothing and is not recorded: repeating it is harmless.
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
  if (s.phase !== "PLAYING" && s.phase !== "SIDESHOW_PENDING") return reject(s, "HAND_OVER", "This hand is over");
  if (!p) return reject(s, "NOT_IN_HAND", "You are not in this hand");
  if (cmd.type === "LEAVE") return leave(s, id, ctx);
  if (p.status !== "ACTIVE") return reject(s, "NOT_IN_HAND", "You have packed");

  if (cmd.type === "SIDESHOW_ACCEPT" || cmd.type === "SIDESHOW_REJECT") {
    const pend = s.pending;
    if (!pend || pend.targetId !== id || pend.requestId !== cmd.requestId) return reject(s, "NO_SIDESHOW", "No side show to answer");
    const accept = cmd.type === "SIDESHOW_ACCEPT";
    return internal(s, ctx, (x, out) => answerSideshow(x, out, ctx, accept, accept ? "SIDESHOW_ACCEPT" : "SIDESHOW_REJECT"));
  }
  if (s.phase === "SIDESHOW_PENDING") return reject(s, "SIDESHOW_PENDING", "Waiting for the side show answer");
  if (s.turnId !== id) return reject(s, "NOT_YOUR_TURN", "Not your turn");

  switch (cmd.type) {
    case "SEE_CARDS":
      if (p.seen) return { state: s, ledger: [], ok: true, changed: false }; // repeat: no change, no extra time
      if (p.blinds < minBlindOf(s.rules)) return reject(s, "BLIND_FIRST", `Play ${minBlindOf(s.rules)} blind chaal${minBlindOf(s.rules) === 1 ? "" : "s"} first`);
      return internal(s, ctx, (x) => {
        x.players[id].seen = true;
        event(x, ctx.now, { type: "SEE", playerId: id });
      });

    case "BET_MIN":
    case "BET_DOUBLE": {
      const { amount, newBase } = betAmount(s, id, cmd.type === "BET_DOUBLE");
      if (newBase > s.rules.maxBaseStake) return reject(s, "MAX_STAKE", "That is above the table's maximum stake");
      if (balanceOf(s, ctx, id) < amount) return reject(s, "INSUFFICIENT_CHIPS", "Not enough coins for that bet");
      return internal(s, ctx, (x, out) => {
        pay(x, out, id, "BET", amount);
        if (!x.players[id].seen) x.players[id].blinds++;
        x.baseStake = newBase;
        x.lastBettorId = id;
        x.actionCount++;
        event(x, ctx.now, { type: "BET", playerId: id, amount, note: `${x.players[id].seen ? "Chaal" : "Blind"}${cmd.type === "BET_DOUBLE" ? " 2x" : ""}` });
        afterAction(x, out, ctx.now, ctx.rng, id, true);
      });
    }

    case "PACK":
      return internal(s, ctx, (x, out) => {
        x.players[id].status = "PACKED";
        x.players[id].packReason = "PACK";
        x.actionCount++;
        event(x, ctx.now, { type: "PACK", playerId: id });
        afterAction(x, out, ctx.now, ctx.rng, id, true);
      });

    case "SHOW": {
      const { reason, fee } = showCheck(s, id);
      if (reason) return reject(s, "SHOW_NOT_ALLOWED", reason);
      if (balanceOf(s, ctx, id) < fee) return reject(s, "INSUFFICIENT_CHIPS", "Not enough coins for the show");
      return internal(s, ctx, (x, out) => {
        pay(x, out, id, "SHOW_FEE", fee);
        event(x, ctx.now, { type: "SHOW", playerId: id, amount: fee });
        const opp = active(x).find((o) => o !== id)!;
        const c = compareKeys(evaluate(x.cards[id]).key, evaluate(x.cards[opp]).key);
        settle(x, out, ctx.now, "SHOW", [c > 0 ? id : opp], [id, opp], id); // tie: the requester loses
      });
    }

    case "SIDESHOW_REQUEST": {
      const { reason, targetId, fee } = sideshowCheck(s, id);
      if (reason || !targetId) return reject(s, "SIDESHOW_NOT_ALLOWED", reason ?? "Side show not allowed");
      if (balanceOf(s, ctx, id) < fee) return reject(s, "INSUFFICIENT_CHIPS", "Not enough coins for the side show");
      return internal(s, ctx, (x, out) => {
        pay(x, out, id, "SIDESHOW_FEE", fee);
        x.actionCount++;
        event(x, ctx.now, { type: "SIDESHOW_REQUEST", playerId: id, amount: fee, note: x.players[targetId].name });
        if (reachedCap(x) || reachedActions(x)) return forcedShowdown(x, out, ctx.now);
        x.pending = { requestId: ctx.rng.uuid(), requesterId: id, targetId, deadline: ctx.now + x.rules.sideshowTimeoutMs };
        x.phase = "SIDESHOW_PENDING";
        x.turnDeadline = null; // normal turn actions are frozen; the response deadline runs instead
        x.botActAt = x.players[targetId].bot ? ctx.now + Math.min(1500 + ctx.rng.int(2000), x.rules.sideshowTimeoutMs - 500) : null;
      });
    }
  }
  return reject(s, "UNKNOWN_ACTION", "Unknown action");
}

function answerSideshow(s: HandState, out: LedgerEntry[], ctx: Ctx, accept: boolean, type: "SIDESHOW_ACCEPT" | "SIDESHOW_REJECT" | "SIDESHOW_TIMEOUT") {
  const p = s.pending!;
  s.pending = null;
  s.phase = "PLAYING";
  event(s, ctx.now, { type, playerId: p.targetId });
  if (accept) {
    const c = compareKeys(evaluate(s.cards[p.requesterId]).key, evaluate(s.cards[p.targetId]).key);
    const loser = c > 0 ? p.targetId : p.requesterId; // tie: the requester packs
    s.players[loser].status = "PACKED";
    s.players[loser].packReason = "SIDESHOW";
    s.sideshows.push({ requesterId: p.requesterId, targetId: p.targetId, loserId: loser, at: ctx.now });
    event(s, ctx.now, { type: "SIDESHOW_RESULT", playerId: loser, note: "Lost the side show" });
  }
  // Responses don't count toward maxTurnActions; the request already did.
  const left = active(s);
  if (left.length === 1) return settle(s, out, ctx.now, "LAST_STANDING", left, []);
  setTurn(s, nextActive(s, p.requesterId), ctx.now, ctx.rng);
}

function leave(s0: HandState, id: string, ctx: Ctx): Result {
  if (s0.players[id].status !== "ACTIVE") return { state: s0, ledger: [], ok: true, changed: false };
  return internal(s0, ctx, (s, out) => {
    s.players[id].status = "PACKED";
    s.players[id].packReason = "LEFT";
    s.actionCount++;
    event(s, ctx.now, { type: "LEFT", playerId: id });
    const pend = s.pending;
    if (pend) {
      const cancel = pend.requesterId === id || pend.targetId === id || active(s).length < 3 || reachedCap(s) || reachedActions(s);
      if (!cancel) return; // still valid: keep waiting for the answer
      s.pending = null;
      s.phase = "PLAYING";
      event(s, ctx.now, { type: "SIDESHOW_CANCEL" });
      const left = active(s);
      if (left.length === 1) return settle(s, out, ctx.now, "LAST_STANDING", left, []);
      if (reachedCap(s) || reachedActions(s)) return forcedShowdown(s, out, ctx.now);
      return setTurn(s, nextActive(s, pend.requesterId), ctx.now, ctx.rng);
    }
    afterAction(s, out, ctx.now, ctx.rng, id, s.turnId === id);
  });
}

// ------------------------------------------------------------------------------------------------- checks

/** Money invariants: pot = all contributions; once settled, payouts = pot; once void, refunds = contributions. */
export function checkInvariants(s: HandState) {
  const paidIn = -s.ledger.filter((e) => e.amount < 0).reduce((t, e) => t + e.amount, 0);
  if (paidIn !== s.pot) throw new Error(`pot ${s.pot} != contributions ${paidIn}`);
  const sumContrib = Object.values(s.players).reduce((t, p) => t + p.contributed, 0);
  if (sumContrib !== s.pot) throw new Error("player contributions do not add up to the pot");
  const keys = new Set(s.ledger.map((e) => e.key));
  if (keys.size !== s.ledger.length) throw new Error("duplicate ledger key");
  const payouts = s.ledger.filter((e) => e.kind === "PAYOUT").reduce((t, e) => t + e.amount, 0);
  const refunds = s.ledger.filter((e) => e.kind === "REFUND").reduce((t, e) => t + e.amount, 0);
  if (s.phase === "COMPLETED" && payouts + (s.settlement?.rake ?? 0) !== s.pot) throw new Error(`payouts ${payouts} + fee != pot ${s.pot}`);
  if (s.phase === "VOIDED" && refunds !== s.pot) throw new Error(`refunds ${refunds} != pot ${s.pot}`);
  if (s.phase !== "COMPLETED" && payouts) throw new Error("payout before settlement");
}

export const cardsInPlay = (s: HandState) => Object.values(s.cards).flat().map(cardId);
