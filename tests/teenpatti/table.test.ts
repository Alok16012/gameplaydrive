import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ctx, Rng, Rules } from "../../app/lib/teenpatti/engine.ts";
import { checkInvariants } from "../../app/lib/teenpatti/engine.ts";
import { AWAY_MS, NEXT_HAND_MS, advanceTable, command, fillBots, sitDown, standUp, waitingForPlayers, type TableState } from "../../app/lib/teenpatti/table.ts";

function seeded(seed = 1): Rng {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  let n = 0;
  return { int: (k) => next() % k, uuid: () => `u${++n}` };
}
const RULES: Rules = { boot: 10, maxBaseStake: 1280, potCap: 10240, turnTimeoutMs: 15000, sideshowTimeoutMs: 10000, maxTurnActions: null };
const fresh = (code: string | null = null): TableState => ({ id: "T", code, boot: 10, rules: RULES, seats: [], dealerSeat: null, handNo: 0, hand: null, nextHandAt: null });
const human = (id: string) => ({ playerId: id, name: id.toUpperCase(), emoji: "🙂" });

test("seating: humans take the lowest free seat; a full table bumps an idle bot; presence is refreshed", () => {
  const rng = seeded();
  let t = sitDown(fresh(), human("a"), 0).table;
  t = fillBots(t, rng, 0);
  assert.equal(t.seats.length, 6);
  assert.equal(t.seats.filter((s) => s.bot).length, 5);
  const r = sitDown(t, human("b"), 5);
  assert.equal(r.error, undefined);
  assert.equal(r.table.seats.filter((s) => !s.bot).length, 2);
  assert.equal(r.table.seats.length, 6);
  const again = sitDown(r.table, human("a"), 99).table;
  assert.equal(again.seats.find((s) => s.playerId === "a")!.lastSeen, 99);
  assert.equal(standUp(again, "a").seats.some((s) => s.playerId === "a"), false);
});

test("private tables never get bots and wait for a second player", () => {
  const rng = seeded();
  let t = sitDown(fresh("ABCDEF"), human("a"), 0).table;
  t = fillBots(t, rng, 0);
  assert.equal(t.seats.length, 1);
  const ctx: Ctx = { now: 1000, balances: { a: 500 }, rng };
  const adv = advanceTable(t, ctx);
  assert.equal(adv.table.hand, null);
  assert.ok(adv.table.nextHandAt! > 1000); // retry later
  assert.equal(waitingForPlayers(adv.table, ctx.balances, 1000), true);
  t = sitDown(adv.table, human("b"), 2000).table;
  const adv2 = advanceTable(t, { now: adv.table.nextHandAt!, balances: { a: 500, b: 500 }, rng });
  assert.equal(adv2.table.hand!.phase, "PLAYING");
  assert.equal(adv2.table.handNo, 1);
  assert.equal(adv2.ledger.length, 2);
  assert.ok(adv2.ledger.every((e) => e.handId === "T:1" && e.handNo === 1 && e.kind === "BOOT"));
});

test("a public table deals the first hand with bots, then the next one after the break; bots keep their stacks", () => {
  const rng = seeded(3);
  let t = fillBots(sitDown(fresh(), human("a"), 0).table, rng, 0);
  const bal = { a: 1000 };
  let adv = advanceTable(t, { now: 1000, balances: bal, rng });
  t = adv.table;
  assert.equal(t.hand!.phase, "PLAYING");
  assert.equal(Object.keys(t.hand!.players).length, 6);
  // The human never acts: they time out, and the bots play on among themselves.
  let now = 1000;
  for (let i = 0; i < 400 && (t.hand!.phase as string) !== "COMPLETED"; i++) {
    now += 1000;
    adv = advanceTable(t, { now, balances: bal, rng });
    t = adv.table;
    checkInvariants(t.hand!);
  }
  assert.equal(t.hand!.phase, "COMPLETED");
  const endAt = t.hand!.settlement!.at;
  assert.equal(t.nextHandAt, endAt + NEXT_HAND_MS);
  const stacks = Object.fromEntries(t.seats.filter((s) => s.bot).map((s) => [s.playerId, s.bal]));
  assert.deepEqual(stacks, t.hand!.botBalances); // stacks copied back to the seats
  // Still at the table: the next hand deals once the break is over.
  adv = advanceTable(t, { now: t.nextHandAt! - 1, balances: bal, rng });
  assert.equal(adv.table.handNo, 1);
  adv = advanceTable(t, { now: t.nextHandAt!, balances: bal, rng });
  assert.equal(adv.table.handNo, 2);
  assert.equal(adv.table.hand!.phase, "PLAYING");
  assert.notEqual(adv.table.hand!.dealerSeat, t.hand!.dealerSeat);
});

test("a human who stopped polling is dropped at the next hand; a mid-hand joiner waits", () => {
  const rng = seeded(5);
  let t = fillBots(sitDown(fresh(), human("a"), 0).table, rng, 0);
  t = advanceTable(t, { now: 1000, balances: { a: 1000 }, rng }).table;
  // b sits down during the hand: a bot gives up its seat (and still finishes the hand), b waits for the next deal
  t = sitDown(t, human("b"), 2000).table;
  assert.equal(t.hand!.players.b, undefined);
  assert.equal(t.seats.some((s) => s.playerId === "b"), true);
  assert.equal(t.seats.length, 6);
  assert.equal(Object.keys(t.hand!.players).length, 6);
  // the hand ends (everyone times out eventually), 'a' is away by then
  let now = 2000;
  for (let i = 0; i < 400 && (t.hand!.phase as string) !== "COMPLETED"; i++) { now += 1000; t = advanceTable(t, { now, balances: { a: 1000, b: 1000 }, rng }).table; }
  t = { ...t, seats: t.seats.map((s) => (s.playerId === "b" ? { ...s, lastSeen: now } : s)) };
  const next = advanceTable(t, { now: Math.max(t.nextHandAt!, 0 + AWAY_MS + 1), balances: { a: 1000, b: 1000 }, rng }).table;
  assert.equal(next.seats.some((s) => s.playerId === "a"), false);
  assert.ok(next.hand!.players.b);
});

test("commands go through the table and a settlement schedules the break", () => {
  const rng = seeded(7);
  let t = sitDown(sitDown(fresh("PRIV"), human("a"), 0).table, human("b"), 0).table;
  t = advanceTable(t, { now: 1000, balances: { a: 100, b: 100 }, rng }).table;
  const h = t.hand!;
  const first = h.turnId!;
  const c = command(t, { actionId: "c1", playerId: first, handId: h.handId, expectedVersion: h.version, type: "PACK" }, { now: 1500, balances: { a: 90, b: 90 }, rng });
  assert.equal(c.ok, true);
  assert.equal(c.table.hand!.phase, "COMPLETED");
  assert.equal(c.ledger.length, 1);
  assert.equal(c.ledger[0].kind, "PAYOUT");
  assert.equal(c.ledger[0].amount, 20);
  const adv = advanceTable(c.table, { now: 1600, balances: { a: 90, b: 110 }, rng });
  assert.equal(adv.table.nextHandAt, 1500 + NEXT_HAND_MS);
  const stale = command(adv.table, { actionId: "c2", playerId: first, handId: h.handId, expectedVersion: 1, type: "PACK" }, { now: 1700, balances: {}, rng });
  assert.equal(stale.ok, false);
});
