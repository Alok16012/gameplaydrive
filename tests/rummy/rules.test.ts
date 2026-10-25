import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scoreGroups, type RCard } from "../../app/lib/rummyRules.ts";

const c = (r: string, s: string, id: number): RCard => ({ r: r as RCard["r"], s: s as RCard["s"], id });

test("13 cards: two identical cards are not a Double — they show as invalid and count as points", () => {
  const groups: RCard[][] = [
    [c("A", "♠", 1), c("2", "♠", 2), c("3", "♠", 3)],      // pure
    [c("4", "♠", 4), c("5", "♠", 5), c("6", "♠", 6)],      // pure
    [c("7", "♥", 7), c("7", "♦", 8), c("7", "♣", 9)],      // set
    [c("6", "♣", 10), c("6", "♣", 11)],                     // identical pair ("Double" in 21-card only)
    [c("9", "♥", 12), c("10", "♦", 13)],                    // loose
  ];
  assert.equal(classify(groups[3], "K"), "dublee");
  const sc = scoreGroups(groups, "K");
  assert.deepEqual(sc.kinds, ["pure", "pure", "set", "invalid", "invalid"]);
  assert.equal(sc.valid, false);
  assert.equal(sc.points, 6 + 6 + 9 + 10);
});

test("13 cards: three identical cards are not a 3 Naali either", () => {
  const groups: RCard[][] = [
    [c("A", "♠", 1), c("2", "♠", 2), c("3", "♠", 3)],
    [c("4", "♠", 4), c("5", "♠", 5), c("6", "♠", 6)],
    [c("7", "♥", 7), c("7", "♦", 8), c("7", "♣", 9)],
    [c("6", "♣", 10), c("6", "♣", 11), c("6", "♣", 12)],
    [c("9", "♥", 13)],
  ];
  const sc = scoreGroups(groups, "K");
  assert.equal(sc.kinds[3], "invalid");
  assert.equal(sc.valid, false);
});

test("21 cards: a Double shows as invalid and counts as points (no 8-Doubles rummy); a 3 Naali keeps its name", () => {
  const dubs: RCard[][] = Array.from({ length: 8 }, (_, i) => [c(String(2 + i), "♣", 100 + i * 2), c(String(2 + i), "♣", 101 + i * 2)]);
  const rest: RCard[][] = [[c("A", "♠", 1), c("2", "♠", 2), c("3", "♠", 3)], [c("K", "♥", 4), c("Q", "♦", 5)]];
  const sc = scoreGroups([...dubs, ...rest], "7");
  assert.equal(sc.kinds[0], "invalid");
  assert.equal(sc.valid, false);
  assert.ok(sc.points > 0);
  const tun: RCard[][] = [[c("5", "♦", 50), c("5", "♦", 51), c("5", "♦", 52)]];
  assert.equal(scoreGroups([...tun, ...dubs, ...rest], "7").kinds[0], "tunnela");
});
