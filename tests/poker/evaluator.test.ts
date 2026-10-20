import { test } from "node:test";
import assert from "node:assert/strict";
import { compareKeys, evaluate, fullDeck, scoreFive, validateDeal, type Card } from "../../app/lib/poker/evaluator.ts";
import type { Rank, Suit } from "../../app/lib/teenpatti/evaluator.ts";

const R: Record<string, Rank> = { A: 14, K: 13, Q: 12, J: 11, T: 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2 };
const h = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ r: R[t.slice(0, -1)], s: t.slice(-1) as Suit }));
const beats = (a: string, b: string) => assert.equal(compareKeys(evaluate(h(a)).key, evaluate(h(b)).key), 1, `${a} should beat ${b}`);
const ties = (a: string, b: string) => assert.equal(compareKeys(evaluate(h(a)).key, evaluate(h(b)).key), 0, `${a} should tie ${b}`);

test("five-card categories", () => {
  assert.equal(evaluate(h("AS KS QS JS TS")).name, "Royal Flush");
  assert.equal(evaluate(h("9S 8S 7S 6S 5S")).name, "Straight Flush");
  assert.equal(evaluate(h("AS 2S 3S 4S 5S")).name, "Straight Flush");
  assert.equal(evaluate(h("9S 9H 9D 9C 2S")).name, "Four of a Kind");
  assert.equal(evaluate(h("9S 9H 9D 2C 2S")).name, "Full House");
  assert.equal(evaluate(h("AS 9S 7S 4S 2S")).name, "Flush");
  assert.equal(evaluate(h("AS 2H 3D 4C 5S")).name, "Straight");
  assert.equal(evaluate(h("TS JH QD KC AS")).name, "Straight");
  assert.equal(evaluate(h("9S 9H 9D 4C 2S")).name, "Three of a Kind");
  assert.equal(evaluate(h("9S 9H 4D 4C 2S")).name, "Two Pair");
  assert.equal(evaluate(h("9S 9H 5D 4C 2S")).name, "Pair");
  assert.equal(evaluate(h("KS 9H 5D 4C 2S")).name, "High Card");
});

test("ordering and kickers", () => {
  beats("AS KS QS JS TS", "9S 8S 7S 6S 5S");
  beats("2S 2H 2D 2C 3S", "AS AH AD KC KS");
  beats("3S 3H 3D 2C 2S", "AS KS 9S 4S 2S");
  beats("AS KS 9S 4S 2S", "TS JH QD KC AS");
  beats("TS JH QD KC AS", "AS 2H 3D 4C 5S"); // ace-high straight beats the wheel
  beats("AS 2H 3D 4C 5S", "AS AH AD 4C 2S");
  beats("AS AH 3D 3C 2S", "KS KH QD QC AS");
  beats("AS AH 9D 4C 2S", "KS KH QD JC AS");
  beats("AS AH 9D 4C 2S", "AD AC 8D 4H 2H"); // kicker
  beats("AS KH 9D 4C 2S", "AD KC 8D 4H 2H");
  ties("AS AH 9D 4C 2S", "AD AC 9H 4H 2H");
  assert.equal(compareKeys(scoreFive(h("KS QS 2S 3S 4S")), scoreFive(h("KH QH 2H 3H 4H"))), 0);
  assert.equal(compareKeys(scoreFive(h("6S 5H 4D 3C 2S")), scoreFive(h("AS 2H 3D 4C 5S"))), 1);
});

test("best five of seven", () => {
  const e = evaluate(h("AS KS 2D 3C QS JS TS"));
  assert.equal(e.name, "Royal Flush");
  assert.equal(evaluate(h("9S 9H 4D 4C 2S 9D KH")).name, "Full House");
  assert.equal(evaluate(h("2S 3H 4D 5C 6S 7D 8H")).key[1], 8);
  // Board plays: two players with the same best hand tie.
  const board = "AS KS QS JS 9H";
  ties(`2D 3C ${board}`, `4D 5C ${board}`);
  beats(`TD 3C ${board}`, `4D 5C ${board}`);
});

test("every 5-card combination of a full deck has a category and comparisons are antisymmetric", () => {
  const d = fullDeck();
  assert.equal(d.length, 52);
  const counts: Record<number, number> = {};
  const keys: number[][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) for (let x = c + 1; x < 52; x++) for (let y = x + 1; y < 52; y++) {
    const k = scoreFive([d[a], d[b], d[c], d[x], d[y]]);
    counts[k[0]] = (counts[k[0]] ?? 0) + 1;
    if (keys.length < 2000 && (a * 7 + y) % 1301 === 0) keys.push(k);
  }
  // Standard hold'em 5-card frequencies.
  assert.deepEqual(counts, { 0: 1302540, 1: 1098240, 2: 123552, 3: 54912, 4: 10200, 5: 5108, 6: 3744, 7: 624, 8: 36, 9: 4 });
  for (const a of keys) for (const b of keys) assert.equal(compareKeys(a, b), -compareKeys(b, a) || 0);
});

test("a deal with a duplicate card is refused", () => {
  assert.throws(() => validateDeal([h("AS KS"), h("AS QD")], h("2S 3S 4S 5S 6S")));
  assert.throws(() => validateDeal([h("AS KS")], h("2S 3S 4S 5S")));
  validateDeal([h("AS KS"), h("AD QD")], h("2S 3S 4S 5S 6S"));
});
