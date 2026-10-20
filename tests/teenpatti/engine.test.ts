import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand, checkInvariants, processDue, startHand, voidHand,
  type ActionType, type Command, type Ctx, type HandState, type Result, type Rng, type Rules, type Seat,
} from "../../app/lib/teenpatti/engine.ts";
import { fullDeck, cardId, type Card, type Rank, type Suit } from "../../app/lib/teenpatti/evaluator.ts";
import { viewFor } from "../../app/lib/teenpatti/view.ts";

// ------------------------------------------------------------------ helpers

function seeded(seed = 1): Rng {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  let n = 0;
  return { int: (k) => next() % k, uuid: () => `req-${++n}` };
}
const R: Record<string, Rank> = { A: 14, K: 13, Q: 12, J: 11, T: 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2 };
const h = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ r: R[t.slice(0, -1)], s: t.slice(-1) as Suit }));

// Most tests use minBlind 0 so they can see at once; the blind rules get their own tests below.
const RULES: Rules = { boot: 10, maxBaseStake: 1280, potCap: null, turnTimeoutMs: 30000, sideshowTimeoutMs: 10000, maxTurnActions: null, minBlind: 0, blindLimit: 99 };

/** Deck that deals `hands[i]` to the i-th player in turn order, then the rest of the deck. */
function deckFor(hands: string[]): Card[] {
  const fixed = hands.flatMap(h);
  const used = new Set(fixed.map(cardId));
  return [...fixed, ...fullDeck().filter((c) => !used.has(cardId(c)))];
}

interface Game { s: HandState; now: number; balances: Record<string, number>; rng: Rng; ids: string[]; n: number }

/**
 * Seats players p0..p(n-1) in seats 0..n-1 with the dealer at the last seat, so turn order is p0, p1, …
 * `hands` are given in that turn order.
 */
function game(n: number, hands: string[] = [], opts: { rules?: Partial<Rules>; balances?: Record<string, number>; bots?: string[] } = {}): Game {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const seats: Seat[] = ids.map((id, i) => ({ seat: i, playerId: id, name: id.toUpperCase(), bot: opts.bots?.includes(id) ?? false }));
  const balances = Object.fromEntries(ids.map((id) => [id, opts.balances?.[id] ?? 100000]));
  const botBalances = Object.fromEntries(ids.filter((id) => opts.bots?.includes(id)).map((id) => [id, opts.balances?.[id] ?? 100000]));
  const rng = seeded(42);
  const res = startHand({
    tableId: "t1", handId: "h1", handNo: 1, rules: { ...RULES, ...opts.rules }, seats, prevDealerSeat: n - 2,
    balances, botBalances, now: 1000, rng, deck: hands.length ? deckFor(hands) : undefined,
  })!;
  assert.ok(res, "hand should start");
  assert.deepEqual(res.state.order, ids, "turn order p0..pn");
  for (const e of res.ledger) if (!e.bot) balances[e.playerId] += e.amount;
  return { s: res.state, now: 1000, balances, rng, ids, n };
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
const ok = (r: Result) => { assert.ok(r.ok, `${r.error}: ${r.message}`); return r; };
const bad = (r: Result, code: string) => { assert.equal(r.ok, false); assert.equal(r.error, code); return r; };
const tick = (g: Game, ms: number) => {
  g.now += ms;
  const res = processDue(g.s, { now: g.now, balances: g.balances, rng: g.rng });
  for (const e of res.ledger) if (!e.bot) g.balances[e.playerId] += e.amount;
  g.s = res.state;
  checkInvariants(g.s);
  return res;
};
const payout = (g: Game, id: string) => g.s.settlement?.winners.find((w) => w.playerId === id)?.amount ?? 0;

// ------------------------------------------------------------------ setup

test("only players who can afford the boot participate; fewer than two → no hand", () => {
  const seats: Seat[] = [0, 1, 2].map((i) => ({ seat: i, playerId: `p${i}`, name: `P${i}`, bot: false }));
  const r = startHand({ tableId: "t", handId: "h", handNo: 1, rules: RULES, seats, prevDealerSeat: null, balances: { p0: 100, p1: 5, p2: 10 }, botBalances: {}, now: 0, rng: seeded() })!;
  assert.deepEqual(Object.keys(r.state.players).sort(), ["p0", "p2"]);
  assert.equal(r.state.pot, 20);
  assert.equal(r.ledger.length, 2);
  assert.equal(startHand({ tableId: "t", handId: "h", handNo: 1, rules: RULES, seats, prevDealerSeat: null, balances: { p0: 100, p1: 5, p2: 5 }, botBalances: {}, now: 0, rng: seeded() }), null);
});

test("dealer rotates to the next occupied seat; first turn is clockwise after the dealer; all start blind", () => {
  const seats: Seat[] = [0, 2, 4].map((i) => ({ seat: i, playerId: `p${i}`, name: `P${i}`, bot: false }));
  const bal = { p0: 100, p2: 100, p4: 100 };
  const a = startHand({ tableId: "t", handId: "h", handNo: 1, rules: RULES, seats, prevDealerSeat: 0, balances: bal, botBalances: {}, now: 0, rng: seeded() })!.state;
  assert.equal(a.dealerSeat, 2);
  assert.equal(a.turnId, "p4");
  assert.deepEqual(a.order, ["p4", "p0", "p2"]);
  const b = startHand({ tableId: "t", handId: "h", handNo: 2, rules: RULES, seats, prevDealerSeat: 4, balances: bal, botBalances: {}, now: 0, rng: seeded() })!.state;
  assert.equal(b.dealerSeat, 0);
  assert.equal(b.turnId, "p2");
  assert.ok(Object.values(a.players).every((p) => !p.seen && p.status === "ACTIVE"));
  const all = Object.values(a.cards).flat().map(cardId);
  assert.equal(new Set(all).size, 9);
});

test("a dealt roster with a duplicate card voids the hand before anyone pays", () => {
  const seats: Seat[] = [0, 1].map((i) => ({ seat: i, playerId: `p${i}`, name: `P${i}`, bot: false }));
  const deck = [...h("AS KS QS AS 2H 3D"), ...fullDeck()];
  const r = startHand({ tableId: "t", handId: "h", handNo: 1, rules: RULES, seats, prevDealerSeat: null, balances: { p0: 100, p1: 100 }, botBalances: {}, now: 0, rng: seeded(), deck })!;
  assert.equal(r.state.phase, "VOIDED");
  assert.equal(r.ledger.length, 0);
});

test("shuffle is a permutation and roughly uniform", async () => {
  const { shuffle } = await import("../../app/lib/teenpatti/engine.ts");
  const counts = Array(52).fill(0);
  const rng = seeded(9);
  for (let i = 0; i < 20000; i++) counts[shuffle(Array.from({ length: 52 }, (_, k) => k), rng)[0]]++;
  for (const c of counts) assert.ok(c > 280 && c < 500, `first-position count ${c}`);
});

// ------------------------------------------------------------------ betting

test("blind / seen betting transitions follow the base-stake rules", () => {
  const g = game(4);
  assert.equal(g.s.baseStake, 10);
  ok(act(g, "p0", "BET_MIN")); // A blind 10 → base 10
  assert.equal(g.s.baseStake, 10);
  ok(act(g, "p1", "SEE_CARDS"));
  ok(act(g, "p1", "BET_MIN")); // B seen 20 → base 10
  assert.equal(g.s.ledger.at(-1)!.amount, -20);
  assert.equal(g.s.baseStake, 10);
  ok(act(g, "p2", "BET_DOUBLE")); // C blind double 20 → base 20
  assert.equal(g.s.ledger.at(-1)!.amount, -20);
  assert.equal(g.s.baseStake, 20);
  const v = viewFor(g.s, "p3", g.balances.p3);
  assert.equal(v.me!.min.amount, 20); // next blind minimum 20
  assert.equal(v.me!.double.amount, 40);
  ok(act(g, "p3", "SEE_CARDS"));
  assert.equal(viewFor(g.s, "p3", g.balances.p3).me!.min.amount, 40); // next seen minimum 40
  ok(act(g, "p3", "BET_DOUBLE")); // seen double = 4 × 20 = 80 → base 40
  assert.equal(g.s.ledger.at(-1)!.amount, -80);
  assert.equal(g.s.baseStake, 40);
  ok(act(g, "p0", "PACK"));
  assert.equal(g.s.baseStake, 40); // PACK and SEE don't move the base
  assert.equal(g.s.pot, 40 + 10 + 20 + 20 + 80);
});

test("seeing cards does not end the turn or extend the deadline; repeat is a no-op", () => {
  const g = game(3);
  const deadline = g.s.turnDeadline;
  g.now += 5000;
  ok(act(g, "p0", "SEE_CARDS"));
  assert.equal(g.s.turnId, "p0");
  assert.equal(g.s.turnDeadline, deadline);
  const v = g.s.version;
  const r = ok(act(g, "p0", "SEE_CARDS"));
  assert.equal(r.changed, false);
  assert.equal(g.s.version, v);
  bad(act(g, "p1", "SEE_CARDS"), "NOT_YOUR_TURN"); // only on your own turn
});

test("max base stake: double above it is rejected, minimum still allowed at the max", () => {
  const g = game(2, [], { rules: { maxBaseStake: 20 } });
  ok(act(g, "p0", "BET_DOUBLE")); // base 20 = max
  bad(act(g, "p1", "BET_DOUBLE"), "MAX_STAKE");
  ok(act(g, "p1", "BET_MIN"));
  assert.equal(g.s.baseStake, 20);
});

test("turns skip packed players", () => {
  const g = game(4);
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "PACK"));
  ok(act(g, "p2", "BET_MIN"));
  ok(act(g, "p3", "BET_MIN"));
  assert.equal(g.s.turnId, "p0");
  ok(act(g, "p0", "BET_MIN"));
  assert.equal(g.s.turnId, "p2");
});

test("manual pack only on your turn; the last opponent packing settles at once with no reveal", () => {
  const g = game(2);
  bad(act(g, "p1", "PACK"), "NOT_YOUR_TURN");
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "PACK"));
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.reason, "LAST_STANDING");
  assert.deepEqual(g.s.settlement!.reveal, []);
  assert.equal(payout(g, "p0"), 30);
  const v = viewFor(g.s, "p0", 0);
  assert.equal(v.players.find((p) => p.playerId === "p1")!.cards, null);
});

// ------------------------------------------------------------------ insufficient chips

test("insufficient chips: rejected with no state change; exact balance is allowed; zero balance doesn't fold", () => {
  const g = game(2, ["AS AH AD", "2S 3H 5D"], { balances: { p0: 30, p1: 100000 } }); // p0 has 20 left after boot
  const before = structuredClone(g.s);
  g.balances.p0 = 19; // one short of the blind double (20)
  bad(act(g, "p0", "BET_DOUBLE"), "INSUFFICIENT_CHIPS");
  assert.deepEqual(g.s, before);
  g.balances.p0 = 20;
  ok(act(g, "p0", "BET_DOUBLE")); // exactly the remaining balance
  assert.equal(g.balances.p0, 0);
  ok(act(g, "p1", "PACK"));
  assert.equal(g.s.settlement!.winners[0].playerId, "p0"); // a zero balance doesn't stop you winning
});

// ------------------------------------------------------------------ show

test("show: only with exactly two active; seen-vs-blind refused; fees; stronger wins; tie → requester loses", () => {
  const three = game(3);
  bad(act(three, "p0", "SHOW"), "SHOW_NOT_ALLOWED");

  // blind requester vs blind opponent: fee = base
  let g = game(2, ["2S 3H 5D", "AS AH AD"]);
  ok(act(g, "p0", "SHOW"));
  assert.equal(g.s.ledger.at(-2)!.amount, -10);
  assert.equal(g.s.settlement!.winners[0].playerId, "p1");
  assert.deepEqual(g.s.settlement!.reveal.sort(), ["p0", "p1"]);

  // seen requester vs blind opponent: not allowed
  g = game(2);
  ok(act(g, "p0", "SEE_CARDS"));
  bad(act(g, "p0", "SHOW"), "SHOW_NOT_ALLOWED");

  // blind requester vs seen opponent: fee = base
  g = game(2, ["AS AH AD", "2S 3H 5D"]);
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "SEE_CARDS"));
  ok(act(g, "p1", "BET_MIN")); // seen 20
  ok(act(g, "p0", "SHOW"));
  assert.equal(g.s.ledger.find((e) => e.kind === "SHOW_FEE")!.amount, -10);
  assert.equal(g.s.settlement!.winners[0].playerId, "p0");

  // seen vs seen: fee = 2·base; tie → requester loses
  g = game(2, ["AS KH 9D", "AC KD 9S"]);
  ok(act(g, "p0", "SEE_CARDS"));
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "SEE_CARDS"));
  const base = g.s.baseStake;
  ok(act(g, "p1", "SHOW"));
  assert.equal(g.s.ledger.find((e) => e.kind === "SHOW_FEE")!.amount, -2 * base);
  assert.equal(g.s.settlement!.winners[0].playerId, "p0"); // equal hands: the requester (p1) loses
  assert.equal(payout(g, "p0"), g.s.pot);
  assert.equal(g.s.baseStake, base); // show fee doesn't move the base
});

test("show reveals only the two players left, never folded cards", () => {
  const g = game(3, ["AS AH AD", "2S 3H 5D", "KS KH 2D"]);
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "PACK"));
  ok(act(g, "p2", "SHOW"));
  const v = viewFor(g.s, "p1", 0);
  assert.deepEqual(v.settlement!.reveal.map((r) => r.playerId).sort(), ["p0", "p2"]);
  assert.equal(v.players.find((p) => p.playerId === "p1")!.cards, null);
  assert.equal(JSON.stringify(viewFor(g.s, "p0", 0)).includes('"r":3,"s":"H"'), false); // p1's 3♥ never sent
});

// ------------------------------------------------------------------ sideshow

function sideshowSetup(hands: string[]) {
  const g = game(4, hands);
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "SEE_CARDS"));
  ok(act(g, "p1", "BET_MIN")); // p1 is the last bettor, seen
  ok(act(g, "p2", "SEE_CARDS"));
  return g;
}

test("sideshow eligibility: seen, 3+ active, previous bettor active and seen and not you", () => {
  const g = game(4);
  ok(act(g, "p0", "SEE_CARDS"));
  bad(act(g, "p0", "SIDESHOW_REQUEST"), "SIDESHOW_NOT_ALLOWED"); // nobody has bet yet
  ok(act(g, "p0", "BET_MIN"));
  bad(act(g, "p1", "SIDESHOW_REQUEST"), "SIDESHOW_NOT_ALLOWED"); // requester blind
  ok(act(g, "p1", "SEE_CARDS"));
  ok(act(g, "p1", "SIDESHOW_REQUEST")); // p0, the last bettor, is seen and active → allowed
  assert.equal(g.s.pending!.targetId, "p0");
});

test("sideshow accept: weaker packs, turn goes on after the requester, fee in pot, base unchanged", () => {
  const g = sideshowSetup(["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"]);
  const base = g.s.baseStake;
  const pot = g.s.pot;
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  assert.equal(g.s.phase, "SIDESHOW_PENDING");
  assert.equal(g.s.pot, pot + 2 * base);
  assert.equal(g.s.baseStake, base);
  bad(act(g, "p3", "BET_MIN"), "SIDESHOW_PENDING"); // normal turns frozen
  bad(act(g, "p3", "SIDESHOW_ACCEPT", { requestId: g.s.pending!.requestId }), "NO_SIDESHOW"); // not the target
  bad(act(g, "p1", "SIDESHOW_ACCEPT", { requestId: "wrong" }), "NO_SIDESHOW");
  ok(act(g, "p1", "SIDESHOW_ACCEPT", { requestId: g.s.pending!.requestId }));
  assert.equal(g.s.players.p1.status, "PACKED"); // 2-3-5 loses to AAA
  assert.equal(g.s.turnId, "p3"); // next after the requester
  assert.equal(g.s.lastBettorId, "p1"); // a completed sideshow doesn't change the last bettor
  const v2 = viewFor(g.s, "p2", 0);
  assert.deepEqual(v2.mySideshows, [{ opponentId: "p1", youLost: false }]);
  assert.equal(v2.players.find((p) => p.playerId === "p1")!.cards, null); // outcome only, not the cards
  assert.deepEqual(viewFor(g.s, "p3", 0).mySideshows, []);
});

test("sideshow tie: the requester packs; reject: nobody packs and the fee stays; timeout: auto-reject", () => {
  let g = sideshowSetup(["9C 9H 2D", "AS KH 9D", "AC KD 9S", "KS QS JS"]);
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  ok(act(g, "p1", "SIDESHOW_ACCEPT", { requestId: g.s.pending!.requestId }));
  assert.equal(g.s.players.p2.status, "PACKED");
  assert.equal(g.s.players.p1.status, "ACTIVE");
  assert.equal(g.s.turnId, "p3");

  g = sideshowSetup(["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"]);
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  const pot = g.s.pot;
  ok(act(g, "p1", "SIDESHOW_REJECT", { requestId: g.s.pending!.requestId }));
  assert.equal(g.s.players.p1.status, "ACTIVE");
  assert.equal(g.s.players.p2.status, "ACTIVE");
  assert.equal(g.s.pot, pot);
  assert.equal(g.s.turnId, "p3");

  g = sideshowSetup(["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"]);
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  tick(g, 9999);
  assert.equal(g.s.phase, "SIDESHOW_PENDING");
  tick(g, 1);
  assert.equal(g.s.phase, "PLAYING");
  assert.equal(g.s.players.p1.status, "ACTIVE");
  assert.equal(g.s.turnId, "p3");
  assert.equal(g.s.events.some((e) => e.type === "SIDESHOW_TIMEOUT"), true);
});

test("sideshow target: the last bettor only, no searching backwards; packed last bettor → unavailable", () => {
  const g = game(4);
  ok(act(g, "p0", "SEE_CARDS"));
  ok(act(g, "p0", "BET_MIN")); // p0 last bettor, seen
  ok(act(g, "p1", "PACK")); // pack doesn't change last bettor
  ok(act(g, "p2", "SEE_CARDS"));
  const v = viewFor(g.s, "p2", 1e9);
  assert.equal(v.me!.sideshow.ok, true);
  assert.equal(v.me!.sideshow.targetId, "p0");
  ok(act(g, "p2", "BET_MIN")); // now p2 is last bettor
  ok(act(g, "p3", "SEE_CARDS"));
  assert.equal(viewFor(g.s, "p3", 1e9).me!.sideshow.targetId, "p2");
  ok(act(g, "p3", "BET_MIN"));
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p2", "PACK"));
  // only p0 and p3 are left now: side show needs three
  assert.equal(viewFor(g.s, "p3", 1e9).me!.sideshow.reason, "Side show needs three or more players");
});

test("leaving during a pending sideshow", () => {
  // requester leaves → cancelled, fee kept, turn after the requester
  let g = sideshowSetup(["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"]);
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  let pot = g.s.pot;
  ok(act(g, "p2", "LEAVE"));
  assert.equal(g.s.pending, null);
  assert.equal(g.s.pot, pot);
  assert.equal(g.s.turnId, "p3");

  // target leaves → cancelled
  g = sideshowSetup(["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"]);
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  ok(act(g, "p1", "LEAVE"));
  assert.equal(g.s.pending, null);
  assert.equal(g.s.players.p1.status, "PACKED");
  assert.equal(g.s.turnId, "p3");

  // another leaves and three still remain → still pending
  g = sideshowSetup(["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"]);
  ok(act(g, "p2", "SIDESHOW_REQUEST"));
  ok(act(g, "p3", "LEAVE"));
  assert.notEqual(g.s.pending, null);
  ok(act(g, "p0", "LEAVE")); // now only p1, p2 → fewer than three → cancelled without comparing
  assert.equal(g.s.pending, null);
  assert.equal(g.s.players.p1.status, "ACTIVE");
  assert.equal(g.s.players.p2.status, "ACTIVE");
  pot = g.s.pot;
  assert.equal(g.s.turnId, "p1"); // next after requester p2 (p3, p0 gone)
  checkInvariants(g.s);
  assert.equal(pot, g.s.pot);
});

test("leaving out of turn packs at once; leaving when two remain hands the pot to the other", () => {
  const g = game(3);
  ok(act(g, "p2", "LEAVE"));
  assert.equal(g.s.players.p2.status, "PACKED");
  assert.equal(g.s.turnId, "p0");
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p0" === g.s.turnId ? "p0" : "p1", "LEAVE"));
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.winners[0].playerId, "p0");
});

// ------------------------------------------------------------------ limits & forced showdown

test("pot cap reached by a bet forces a showdown among everyone left", () => {
  const g = game(3, ["AS AH AD", "KS KH KD", "2S 3H 5D"], { rules: { potCap: 70 } }); // start pot 30 (cap must beat 6 × boot)
  ok(act(g, "p0", "BET_MIN")); // 40
  ok(act(g, "p1", "BET_MIN")); // 50
  ok(act(g, "p2", "BET_MIN")); // 60
  ok(act(g, "p0", "BET_MIN")); // 70 → cap
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.reason, "FORCED_SHOWDOWN");
  assert.equal(g.s.settlement!.winners[0].playerId, "p0");
  assert.deepEqual(g.s.settlement!.reveal.sort(), ["p0", "p1", "p2"]);
  assert.equal(g.s.pot, 70); // never truncated
});

test("pot cap reached by a sideshow fee: no pending request, straight to showdown", () => {
  const g = game(4, ["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"], { rules: { potCap: 80 } }); // start 40
  ok(act(g, "p0", "BET_MIN")); // 50
  ok(act(g, "p1", "SEE_CARDS"));
  ok(act(g, "p1", "BET_MIN")); // 70
  ok(act(g, "p2", "SEE_CARDS"));
  ok(act(g, "p2", "SIDESHOW_REQUEST")); // +20 = 90 ≥ 80
  assert.equal(g.s.pending, null);
  assert.equal(g.s.settlement!.reason, "FORCED_SHOWDOWN");
  assert.equal(g.s.settlement!.winners[0].playerId, "p2");
});

test("pot cap reached by a show fee: paid-show rules still apply (tie → requester loses)", () => {
  const g = game(2, ["AS KH 9D", "AC KD 9S"], { rules: { potCap: 70 } }); // start 20
  ok(act(g, "p0", "BET_DOUBLE")); // 40, base 20
  ok(act(g, "p1", "BET_MIN")); // 60
  ok(act(g, "p0", "SHOW")); // blind fee 20 → 80 ≥ 70
  assert.equal(g.s.settlement!.reason, "SHOW");
  assert.equal(g.s.settlement!.winners[0].playerId, "p1");
});

test("forced showdown ties split the pot; odd chips go one at a time clockwise after the dealer", () => {
  // three identical-rank high cards in different suits → three-way tie
  const g = game(3, ["AS KH 9D", "AC KD 9S", "AH KS 9C"], { rules: { potCap: 61 } }); // start 30
  ok(act(g, "p0", "BET_MIN")); // 40
  ok(act(g, "p1", "BET_DOUBLE")); // +20 = 60
  ok(act(g, "p2", "SEE_CARDS"));
  // seen min = 2 × 20 = 40 → 100 ≥ 61
  ok(act(g, "p2", "BET_MIN"));
  assert.equal(g.s.pot, 100);
  assert.equal(g.s.settlement!.reason, "FORCED_SHOWDOWN");
  // 100 / 3 = 33 r1 → first in order after the dealer (p0) gets the extra chip
  assert.deepEqual(g.s.settlement!.winners.map((w) => [w.playerId, w.amount]).sort(), [["p0", 34], ["p1", 33], ["p2", 33]]);
});

test("max turn actions: forced showdown after the triggering action, or directly on a sideshow request", () => {
  let g = game(3, ["AS AH AD", "KS KH KD", "2S 3H 5D"], { rules: { maxTurnActions: 3 } });
  ok(act(g, "p0", "SEE_CARDS")); // doesn't count
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "BET_MIN"));
  ok(act(g, "p2", "PACK")); // 3rd counted action → showdown between p0 and p1
  assert.equal(g.s.settlement!.reason, "FORCED_SHOWDOWN");
  assert.deepEqual(g.s.settlement!.reveal.sort(), ["p0", "p1"]);

  g = game(4, ["9S 9H 2D", "2S 3H 5D", "AS AH AD", "KS QS JS"], { rules: { maxTurnActions: 3 } });
  ok(act(g, "p0", "BET_MIN"));
  ok(act(g, "p1", "SEE_CARDS"));
  ok(act(g, "p1", "BET_MIN"));
  ok(act(g, "p2", "SEE_CARDS"));
  ok(act(g, "p2", "SIDESHOW_REQUEST")); // 3rd → no pending, showdown
  assert.equal(g.s.pending, null);
  assert.equal(g.s.settlement!.reason, "FORCED_SHOWDOWN");
});

// ------------------------------------------------------------------ commands, timers, idempotency

test("duplicate, reused and stale commands", () => {
  const g = game(3);
  const ctx = (): Ctx => ({ now: g.now, balances: g.balances, rng: g.rng });
  const cmd: Command = { actionId: "x1", playerId: "p0", handId: "h1", expectedVersion: g.s.version, type: "BET_MIN" };
  const r1 = applyCommand(g.s, cmd, ctx());
  assert.ok(r1.ok);
  g.s = r1.state;
  const r2 = applyCommand(g.s, cmd, ctx()); // same id + payload: original result, no second debit
  assert.ok(r2.ok);
  assert.equal(r2.changed, false);
  assert.equal(r2.ledger.length, 0);
  assert.equal(r2.state, g.s);
  bad(applyCommand(g.s, { ...cmd, type: "PACK" }, ctx()), "ACTION_ID_REUSED");
  bad(applyCommand(g.s, { ...cmd, actionId: "x2", playerId: "p1", expectedVersion: g.s.version - 1 }, ctx()), "STALE_VERSION");
  bad(applyCommand(g.s, { ...cmd, actionId: "x3", playerId: "p1", handId: "old" }, ctx()), "STALE_HAND");
  bad(applyCommand(g.s, { ...cmd, actionId: "x4", expectedVersion: g.s.version }, ctx()), "NOT_YOUR_TURN"); // out of turn
});

test("a command at or after its deadline: the timeout is processed first and the command fails", () => {
  const g = game(3);
  g.now = g.s.turnDeadline!; // exactly at the deadline counts as expired
  const r = act(g, "p0", "BET_MIN");
  bad(r, "NOT_IN_HAND"); // p0 was auto-packed by the timeout first
  assert.equal(g.s.players.p0.status, "PACKED");
  assert.equal(g.s.players.p0.packReason, "TIMEOUT");
  assert.equal(g.s.turnId, "p1");
  assert.equal(g.s.turnDeadline, 1000 + 30000 + 30000); // next clock starts when the last one ran out
});

test("polling or reconnecting never moves a deadline", () => {
  const g = game(3);
  const d = g.s.turnDeadline;
  for (let i = 0; i < 10; i++) {
    const r = tick(g, 1000);
    assert.equal(r.changed, false);
    viewFor(g.s, "p0", 0);
  }
  assert.equal(g.s.turnDeadline, d);
});

test("timeouts cascade correctly after a long gap", () => {
  const g = game(3);
  tick(g, 31000 + 30000); // p0 at 31s, p1 at 61s
  assert.equal(g.s.phase, "COMPLETED");
  assert.equal(g.s.settlement!.winners[0].playerId, "p2");
});

test("void refunds each contribution exactly once", () => {
  const g = game(3);
  ok(act(g, "p0", "BET_DOUBLE"));
  const v = voidHand(g.s, g.now, "corrupt");
  assert.ok(v.ok);
  assert.deepEqual(v.ledger.map((e) => [e.playerId, e.amount]).sort(), [["p0", 30], ["p1", 10], ["p2", 10]]);
  g.s = v.state;
  checkInvariants(g.s);
  const again = voidHand(g.s, g.now, "corrupt");
  assert.equal(again.ok, false);
  assert.equal(again.ledger.length, 0);
});

test("private cards never appear in an unauthorized view", () => {
  const g = game(3, ["AS AH AD", "KS KH KD", "QS QH QD"]);
  const blob = (who: string | null) => JSON.stringify(viewFor(g.s, who, 0));
  assert.equal(blob("p0").includes('"cards":[{'), false); // blind: not even your own
  ok(act(g, "p0", "SEE_CARDS"));
  const mine = blob("p0");
  assert.ok(mine.includes('{"r":14,"s":"S"}'));
  assert.equal(mine.includes('"r":13'), false);
  assert.equal(blob("p1").includes('"r":14'), false);
  assert.equal(blob(null).includes('"cards":[{'), false);
  assert.equal(blob("spectator").includes('"cards":[{'), false);
});

test("bots play fair hands to the end and the books always balance (fuzz)", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const n = 2 + (seed % 5);
    const ids = Array.from({ length: n }, (_, i) => `b${i}`);
    const seats: Seat[] = ids.map((id, i) => ({ seat: i, playerId: id, name: id, bot: i > 0 }));
    const rng = seeded(seed);
    const botBalances = Object.fromEntries(ids.slice(1).map((id) => [id, 500 + (seed % 7) * 100]));
    const balances: Record<string, number> = { b0: 400 + (seed % 3) * 200 };
    const st = startHand({ tableId: "t", handId: `h${seed}`, handNo: seed, rules: { ...RULES, potCap: seed % 2 ? 2000 : null, maxTurnActions: seed % 3 ? null : 12 }, seats, prevDealerSeat: seed % n, balances, botBalances, now: 0, rng })!;
    const g: Game = { s: st.state, now: 0, balances, rng, ids, n };
    for (const e of st.ledger) if (!e.bot) g.balances[e.playerId] += e.amount;
    const startTotal = 400 + (seed % 3) * 200 + ids.slice(1).length * (500 + (seed % 7) * 100);
    for (let step = 0; step < 500 && g.s.phase !== "COMPLETED"; step++) {
      if (g.s.turnId === "b0" && g.s.phase === "PLAYING") {
        const choice = (["SEE_CARDS", "BET_MIN", "BET_DOUBLE", "PACK", "SHOW", "SIDESHOW_REQUEST"] as const)[rng.int(6)];
        act(g, "b0", choice);
      } else if (g.s.pending?.targetId === "b0") {
        act(g, "b0", rng.int(2) ? "SIDESHOW_ACCEPT" : "SIDESHOW_REJECT", { requestId: g.s.pending.requestId });
      } else tick(g, 1000 + rng.int(4000));
    }
    assert.equal(g.s.phase, "COMPLETED", `seed ${seed} did not finish`);
    const total = g.balances.b0 + ids.slice(1).reduce((t, id) => t + g.s.botBalances[id], 0);
    assert.equal(total, startTotal, `seed ${seed}: chips were created or lost`);
  }
});

// ------------------------------------------------------------------ blind rules

test("at least one blind chaal before seeing; after the limit you are seen automatically on your next turn", () => {
  const g = game(3, [], { rules: { minBlind: 1, blindLimit: 3 } });
  bad(act(g, "p0", "SEE_CARDS"), "BLIND_FIRST");
  assert.equal(viewFor(g.s, "p0", 1e9).me!.canSee.reason, "Play 1 blind chaal first");
  ok(act(g, "p0", "BET_MIN")); // blind 1
  ok(act(g, "p1", "BET_MIN"));
  ok(act(g, "p2", "BET_MIN"));
  assert.equal(g.s.players.p0.blinds, 1);
  assert.equal(viewFor(g.s, "p0", 1e9).me!.canSee.ok, true);
  ok(act(g, "p0", "BET_MIN")); // blind 2
  ok(act(g, "p1", "BET_MIN"));
  ok(act(g, "p2", "BET_MIN"));
  ok(act(g, "p0", "BET_DOUBLE")); // blind 3 (a double counts as one blind chaal)
  assert.equal(g.s.players.p0.blinds, 3);
  assert.equal(g.s.players.p0.seen, false); // still blind until the turn comes back
  ok(act(g, "p1", "BET_MIN"));
  ok(act(g, "p2", "BET_MIN"));
  assert.equal(g.s.turnId, "p0");
  assert.equal(g.s.players.p0.seen, true); // blind limit reached: seen as the turn arrives
  assert.ok(g.s.events.some((e) => e.type === "SEE" && e.playerId === "p0" && e.note === "Blind limit"));
  assert.equal(viewFor(g.s, "p0", 1e9).me!.min.amount, 2 * g.s.baseStake); // now bets seen
  // seen bets don't add to the blind count
  ok(act(g, "p0", "BET_MIN"));
  assert.equal(g.s.players.p0.blinds, 3);
});

test("the default rules are 1 blind minimum and 3 blind maximum", () => {
  const g = game(2, [], { rules: { minBlind: undefined, blindLimit: undefined } });
  assert.equal(viewFor(g.s, "p0", 1e9).minBlind, 1);
  assert.equal(viewFor(g.s, "p0", 1e9).blindLimit, 3);
  bad(act(g, "p0", "SEE_CARDS"), "BLIND_FIRST");
});
