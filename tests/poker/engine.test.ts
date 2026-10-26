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
  bad(act(g, "p1", "RAISE", { to: 30 }), "RAISE_RANGE");
  const v = viewFor(g.s, "p1", g.balances.p1);
  assert.equal(v.me!.raise.min, 25, "p1 has 25 left after the boot: short of the minimum raise (40), the only raise is all in");
  assert.equal(v.me!.raise.allIn, true);
  assert.equal(v.me!.raise.ok, true);
  assert.equal(v.me!.raise.reason, null, "all in is on offer");
  bad(act(g, "p1", "RAISE", { to: 40 }), "RAISE_RANGE");
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

test("short stack: calling a bigger bet puts you all in for what you have; a timeout still folds you", () => {
  const g = game(2, [], undefined, { balances: { p0: 100000, p1: 15 } });
  ok(act(g, "p0", "RAISE", { to: 20 }));
  const v = viewFor(g.s, "p1", g.balances.p1);
  assert.equal(v.me!.call.ok, true);
  assert.equal(v.me!.call.allIn, true);
  assert.equal(v.me!.call.amount, 5, "only the 5 coins left go in");
  assert.equal(v.me!.fold.ok, true);
  tick(g, 15000);
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.players.p1.foldReason, "TIMEOUT");
  assert.equal(g.s.settlement!.winners[0].playerId, "p0");
});

test("all in for less (A shoves 1 lakh, B has 5,000): B wins only what they matched, A gets the rest back", () => {
  // p0: A♠ A♥ beats p1: 2♣ 3♦ on a dry board; then the other way round.
  for (const [hands, winner] of [[["AS AH", "2C 3D"], "p0"], [["2C 3D", "AS AH"], "p1"]] as const) {
    const g = game(2, [...hands], "7D 9C JH 4S 8H", { rules: { maxBet: 200000 }, balances: { p0: 100000, p1: 5000 } });
    ok(act(g, "p0", "RAISE", { to: 99990 })); // every coin left after the 10 ante
    assert.equal(g.s.players.p0.allIn, true);
    const v = viewFor(g.s, "p1", g.balances.p1);
    assert.equal(v.me!.call.allIn, true);
    assert.equal(v.me!.call.amount, 4990);
    ok(act(g, "p1", "CALL"));
    assert.equal(g.s.players.p1.allIn, true);
    // Nobody left to bet: the board runs out and the hand is shown down.
    assert.equal(g.s.phase, "COMPLETED");
    assert.equal(g.s.settlement!.reason, "SHOWDOWN");
    const st = g.s.settlement!;
    const wonBy = (id: string) => st.winners.find((w) => w.playerId === id)?.amount ?? 0;
    const backTo = (id: string) => st.returned?.find((w) => w.playerId === id)?.amount ?? 0;
    // The matched pot is 5,000 + 5,000; 5% fee → 9,500 to the winner. A's unmatched 95,000 goes back to A, no fee.
    assert.equal(wonBy(winner), 9500);
    assert.equal(backTo("p0"), 95000);
    assert.equal(st.rake, 500);
    assert.equal(g.balances.p0, winner === "p0" ? 100000 - 5000 + 9500 : 95000);
    assert.equal(g.balances.p1, winner === "p1" ? 9500 : 0);
  }
});

test("three stacks, two side pots: each layer goes to the best hand among those who put that much in", () => {
  // p0 (500) has aces, p1 (2,000) kings, p2 (2,000) rags. p0 wins the main pot (500 × 3), p1 the side pot (1,500 × 2).
  const g = game(3, ["AS AH", "KS KH", "2C 3D"], "7D 9C JH 4S 8H", { rules: { maxBet: 200000 }, balances: { p0: 500, p1: 2000, p2: 2000 } });
  ok(act(g, "p0", "RAISE", { to: 490 }));
  ok(act(g, "p1", "RAISE", { to: 1990 }));
  ok(act(g, "p2", "CALL"));
  assert.equal(g.s.phase, "COMPLETED");
  const st = g.s.settlement!;
  const wonBy = (id: string) => st.winners.find((w) => w.playerId === id)?.amount ?? 0;
  assert.equal(wonBy("p0"), 1500 - 75);
  assert.equal(wonBy("p1"), 3000 - 150);
  assert.equal(wonBy("p2"), 0);
  assert.equal(st.rake, 225);
  assert.deepEqual(st.reveal.sort(), ["p0", "p1", "p2"]);
});

test("a short-stacked bot facing a shove goes all in for its stack; what it can't match goes back to the player", () => {
  // You: 1,00,000, bot: 20,000. You shove; the house bot holds the better hand and must call — all in for 19,990.
  const g = game(2, ["2C 3D", "AS AH"], "7D 9C JH 4S 8H", { rules: { maxBet: 200000 }, balances: { p0: 100000, p1: 20000 }, bots: ["p1"] });
  ok(act(g, "p0", "RAISE", { to: 99990 }));
  tick(g, 5000); // the bot acts
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.reason, "SHOWDOWN");
  assert.equal(g.s.players.p1.allIn, true);
  assert.equal(g.s.players.p1.contributed, 20000, "the bot put in every coin it had");
  const st = g.s.settlement!;
  assert.equal(st.returned?.find((w) => w.playerId === "p0")?.amount, 80000, "the 80,000 nobody matched comes back to you");
  assert.deepEqual(st.winners, [{ playerId: "p1", amount: 40000 - 2000 }], "the matched pot is 20,000 each, minus the 5% fee");
  assert.equal(g.balances.p0, 80000);
  assert.equal(g.s.botBalances.p1, 38000);

  // An all-in has to be matched even with the worse hand: the bot calls all in for its 19,990 and loses it.
  const g2 = game(2, ["AS AH", "2C 3D"], "7D 9C JH 4S 8H", { rules: { maxBet: 200000 }, balances: { p0: 100000, p1: 20000 }, bots: ["p1"] });
  ok(act(g2, "p0", "RAISE", { to: 99990 }));
  tick(g2, 5000);
  assert.equal(g2.s.settlement!.reason, "SHOWDOWN");
  assert.equal(g2.s.players.p1.allIn, true);
  assert.deepEqual(g2.s.settlement!.winners, [{ playerId: "p0", amount: 38000 }]);
  assert.equal(g2.balances.p0, 80000 + 38000);
  assert.equal(g2.s.botBalances.p1, 0);
});

test("an all-in must be matched: every bot puts in the all-in amount, or everything it has when that is less", () => {
  // You (110) shove 100 with rags; three bots with better hands match it; the bot with only 60 goes all in for 50.
  const g = game(4, ["2C 3D", "AS AH", "KS KH", "QS QH"], "7D 9C JH 4S 8H", { rules: { maxBet: 200000 }, balances: { p0: 110, p1: 100000, p2: 60, p3: 100000 }, bots: ["p1", "p2", "p3"] });
  ok(act(g, "p0", "RAISE", { to: 100 }));
  // The bots match it; p1 and p3 still have chips and check the later streets down between themselves.
  for (let i = 0; i < 20 && g.s.phase === "PLAYING"; i++) tick(g, 5000);
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.reason, "SHOWDOWN");
  assert.ok(g.s.players.p1.contributed >= 110 && g.s.players.p3.contributed >= 110, "both big stacks matched the 100 (and may have bet more between themselves later)");
  assert.equal(g.s.players.p1.status, "ACTIVE");
  assert.equal(g.s.players.p3.status, "ACTIVE");
  assert.equal(g.s.players.p2.contributed, 60, "p2 had 50 left after the boot: all of it goes in");
  assert.equal(g.s.players.p2.allIn, true);
  assert.equal(g.s.players.p0.contributed, 110);
  // Every layer goes to p1 (aces): the main pot all four reached, the side pot of the three, and anything p3 put in on top.
  assert.deepEqual(g.s.settlement!.winners.map((w) => w.playerId), ["p1"]);
  assert.equal(g.s.settlement!.returned?.length ?? 0, 0);
});

test("a short all-in raise does not reopen the betting for those who already acted; others still have to match it", () => {
  const g = game(3, [], undefined, { balances: { p0: 100000, p1: 100000, p2: 35 } });
  ok(act(g, "p0", "RAISE", { to: 20 }));
  ok(act(g, "p1", "CALL"));
  // p2 has 25 left: the minimum raise is to 40, but all in to 25 is allowed.
  bad(act(g, "p2", "RAISE", { to: 30 }), "RAISE_RANGE");
  const v = viewFor(g.s, "p2", g.balances.p2);
  assert.equal(v.me!.raise.allIn, true);
  assert.equal(v.me!.raise.min, 25);
  ok(act(g, "p2", "RAISE", { to: 25 }));
  assert.equal(g.s.betLevel, 25);
  assert.equal(g.s.raises, 1, "a short all-in is not a full raise");
  // p0 and p1 match the extra 5 (a call, not a chance to raise again — they had acted at 20).
  assert.equal(g.s.turnId, "p0");
  ok(act(g, "p0", "CALL"));
  ok(act(g, "p1", "CALL"));
  // p2 is all in and sits out the betting; the two big stacks bet the flop between themselves.
  assert.equal(g.s.stage, 1);
  assert.equal(g.s.turnId, "p0");
  assert.equal(g.s.players.p2.allIn, true);
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

// ------------------------------------------------------------------ house bots & outcome control

/** One human (never folds: checks, calls, and raises the minimum now and then) against five bots for `hands` hands. */
function playHands(modes: Record<string, string> | undefined, hands: number, seed: number) {
  const rng = seeded(seed);
  let t = fillBots(sitDown(fresh(), human("h"), 0).table, rng, 0);
  const bal: Record<string, number> = { h: 10_000_000 };
  const pay = (ledger: { playerId: string; bot: boolean; amount: number }[]) => { for (const e of ledger) if (!e.bot) bal[e.playerId] += e.amount; };
  const out: { won: boolean; reason: string; botFolds: number; minBot: number; pot: number }[] = [];
  let now = 1000, seen = "";
  for (let guard = 0; guard < 100_000 && t.handNo <= hands; guard++) {
    now += 1000;
    t = { ...t, seats: t.seats.map((s) => (s.playerId === "h" ? { ...s, lastSeen: now } : s)) };
    const ctx: Ctx = { now, balances: { ...bal }, rng, outcomeModes: modes };
    const adv = advanceTable(t, ctx);
    t = adv.table; pay(adv.ledger);
    let hd = t.hand;
    if (hd) checkInvariants(hd);
    if (hd && hd.phase === "PLAYING" && hd.turnId === "h") {
      const v = viewFor(hd, "h", bal.h);
      const type = v.me!.raise.ok && rng.int(4) === 0 ? "RAISE" : v.me!.check.ok ? "CHECK" : "CALL";
      const c = command(t, { actionId: `c${now}`, playerId: "h", handId: hd.handId, expectedVersion: hd.version, type, to: type === "RAISE" ? v.me!.raise.min : undefined }, ctx);
      assert.ok(c.ok, `${type}: ${c.message}`);
      t = c.table; pay(c.ledger);
      const after = advanceTable(t, ctx); t = after.table; pay(after.ledger);
      hd = t.hand;
    }
    if (hd && hd.phase === "COMPLETED" && hd.handId !== seen && hd.players.h) {
      seen = hd.handId;
      const bot = (id?: string) => !!id && hd!.players[id]?.bot;
      out.push({
        won: hd.settlement!.winners.some((w) => w.playerId === "h"), reason: hd.settlement!.reason, pot: hd.pot,
        botFolds: hd.events.filter((e) => (e.type === "FOLD" || e.type === "TIMEOUT") && bot(e.playerId)).length,
        minBot: Math.min(...Object.values(hd.botBalances)),
      });
    }
  }
  assert.ok(out.length >= hands - 1, `only ${out.length} hands played`);
  return out;
}

test("house bots: the human wins only small pots and loses at the showdown; force_loss always loses, force_win always wins", () => {
  for (const [name, modes] of [["fair deal", undefined], ["force_loss", { h: "force_loss" }], ["force_win", { h: "force_win" }]] as const) {
    const res = playHands(modes, 25, 3);
    // When the human holds the winning hand the bots fold early and the pot stays small; when a bot does, the hand
    // goes to the showdown.
    for (const r of res.filter((x) => x.won)) assert.ok(r.pot <= 10 * 20, `${name}: the human won a pot the bots built (${r.pot})`);
    const lost = res.filter((x) => !x.won);
    assert.ok(lost.every((r) => r.reason === "SHOWDOWN"), `${name}: a hand the human lost didn't go to the showdown`);
    assert.ok(res.reduce((s, r) => s + r.botFolds, 0) > 0, `${name}: no bot ever folded`);
    assert.ok(res.every((r) => r.minBot >= 0), `${name}: a bot's stack went below zero`);
    if (name === "force_loss") assert.equal(res.filter((r) => r.won).length, 0, "force_loss: the human won a hand");
    if (name === "force_win") assert.equal(res.filter((r) => !r.won).length, 0, "force_win: the human lost a hand");
  }
});

test("bot stacks: every bot gets its own stack of 30-40 boots, none alike, and the boot comes off it at once; a lakh-stack bot from before is replaced", () => {
  for (const boot of [50, 200, 1000]) {
    const rng = seeded(9);
    let t: TableState = { ...fresh(), boot, rules: { ...TRULES, boot, maxBet: boot * 100 } };
    t = fillBots(sitDown(t, human("a"), 0).table, rng, 0);
    const stacks = t.seats.filter((s) => s.bot).map((s) => s.bal!);
    assert.equal(new Set(stacks).size, stacks.length, `stacks should differ at boot ${boot}: ${stacks}`);
    for (const b of stacks) assert.ok(b >= boot * 30 && b <= boot * 40, `stack ${b} out of range at boot ${boot}`);
    const adv = advanceTable(t, { now: 1000, balances: { a: 10_000_000 }, rng });
    for (const s of adv.table.seats.filter((x) => x.bot)) assert.equal(adv.table.hand!.botBalances[s.playerId], s.bal! - boot);
    // A bot from before (16 lakh) leaves at the next hand and its replacement fits the table.
    const old = { ...t.seats.find((s) => s.bot)!, bal: 1_600_000 };
    const t2 = { ...t, seats: t.seats.map((s) => (s.playerId === old.playerId ? old : s)) };
    const adv2 = advanceTable(t2, { now: 1000, balances: { a: 10_000_000 }, rng });
    assert.ok(!adv2.table.seats.some((s) => s.playerId === old.playerId), "the lakh-stack bot should have left");
    assert.ok(adv2.table.seats.filter((s) => s.bot).every((s) => s.bal! <= boot * 40));
  }
});

test("bots come and go: a bot past its 2-5 minute stay leaves between hands, at most two per hand", () => {
  const rng = seeded(21);
  let t: TableState = { ...fresh(), boot: 200, rules: { ...TRULES, boot: 200, maxBet: 20_000 } };
  t = fillBots(sitDown(t, human("a"), 0).table, rng, 0);
  const before = t.seats.filter((s) => s.bot).map((s) => s.playerId);
  const later = 10 * 60_000;
  const adv = advanceTable({ ...t, seats: t.seats.map((s) => (s.bot ? s : { ...s, lastSeen: later })) }, { now: later, balances: { a: 10_000_000 }, rng });
  const after = adv.table.seats.filter((s) => s.bot).map((s) => s.playerId);
  assert.equal(after.length, 5);
  assert.equal(before.filter((id) => !after.includes(id)).length, 2, "exactly two bots left");
});

test("sitting down at a table left with lakh-size bot stacks: those bots are replaced before the first hand", () => {
  const rng = seeded(31);
  let t: TableState = { ...fresh(), boot: 25, rules: { ...TRULES, boot: 25, maxBet: 2500 } };
  t = fillBots(t, rng, 0);
  t = { ...t, seats: t.seats.map((s, i) => (i < 3 ? { ...s, bal: 1_900_000 } : s)) };
  const sat = fillBots(sitDown(t, human("a"), 0).table, rng, 0);
  const bots = sat.seats.filter((s) => s.bot);
  assert.equal(bots.length, 5);
  assert.ok(bots.every((s) => s.bal! >= 25 * 30 && s.bal! <= 25 * 40), `stacks ${bots.map((s) => s.bal)}`);
});
