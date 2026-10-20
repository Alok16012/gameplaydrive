import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand, checkInvariants, processDue, startHand, voidHand,
  type ActionType, type Command, type Ctx, type HandState, type Result, type Rng, type Rules, type Seat,
} from "../../app/lib/poker/engine.ts";
import { cardId, fullDeck, type Card } from "../../app/lib/poker/evaluator.ts";
import type { Rank, Suit } from "../../app/lib/teenpatti/evaluator.ts";
import { viewFor } from "../../app/lib/poker/view.ts";
import { advanceTable, command, fillBots, sitDown, standUp, type TableState } from "../../app/lib/poker/table.ts";

// ------------------------------------------------------------------ helpers

function seeded(seed = 1): Rng {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  let n = 0;
  return { int: (k) => next() % k, uuid: () => `req-${++n}` };
}
const R: Record<string, Rank> = { A: 14, K: 13, Q: 12, J: 11, T: 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2 };
const h = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ r: R[t.slice(0, -1)], s: t.slice(-1) as Suit }));

const RULES: Rules = { boot: 10, maxBet: 1000, turnTimeoutMs: 15000, rakePct: 5, maxRaises: 4 };

/** Deck that deals `hands[i]` to the i-th player in turn order, then `board`, then the rest. */
function deckFor(hands: string[], board: string): Card[] {
  const fixed = [...hands.flatMap(h), ...h(board)];
  const used = new Set(fixed.map(cardId));
  return [...fixed, ...fullDeck().filter((c) => !used.has(cardId(c)))];
}

interface Game { s: HandState; now: number; balances: Record<string, number>; rng: Rng; ids: string[] }

/** Seats p0..p(n-1) with the dealer at the last seat, so turn order is p0, p1, … `hands` in that order. */
function game(n: number, hands: string[] = [], board = "2S 7D 9C JH 4S", opts: { rules?: Partial<Rules>; balances?: Record<string, number>; bots?: string[] } = {}): Game {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const seats: Seat[] = ids.map((id, i) => ({ seat: i, playerId: id, name: id.toUpperCase(), bot: opts.bots?.includes(id) ?? false }));
  const balances = Object.fromEntries(ids.map((id) => [id, opts.balances?.[id] ?? 100000]));
  const botBalances = Object.fromEntries(ids.filter((id) => opts.bots?.includes(id)).map((id) => [id, opts.balances?.[id] ?? 100000]));
  const rng = seeded(42);
  const res = startHand({
    tableId: "t1", handId: "h1", handNo: 1, rules: { ...RULES, ...opts.rules }, seats, prevDealerSeat: n - 2,
    balances, botBalances, now: 1000, rng, deck: hands.length ? deckFor(hands, board) : undefined,
  })!;
  assert.ok(res, "hand should start");
  assert.deepEqual(res.state.order, ids);
  for (const e of res.ledger) if (!e.bot) balances[e.playerId] += e.amount;
  return { s: res.state, now: 1000, balances, rng, ids };
}

let actionSeq = 0;
function act(g: Game, playerId: string, type: ActionType, extra: Partial<Command> = {}): Result {
  const ctx: Ctx = { now: g.now, balances: g.balances, rng: g.rng };
  const cmd: Command = { actionId: `a${++actionSeq}`, playerId, handId: g.s.handId, expectedVersion: g.s.version, type, ...extra };
  const res = applyCommand(g.s, cmd, ctx);
  for (const e of res.ledger) if (!e.bot) g.balances[e.playerId] += e.amount;
  g.s = res.state;
  checkInvariants(g.s);
  return res;
}
const ok = (r: Result) => { assert.equal(r.ok, true, r.message); return r; };
const bad = (r: Result, code: string) => { assert.equal(r.ok, false); assert.equal(r.error, code); return r; };
function tick(g: Game, ms: number) {
  g.now += ms;
  const r = processDue(g.s, { now: g.now, balances: g.balances, rng: g.rng });
  for (const e of r.ledger) if (!e.bot) g.balances[e.playerId] += e.amount;
  g.s = r.state;
  checkInvariants(g.s);
}
/** Everyone checks through one betting round. */
function checkRound(g: Game) {
  const n = g.s.order.filter((id) => g.s.players[id].status === "ACTIVE").length;
  for (let i = 0; i < n; i++) ok(act(g, g.s.turnId!, "CHECK"));
}

// ------------------------------------------------------------------ dealing

test("start: everyone pays the boot, two cards each, the seat after the dealer opens", () => {
  const g = game(3);
  assert.equal(g.s.pot, 30);
  assert.equal(g.s.stage, 0);
  assert.equal(g.s.turnId, "p0");
  assert.equal(g.s.dealerSeat, 2);
  for (const id of g.ids) assert.equal(g.s.cards[id].length, 2);
  assert.equal(g.s.board.length, 5);
  assert.equal(new Set([...Object.values(g.s.cards).flat(), ...g.s.board].map(cardId)).size, 11);
  assert.equal(g.balances.p0, 99990);
});

test("start: players who can't pay the boot sit out; fewer than two → no hand", () => {
  const seats: Seat[] = [0, 1, 2].map((i) => ({ seat: i, playerId: `p${i}`, name: `P${i}`, bot: false }));
  const mk = (balances: Record<string, number>) => startHand({ tableId: "t", handId: "h", handNo: 1, rules: RULES, seats, prevDealerSeat: null, balances, botBalances: {}, now: 0, rng: seeded() });
  assert.equal(mk({ p0: 5, p1: 100, p2: 3 }), null);
  const r = mk({ p0: 5, p1: 100, p2: 50 })!;
  assert.deepEqual(r.state.order.sort(), ["p1", "p2"]);
});

test("a duplicated deck voids the hand before anyone pays", () => {
  const ids = ["p0", "p1"];
  const seats: Seat[] = ids.map((id, i) => ({ seat: i, playerId: id, name: id, bot: false }));
  const deck = [...h("AS AS KD QD"), ...h("2S 3S 4S 5S 6S")];
  const r = startHand({ tableId: "t", handId: "h", handNo: 1, rules: RULES, seats, prevDealerSeat: null, balances: { p0: 100, p1: 100 }, botBalances: {}, now: 0, rng: seeded(), deck })!;
  assert.equal(r.state.phase, "VOIDED");
  assert.equal(r.ledger.length, 0);
});

// ------------------------------------------------------------------ betting

test("check round → flop; call/raise flow; raise re-opens action for everyone else", () => {
  const g = game(3, ["AS AD", "KS KD", "2H 7C"], "3S 8D TC JH QD");
  checkRound(g);
  assert.equal(g.s.stage, 1);
  assert.equal(g.s.turnId, "p0");
  assert.equal(viewFor(g.s, "p0", 1000).board.length, 3);
  // p0 raises to 20, p1 re-raises to 40, p2 folds, p0 calls → turn
  ok(act(g, "p0", "RAISE", { to: 20 }));
  assert.equal(g.s.betLevel, 20);
  assert.equal(g.s.turnId, "p1");
  bad(act(g, "p1", "CHECK"), "CANNOT_CHECK");
  ok(act(g, "p1", "RAISE", { to: 40 }));
  assert.equal(g.s.turnId, "p2");
  ok(act(g, "p2", "FOLD"));
  assert.equal(g.s.turnId, "p0");
  const v = viewFor(g.s, "p0", g.balances.p0);
  assert.equal(v.me!.toCall, 20);
  assert.equal(v.me!.call.amount, 20);
  ok(act(g, "p0", "CALL"));
  assert.equal(g.s.stage, 2, "turn dealt once the bets are matched");
  assert.equal(g.s.pot, 30 + 40 + 40);
  assert.equal(g.s.turnId, "p0");
  assert.equal(g.s.players.p0.bet, 0);
});

test("raise limits: at least double the bet (or 2× boot), at most maxBet / what you hold, at most maxRaises per round", () => {
  const g = game(2, [], undefined, { balances: { p0: 100000, p1: 35 } });
  bad(act(g, "p0", "RAISE", { to: 15 }), "RAISE_RANGE");
  bad(act(g, "p0", "RAISE", { to: 1010 }), "RAISE_RANGE");
  ok(act(g, "p0", "RAISE", { to: 20 }));
  bad(act(g, "p1", "RAISE", { to: 30 }), "INSUFFICIENT_CHIPS");
  const v = viewFor(g.s, "p1", g.balances.p1);
  assert.equal(v.me!.raise.min, 40);
  assert.equal(v.me!.raise.ok, false, "p1 has 25 left after the boot, so can't reach the minimum raise");
  assert.equal(v.me!.raise.reason, "Not enough coins to raise");
  bad(act(g, "p1", "RAISE", { to: 40 }), "INSUFFICIENT_CHIPS");
  ok(act(g, "p1", "CALL"));
  assert.equal(g.s.stage, 1);
  // maxRaises (a fresh hand where both are rich)
  const g2 = game(2);
  ok(act(g2, "p0", "RAISE", { to: 20 }));
  ok(act(g2, "p1", "RAISE", { to: 40 }));
  ok(act(g2, "p0", "RAISE", { to: 80 }));
  ok(act(g2, "p1", "RAISE", { to: 160 }));
  bad(act(g2, "p0", "RAISE", { to: 320 }), "RAISE_LIMIT");
  assert.equal(viewFor(g2.s, "p0", 100000).me!.raise.reason, "No more raises this round");
  ok(act(g2, "p0", "CALL"));
  assert.equal(g2.s.stage, 1);
  assert.equal(g2.s.pot, 20 + 160 + 160);
});

test("a player who can't cover the call may only fold (no side pots); a timeout folds them", () => {
  const g = game(2, [], undefined, { balances: { p0: 100000, p1: 15 } });
  ok(act(g, "p0", "RAISE", { to: 20 }));
  bad(act(g, "p1", "CALL"), "INSUFFICIENT_CHIPS");
  const v = viewFor(g.s, "p1", g.balances.p1);
  assert.equal(v.me!.call.ok, false);
  assert.equal(v.me!.fold.ok, true);
  tick(g, 15000);
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.players.p1.foldReason, "TIMEOUT");
  assert.equal(g.s.settlement!.winners[0].playerId, "p0");
});

test("timeout with nothing to call checks instead of folding", () => {
  const g = game(3);
  tick(g, 15000);
  assert.equal(g.s.players.p0.status, "ACTIVE");
  assert.equal(g.s.turnId, "p1");
  assert.equal(g.s.events.at(-1)!.type, "TIMEOUT");
  tick(g, 15000); tick(g, 15000);
  assert.equal(g.s.stage, 1, "three timeouts = three checks → flop");
});

// ------------------------------------------------------------------ endings

test("everyone else folds → last one standing wins the pot minus the fee, no cards revealed", () => {
  const g = game(3);
  ok(act(g, "p0", "RAISE", { to: 20 }));
  ok(act(g, "p1", "FOLD"));
  ok(act(g, "p2", "FOLD"));
  assert.equal(g.s.phase, "COMPLETED");
  const st = g.s.settlement!;
  assert.equal(st.reason, "LAST_STANDING");
  assert.equal(g.s.pot, 50, "three boots + the 20 raise");
  assert.equal(st.rake, 2);
  assert.equal(st.winners[0].amount, 48);
  assert.deepEqual(st.reveal, []);
  assert.equal(g.balances.p0, 100000 - 10 - 20 + 48);
  const v = viewFor(g.s, "p1", 0);
  assert.equal(v.players.find((p) => p.playerId === "p0")!.cards, null);
});

test("showdown after the river: best five of seven wins, cards of everyone left are revealed", () => {
  const g = game(3, ["AS AD", "KS KD", "2H 7C"], "3S 8D TC JH QD");
  for (let i = 0; i < 4; i++) checkRound(g);
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.stage, 4);
  const st = g.s.settlement!;
  assert.equal(st.reason, "SHOWDOWN");
  assert.deepEqual(st.winners.map((w) => w.playerId), ["p0"]);
  assert.deepEqual([...st.reveal].sort(), ["p0", "p1", "p2"]);
  const v = viewFor(g.s, "p2", 0);
  assert.equal(v.board.length, 5);
  assert.equal(v.settlement!.reveal.find((r) => r.playerId === "p0")!.handName, "Pair");
});

test("ties split the pot; odd chips go clockwise after the dealer", () => {
  // Board is a straight everyone plays; p2's hole cards don't improve it.
  const g = game(3, ["2S 3D", "2D 3C", "4H 7C"], "5S 6D 7H 8C 9D", { rules: { rakePct: 0 } });
  ok(act(g, "p0", "RAISE", { to: 20 }));
  ok(act(g, "p1", "CALL"));
  ok(act(g, "p2", "FOLD"));
  for (let i = 0; i < 3; i++) checkRound(g);
  const st = g.s.settlement!;
  assert.equal(st.reason, "SHOWDOWN");
  assert.equal(g.s.pot, 70);
  assert.deepEqual(st.winners.sort((a, b) => a.playerId.localeCompare(b.playerId)), [{ playerId: "p0", amount: 35 }, { playerId: "p1", amount: 35 }]);
});

test("the fee comes off the pot before the payout", () => {
  const g = game(2, [], undefined, { rules: { rakePct: 10 } });
  ok(act(g, "p0", "RAISE", { to: 50 }));
  ok(act(g, "p1", "FOLD"));
  assert.equal(g.s.pot, 70);
  assert.equal(g.s.settlement!.rake, 7);
  assert.equal(g.s.settlement!.winners[0].amount, 63);
});

test("void refunds exactly what each player put in", () => {
  const g = game(3);
  ok(act(g, "p0", "RAISE", { to: 30 }));
  ok(act(g, "p1", "CALL"));
  const r = voidHand(g.s, g.now, "test");
  for (const e of r.ledger) if (!e.bot) g.balances[e.playerId] += e.amount;
  g.s = r.state;
  checkInvariants(g.s);
  assert.equal(g.balances.p0, 100000);
  assert.equal(g.balances.p1, 100000);
  assert.equal(g.balances.p2, 100000);
});

// ------------------------------------------------------------------ leaving, idempotency, versions

test("leaving folds you; off turn the hand carries on, on turn it moves on; last one standing wins", () => {
  const g = game(3);
  ok(act(g, "p1", "LEAVE"));
  assert.equal(g.s.players.p1.foldReason, "LEFT");
  assert.equal(g.s.turnId, "p0");
  ok(act(g, "p0", "CHECK"));
  assert.equal(g.s.turnId, "p2", "the leaver is skipped");
  ok(act(g, "p2", "LEAVE"));
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.winners[0].playerId, "p0");
});

test("replaying an action id is a no-op; a stale version is refused", () => {
  const g = game(2);
  const ctx: Ctx = { now: g.now, balances: g.balances, rng: g.rng };
  const cmd: Command = { actionId: "same", playerId: "p0", handId: "h1", expectedVersion: g.s.version, type: "RAISE", to: 20 };
  const a = applyCommand(g.s, cmd, ctx);
  assert.equal(a.ok, true);
  const b = applyCommand(a.state, cmd, ctx);
  assert.equal(b.ok, true);
  assert.equal(b.changed, false);
  assert.equal(b.ledger.length, 0);
  const c = applyCommand(a.state, { ...cmd, actionId: "other", type: "CALL" }, ctx);
  assert.equal(c.error, "STALE_VERSION");
  const d = applyCommand(a.state, { ...cmd, actionId: "same", type: "FOLD" }, ctx);
  assert.equal(d.error, "ACTION_ID_REUSED");
  assert.equal(applyCommand(a.state, { ...cmd, actionId: "x", expectedVersion: a.state.version, playerId: "p0", type: "CHECK" }, ctx).error, "NOT_YOUR_TURN");
});

// ------------------------------------------------------------------ views

test("a player sees their own cards, the board on show, never another live player's cards", () => {
  const g = game(3);
  const v = viewFor(g.s, "p1", 500);
  assert.equal(v.me!.cards!.length, 2);
  assert.equal(v.board.length, 0);
  for (const p of v.players) assert.equal(p.cards, null);
  assert.equal(v.me!.check.ok, false);
  assert.equal(viewFor(g.s, "p0", 500).me!.check.ok, true);
  assert.equal(viewFor(g.s, "stranger", 500).me!.inHand, false);
  checkRound(g);
  assert.equal(viewFor(g.s, "p1", 500).board.length, 3);
  assert.equal(JSON.stringify(v).includes('"board":[{'), false);
});

// ------------------------------------------------------------------ bots and random play: money always adds up

test("bots play whole hands by themselves and the money adds up", () => {
  let hands = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const ids = ["b0", "b1", "b2", "b3", "b4", "b5"].slice(0, 2 + (seed % 5));
    const seats: Seat[] = ids.map((id, i) => ({ seat: i, playerId: id, name: id, bot: true }));
    const botBalances = Object.fromEntries(ids.map((id) => [id, 500 + (seed % 7) * 100]));
    const rng = seeded(seed);
    const r = startHand({ tableId: "t", handId: `h${seed}`, handNo: seed, rules: RULES, seats, prevDealerSeat: seed % ids.length, balances: {}, botBalances, now: 0, rng })!;
    let s = r.state;
    const before = Object.values(botBalances).reduce((a, b) => a + b, 0);
    let now = 0;
    for (let i = 0; i < 400 && s.phase === "PLAYING"; i++) {
      now += 1000;
      s = processDue(s, { now, balances: {}, rng }).state;
      checkInvariants(s);
    }
    assert.equal(s.phase, "COMPLETED", `hand ${seed} should finish`);
    const after = Object.values(s.botBalances).reduce((a, b) => a + b, 0);
    assert.equal(after, before - s.settlement!.rake, "stacks + fee = what they started with");
    for (const id of ids) assert.ok(s.botBalances[id] >= 0, "no bot goes below zero");
    hands++;
  }
  assert.equal(hands, 150);
});

test("random human play never breaks an invariant and always ends", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = seeded(seed * 7);
    const n = 2 + (seed % 5);
    const g = game(n, [], undefined, { balances: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 50 + rng.int(400)])) });
    g.rng = rng;
    for (let i = 0; i < 300 && g.s.phase === "PLAYING"; i++) {
      const id = g.s.turnId!;
      const v = viewFor(g.s, id, g.balances[id]);
      const opts: (() => Result)[] = [];
      if (v.me!.fold.ok) opts.push(() => act(g, id, "FOLD"));
      if (v.me!.check.ok) opts.push(() => act(g, id, "CHECK"), () => act(g, id, "CHECK"));
      if (v.me!.call.ok) opts.push(() => act(g, id, "CALL"), () => act(g, id, "CALL"));
      if (v.me!.raise.ok) opts.push(() => act(g, id, "RAISE", { to: v.me!.raise.min + rng.int(Math.max(1, v.me!.raise.max - v.me!.raise.min + 1)) }));
      if (rng.int(10) === 0) { tick(g, 15000); continue; }
      ok(opts[rng.int(opts.length)]());
      assert.ok(Object.values(g.balances).every((b) => b >= 0));
    }
    assert.equal(g.s.phase, "COMPLETED", `game ${seed} should end`);
  }
});

// ------------------------------------------------------------------ table

const TRULES: Rules = { boot: 10, maxBet: 1000, turnTimeoutMs: 15000, rakePct: 5, maxRaises: 4 };
const fresh = (code: string | null = null): TableState => ({ id: "T", code, boot: 10, rules: TRULES, seats: [], dealerSeat: null, handNo: 0, hand: null, nextHandAt: null });
const human = (id: string) => ({ playerId: id, name: id.toUpperCase(), emoji: "🙂" });

test("table: public tables fill with bots; private tables wait for a second friend and never get bots", () => {
  const rng = seeded();
  let t = sitDown(fresh(), human("a"), 0).table;
  t = fillBots(t, rng, 0);
  assert.equal(t.seats.length, 6);
  assert.equal(t.seats.filter((s) => s.bot).length, 5);
  let p = sitDown(fresh("ABCDEF"), human("a"), 0).table;
  p = fillBots(p, rng, 0);
  assert.equal(p.seats.length, 1);
  const ctx: Ctx = { now: 1000, balances: { a: 500 }, rng };
  const adv = advanceTable(p, ctx);
  assert.equal(adv.table.hand, null);
  assert.ok(adv.table.nextHandAt! > 1000);
  p = sitDown(adv.table, human("b"), 2000).table;
  const adv2 = advanceTable(p, { now: 6000, balances: { a: 500, b: 500 }, rng });
  assert.ok(adv2.table.hand, "two friends → a hand starts");
  assert.equal(adv2.table.hand!.order.length, 2);
  assert.equal(adv2.ledger.length, 2);
  assert.equal(standUp(adv2.table, "a").seats.length, 1);
});

test("table: a hand runs to the end against bots, then the next one is dealt after the break", () => {
  const rng = seeded(9);
  let t = fillBots(sitDown(fresh(), human("a"), 0).table, rng, 0);
  const balances = { a: 1000 };
  let now = 1000;
  const step = (ms: number) => {
    now += ms;
    const r = advanceTable(t, { now, balances, rng });
    for (const e of r.ledger) if (!e.bot) balances[e.playerId as "a"] += e.amount;
    t = r.table;
    if (t.hand) checkInvariants(t.hand);
  };
  step(0);
  assert.equal(t.handNo, 1);
  assert.equal(t.hand!.phase, "PLAYING");
  // The human folds on their turn; bots play the rest out.
  const c = command(t, { actionId: "x1", playerId: "a", handId: t.hand!.handId, expectedVersion: t.hand!.version, type: "LEAVE" }, { now, balances, rng });
  t = c.table;
  for (let i = 0; i < 100 && t.hand!.phase === "PLAYING"; i++) step(1000);
  assert.equal(t.hand!.phase, "COMPLETED");
  const seatsBefore = t.seats.map((s) => s.bal);
  step(1000);
  assert.ok(t.nextHandAt);
  assert.notDeepEqual(t.seats.map((s) => s.bal), seatsBefore.map(() => undefined));
  step(9000);
  assert.equal(t.handNo, 2);
  assert.equal(t.hand!.phase, "PLAYING");
});
