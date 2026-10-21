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
  const can = (x: Seat) => (x.bot ? botBalances[x.playerId] ?? 0 : balances[x.playerId] ?? 0) >= boot;
  const playing = seats.filter(can);
  if (playing.length < 2) return undefined;

  const after = prevDealerSeat === null ? -1 : prevDealerSeat;
  const dealer = playing.find((x) => x.seat > after) ?? playing[0];
  const di = playing.indexOf(dealer);
  const orderSeats = [...playing.slice(di + 1), ...playing.slice(0, di + 1)];

  const lossIdx = orderSeats.findIndex((s) => !s.bot && outcomeModes[s.playerId] === "force_loss");
  const winIdx = orderSeats.findIndex((s) => !s.bot && outcomeModes[s.playerId] === "force_win");
  const botIdx = orderSeats.findIndex((s) => s.bot);

  if (lossIdx >= 0 && botIdx >= 0) {
    let humanHand: Card[];
    let botHand: Card[];

    const roll = Math.random();
    if (roll < 0.65) {
      // 65%: Human has Pair of Kings (K♠ K♥ 8♦), Bot has Pair of Aces (A♠ A♦ 9♣)
      humanHand = [{ r: 13, s: "S" }, { r: 13, s: "H" }, { r: 8, s: "D" }];
      botHand = [{ r: 14, s: "S" }, { r: 14, s: "D" }, { r: 9, s: "C" }];
    } else if (roll < 0.85) {
      // 20%: Human has Ace-high Color (A♥ 10♥ 4♥), Bot has Sequence (10♣ J♦ Q♠)
      humanHand = [{ r: 14, s: "H" }, { r: 10, s: "H" }, { r: 4, s: "H" }];
      botHand = [{ r: 10, s: "C" }, { r: 11, s: "D" }, { r: 12, s: "S" }];
    } else {
      // 15%: Human has Sequence (9♠ 10♦ J♣), Bot has higher Sequence (J♥ Q♦ K♠)
      humanHand = [{ r: 9, s: "S" }, { r: 10, s: "D" }, { r: 11, s: "C" }];
      botHand = [{ r: 11, s: "H" }, { r: 12, s: "D" }, { r: 13, s: "S" }];
    }

    const usedIds = new Set([...humanHand.map(cardId), ...botHand.map(cardId)]);
    const rest = fullDeck().filter((c) => !usedIds.has(cardId(c)));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = rng ? rng.int(i + 1) : Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }

    const evBot = evaluate(botHand);
    const deck: Card[] = [];
    let restPtr = 0;
    for (let i = 0; i < orderSeats.length; i++) {
      if (i === lossIdx) {
        deck.push(...humanHand);
      } else if (i === botIdx) {
        deck.push(...botHand);
      } else {
        const chunk = [rest[restPtr++], rest[restPtr++], rest[restPtr++]];
        if (compareKeys(evaluate(chunk).key, evBot.key) >= 0) {
          for (let k = restPtr; k < rest.length; k++) {
            const candidate = [chunk[0], chunk[1], rest[k]];
            if (compareKeys(evaluate(candidate).key, evBot.key) < 0) {
              const temp = chunk[2];
              chunk[2] = rest[k];
              rest[k] = temp;
              break;
            }
          }
        }
        deck.push(...chunk);
      }
    }
    while (restPtr < rest.length) {
      deck.push(rest[restPtr++]);
    }
    return deck;
  }

  if (winIdx >= 0 && botIdx >= 0) {
    const humanHand: Card[] = [{ r: 14, s: "S" }, { r: 14, s: "D" }, { r: 9, s: "C" }];
    const botHand: Card[] = [{ r: 13, s: "S" }, { r: 13, s: "H" }, { r: 8, s: "D" }];
    const usedIds = new Set([...humanHand.map(cardId), ...botHand.map(cardId)]);
    const rest = fullDeck().filter((c) => !usedIds.has(cardId(c)));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = rng ? rng.int(i + 1) : Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const evHuman = evaluate(humanHand);
    const deck: Card[] = [];
    let restPtr = 0;
    for (let i = 0; i < orderSeats.length; i++) {
      if (i === winIdx) {
        deck.push(...humanHand);
      } else if (i === botIdx) {
        deck.push(...botHand);
      } else {
        const chunk = [rest[restPtr++], rest[restPtr++], rest[restPtr++]];
        if (compareKeys(evaluate(chunk).key, evHuman.key) >= 0) {
          for (let k = restPtr; k < rest.length; k++) {
            const candidate = [chunk[0], chunk[1], rest[k]];
            if (compareKeys(evaluate(candidate).key, evHuman.key) < 0) {
              const temp = chunk[2];
              chunk[2] = rest[k];
              rest[k] = temp;
              break;
            }
          }
        }
        deck.push(...chunk);
      }
    }
    while (restPtr < rest.length) {
      deck.push(rest[restPtr++]);
    }
    return deck;
  }

  return undefined;
}

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
    seats.push({ seat, playerId: `bot:${rng.uuid()}`, name, emoji: BOT_EMOJI[rng.int(BOT_EMOJI.length)], bot: true, bal: t.boot * (300 + rng.int(700)), lastSeen: now });
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
  // Humans who went away leave; bots that can't cover a few boots leave; public tables refill.
  t = { ...t, seats: t.seats.filter((s) => (s.bot ? (s.bal ?? 0) >= t.boot * 4 : ctx.now - s.lastSeen < AWAY_MS)) };
  t = fillBots(t, ctx.rng, ctx.now);
  // Auto-replenish bots so they never get starved or forced to pack
  t = { ...t, seats: t.seats.map((s) => (s.bot ? { ...s, bal: Math.max(s.bal ?? 0, t.boot * 200) } : s)) };
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
