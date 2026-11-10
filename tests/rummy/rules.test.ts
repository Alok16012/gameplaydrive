import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isValueCard, scoreGroups, valueBonus, type RCard } from "../../app/lib/rummyRules.ts";

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

test("21 cards (Octro): 8 Doubles or 8 jokers in one group is a rummy; 6+ Doubles count only the other cards; else 120", () => {
  const dubs: RCard[][] = Array.from({ length: 8 }, (_, i) => [c(String(2 + i), "♣", 100 + i * 2), c(String(2 + i), "♣", 101 + i * 2)]);
  const rest: RCard[][] = [[c("A", "♠", 1), c("2", "♠", 2), c("3", "♠", 3)], [c("K", "♥", 4), c("Q", "♦", 5)]];
  const eight = scoreGroups([...dubs, ...rest], "7:♥");
  assert.equal(eight.kinds[0], "dublee");
  assert.equal(eight.valid, true);
  const six = scoreGroups([...dubs.slice(0, 6), ...rest, [c("2", "♦", 6), c("3", "♦", 7), c("Q", "♣", 8), c("J", "♦", 9)]], "7:♥");
  assert.equal(six.valid, false);
  assert.equal(six.points, (10 + 2 + 3) + (10 + 10) + (2 + 3 + 10 + 10)); // every card outside the Doubles (one pure run is not three)
  const jokers: RCard[] = [c("7", "♥", 10), c("7", "♦", 11), c("7", "♣", 12), c("7", "♠", 13), c("6", "♥", 14), c("8", "♥", 15), c("JK" as string, "JK", 16), c("JK" as string, "JK", 17)];
  const restJ: RCard[] = Array.from({ length: 13 }, (_, i) => c(["A", "3", "9", "J", "K", "2", "4", "10", "Q", "3", "9", "J", "K"][i], i % 2 ? "♦" : "♣", 30 + i));
  assert.equal(scoreGroups([jokers, restJ], "7:♥").valid, true);
  const none = scoreGroups([[c("A", "♠", 1), c("2", "♠", 2), c("3", "♠", 3)], restJ, [c("4", "♦", 40), c("6", "♣", 41), c("8", "♦", 42), c("10", "♣", 43), c("Q", "♦", 44)]], "7:♥");
  assert.equal(none.points, 120);
  const tun: RCard[][] = [[c("5", "♦", 50), c("5", "♦", 51), c("5", "♦", 52)]];
  assert.equal(scoreGroups([...tun, ...dubs, ...rest], "7:♥").kinds[0], "tunnela");
});

test("21 cards: value cards and marriages against the cut joker", () => {
  const cut = { r: "5", s: "♠" } as RCard;
  assert.deepEqual(valueBonus([c("5", "♠", 1), c("6", "♠", 2), c("4", "♠", 3)], cut), { vc: 3, marriages: 1, bonus: 100 });
  assert.deepEqual(valueBonus([c("5", "♠", 1), c("6", "♠", 2)], cut), { vc: 2, marriages: 0, bonus: 30 });
  assert.equal(valueBonus([c("A", "♠", 1), c("K", "♠", 2), c("2", "♠", 3)], { r: "A", s: "♠" } as RCard).marriages, 1);
  assert.equal(isValueCard(c("6", "♠", 1), cut), true);
  assert.equal(isValueCard(c("6", "♥", 1), cut), false);
});
