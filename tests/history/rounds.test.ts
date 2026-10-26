import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRounds } from "../../app/lib/history.ts";
import type { Txn } from "../../app/lib/data.ts";

// Ledger rows as the app gets them (newest first). `sub` is "<note> • <time>".
let n = 0;
const row = (amount: number, note: string, at: string): Txn => ({ id: String(++n), type: amount < 0 ? "bet" : "winning", title: "", sub: `${note} • ${at}`, amount, at: `2026-10-25T${at}:00+05:30` });

test("a win written in the same second as the next hand's boot stays with its own hand: one row per bet", () => {
  // Real order from the ledger (by id): boot #29, win #29 and boot #30 together, win... newest first:
  const txns = [
    row(-200, "Poker • Hand #30 • Boot", "18:20"),
    row(1140, "Poker • Hand #29 • Won", "18:20"),
    row(-200, "Poker • Hand #29 • Boot", "18:17"),
  ];
  const r = groupRounds(txns);
  assert.equal(r.length, 2, JSON.stringify(r));
  const h29 = r.find((x) => x.hand === "Hand #29")!;
  assert.deepEqual([h29.staked, h29.paid], [200, 1140]);
  assert.equal(r.find((x) => x.hand === "Hand #30")!.staked, 200);

  // Same two rows in the other order (equal timestamps): still one row for #29.
  const swapped = [txns[1], txns[0], txns[2]];
  const r2 = groupRounds(swapped);
  assert.equal(r2.length, 2, JSON.stringify(r2));
  assert.deepEqual([r2.find((x) => x.hand === "Hand #29")!.staked, r2.find((x) => x.hand === "Hand #29")!.paid], [200, 1140]);
});

test("a hand with several stakes (boot, raises) and a casino bet with its win are one row each", () => {
  const r = groupRounds([
    row(10000, "Dragon Tiger • Round #88227 • Win", "19:30"),
    row(-5000, "Dragon Tiger • Round #88227 • Bet", "19:30"),
    row(-33833, "Poker • Hand #6", "18:23"),
    row(-100000, "Poker • Hand #6", "18:22"),
    row(-1000, "Poker • Hand #6 • Boot", "18:22"),
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].game, r[0].staked, r[0].paid], ["Dragon Tiger", 5000, 10000]);
  assert.deepEqual([r[1].game, r[1].staked, r[1].paid], ["Poker", 134833, 0]);
});

test("rummy points: buy-in and its return make one row; the next buy-in starts a new one", () => {
  const r = groupRounds([
    row(-160, "Rummy • Points • Buy-in (max loss)", "20:27"),
    row(80, "Rummy • Points • Buy-in returned", "20:26"),
    row(-160, "Rummy • Points • Buy-in (max loss)", "20:13"),
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual([r[1].staked, r[1].paid], [160, 80]);
  assert.deepEqual([r[0].staked, r[0].paid], [160, 0]);
});
