import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ctx, Rng, Rules } from "../../app/lib/teenpatti/engine.ts";
import { checkInvariants } from "../../app/lib/teenpatti/engine.ts";
import { AWAY_MS, NEXT_HAND_MS, advanceTable, command, fillBots, sitDown, standUp, touch, waitingForPlayers, type TableState } from "../../app/lib/teenpatti/table.ts";
import { viewFor } from "../../app/lib/teenpatti/view.ts";

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

// ------------------------------------------------------------------ house bots

/** Plays `hands` hands of one human (who never packs: sees, then chaals; asks for the show whenever allowed) against
 *  five bots, and returns how each hand the human took part in ended. */
function playHands(modes: Record<string, string> | undefined, hands: number, seed: number) {
  const rng = seeded(seed);
  let t = fillBots(sitDown(fresh(), human("h"), 0).table, rng, 0);
  const bal: Record<string, number> = { h: 10_000_000 };
  const pay = (ledger: { playerId: string; bot: boolean; amount: number }[]) => { for (const e of ledger) if (!e.bot) bal[e.playerId] += e.amount; };
  const out: { won: boolean; reason: string; actions: number; pot: number }[] = [];
  let now = 1000, seen: string | null = null;
  for (let guard = 0; guard < 200_000 && t.handNo <= hands; guard++) {
    now += 1000;
    t = touch(t, "h", now);
    const ctx: Ctx = { now, balances: { ...bal }, rng, outcomeModes: modes };
    const adv = advanceTable(t, ctx);
    t = adv.table; pay(adv.ledger);
    let h = t.hand;
    if (h) checkInvariants(h);
    if (h && h.phase === "PLAYING" && h.turnId === "h" && h.players.h.status === "ACTIVE") {
      const v = viewFor(h, "h", bal.h);
      const type = v.me!.canSee.ok ? "SEE_CARDS" : v.me!.show.ok ? "SHOW" : "BET_MIN";
      const c = command(t, { actionId: `c${now}`, playerId: "h", handId: h.handId, expectedVersion: h.version, type }, ctx);
      assert.ok(c.ok, `${type}: ${c.message}`);
      t = c.table; pay(c.ledger);
      const after = advanceTable(t, ctx);
      t = after.table; pay(after.ledger);
      h = t.hand;
    }
    if (h && h.phase === "COMPLETED" && h.handId !== seen && h.players.h) {
      seen = h.handId;
      const st = h.settlement!;
      out.push({ won: st.winners.some((w) => w.playerId === "h"), reason: st.reason, actions: h.actionCount, pot: h.pot });
    }
  }
  assert.ok(out.length >= hands - 1, `only ${out.length} hands played`);
  return out;
}

test("house bots: a human who never packs can never win because every bot packed; hands end at a show, not the pot cap", () => {
  for (const [name, modes] of [["fair deal", undefined], ["force_loss", { h: "force_loss" }], ["force_win", { h: "force_win" }]] as const) {
    const res = playHands(modes, 20, 11);
    assert.equal(res.filter((r) => r.won && r.reason === "LAST_STANDING").length, 0, `${name}: the human won by everyone packing`);
    assert.ok(res.filter((r) => r.reason === "SHOW").length >= res.length * 0.9, `${name}: most hands should end with a show`);
    const avg = res.reduce((s, r) => s + r.actions, 0) / res.length;
    assert.ok(avg < 60, `${name}: hands drag on (${avg} actions on average)`);
    // Outcome control: every hand lost under force_loss, every hand won under force_win.
    if (name === "force_loss") assert.equal(res.filter((r) => r.won).length, 0, "force_loss: the human won a hand");
    if (name === "force_win") assert.equal(res.filter((r) => !r.won).length, 0, "force_win: the human lost a hand");
  }
});

test("bot stacks: every bot gets its own stack in lakhs, never crores, and the boot comes off it at once", () => {
  for (const boot of [50, 1000]) {
    const rng = seeded(9);
    let t: TableState = { ...fresh(), boot, rules: { ...RULES, boot, maxBaseStake: boot * 128, potCap: boot * 1024 } };
    t = fillBots(sitDown(t, human("a"), 0).table, rng, 0);
    const stacks = t.seats.filter((s) => s.bot).map((s) => s.bal!);
    assert.equal(new Set(stacks).size, stacks.length, "stacks should differ");
    for (const b of stacks) assert.ok(b >= 100_000 && b <= Math.max(boot * 2500, 2_500_000), `stack ${b} out of range at boot ${boot}`);
    const adv = advanceTable(t, { now: 1000, balances: { a: 10_000_000 }, rng });
    for (const s of adv.table.seats.filter((x) => x.bot)) assert.equal(adv.table.hand!.botBalances[s.playerId], s.bal! - boot);
  }
});
