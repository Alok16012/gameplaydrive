import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareHands, compareKeys, evaluate, fullDeck, InvalidHandError, nonSequenceRankTriples, sequenceStrength, validateRoster,
  type Card, type Category, type Rank, type Suit,
} from "../../app/lib/teenpatti/evaluator.ts";

const R: Record<string, Rank> = { A: 14, K: 13, Q: 12, J: 11, T: 10, "10": 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2 };
/** "AS KS QS" → cards; T or 10 for ten. */
const h = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ r: R[t.slice(0, -1)], s: t.slice(-1) as Suit }));
const beats = (a: string, b: string) => assert.equal(compareHands(h(a), h(b)), 1, `${a} should beat ${b}`);
const ties = (a: string, b: string) => assert.equal(compareHands(h(a), h(b)), 0, `${a} should tie ${b}`);

const ALL: Card[][] = (() => {
  const d = fullDeck();
  const out: Card[][] = [];
  for (let i = 0; i < 52; i++) for (let j = i + 1; j < 52; j++) for (let k = j + 1; k < 52; k++) out.push([d[i], d[j], d[k]]);
  return out;
})();
const EVALS = ALL.map((c) => evaluate(c));

test("all 22,100 combinations fall into the expected category counts", () => {
  assert.equal(ALL.length, 22100);
  const counts: Record<string, number> = {};
  for (const e of EVALS) counts[e.category] = (counts[e.category] ?? 0) + 1;
  assert.deepEqual(counts, { TRAIL: 52, PURE_SEQUENCE: 48, SEQUENCE: 720, COLOR: 1096, PAIR: 3744, HIGH_CARD: 16440 } satisfies Record<Category, number>);
});

test("every input order of every combination gives the same evaluation", () => {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  ALL.forEach((c, i) => {
    for (const p of perms) {
      const e = evaluate(p.map((x) => c[x]));
      assert.deepEqual(e.key, EVALS[i].key);
      assert.equal(e.category, EVALS[i].category);
    }
  });
});

test("comparison is antisymmetric and transitive (total preorder on the keys)", () => {
  // Sorting by the comparator and checking every adjacent pair plus random triples covers transitivity across all keys.
  const keys = [...new Map(EVALS.map((e) => [e.key.join(","), e.key])).values()];
  const sorted = [...keys].sort(compareKeys);
  for (let i = 1; i < sorted.length; i++) assert.equal(compareKeys(sorted[i - 1], sorted[i]), -1);
  for (const a of keys.slice(0, 400)) for (const b of keys) assert.equal(compareKeys(a, b), -compareKeys(b, a) || 0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 20000; n++) {
    const [a, b, c] = [0, 1, 2].map(() => EVALS[Math.floor(rnd() * EVALS.length)].key);
    if (compareKeys(a, b) >= 0 && compareKeys(b, c) >= 0) assert.ok(compareKeys(a, c) >= 0);
  }
});

test("a stronger category always beats every hand of a weaker one", () => {
  const byCat = new Map<number, { min: number[]; max: number[] }>();
  for (const e of EVALS) {
    const c = e.key[0];
    const cur = byCat.get(c);
    if (!cur) byCat.set(c, { min: e.key, max: e.key });
    else {
      if (compareKeys(e.key, cur.min) < 0) cur.min = e.key;
      if (compareKeys(e.key, cur.max) > 0) cur.max = e.key;
    }
  }
  for (let c = 2; c <= 6; c++) assert.equal(compareKeys(byCat.get(c)!.min, byCat.get(c - 1)!.max), 1);
});

test("the 12 sequence strengths are in the exact house order", () => {
  const order = [[14, 13, 12], [14, 3, 2], [13, 12, 11], [12, 11, 10], [11, 10, 9], [10, 9, 8], [9, 8, 7], [8, 7, 6], [7, 6, 5], [6, 5, 4], [5, 4, 3], [4, 3, 2]];
  order.forEach((v, i) => assert.equal(sequenceStrength(v), 12 - i, v.join("-")));
  assert.equal(sequenceStrength([14, 13, 2]), 0); // KA2
  assert.equal(sequenceStrength([14, 12, 2]), 0); // QA2
  assert.equal(sequenceStrength([14, 12, 11]), 0); // JQA
  // 12 sequences x 4 suits pure, x 60 mixed suits
  assert.equal(EVALS.filter((e) => e.category === "PURE_SEQUENCE").length, 48);
});

test("the 274 non-sequence distinct-rank triples are generated and ordered correctly", () => {
  const t = nonSequenceRankTriples();
  assert.equal(t.length, 274);
  assert.deepEqual(t[0], [14, 13, 11]); // AKJ strongest
  assert.deepEqual(t[t.length - 1], [5, 3, 2]); // 532 weakest
  for (let i = 1; i < t.length; i++) assert.equal(compareKeys(t[i - 1], t[i]), 1);
  assert.deepEqual(t.slice(0, 11).map((x) => x.join("-")), ["14-13-11", "14-13-10", "14-13-9", "14-13-8", "14-13-7", "14-13-6", "14-13-5", "14-13-4", "14-13-3", "14-13-2", "14-12-11"]);
  // Colors and high cards use exactly these rank keys, in this order.
  for (const cat of ["COLOR", "HIGH_CARD"] as const) {
    const ranks = [...new Set(EVALS.filter((e) => e.category === cat).map((e) => e.key.slice(1).join("-")))];
    assert.equal(ranks.length, 274);
  }
});

test("no suit ever breaks a tie", () => {
  const groups = new Map<string, number[]>();
  EVALS.forEach((e, i) => {
    const ranks = ALL[i].map((c) => c.r).sort((a, b) => b - a).join("-") + ":" + e.category;
    const k = groups.get(ranks);
    if (!k) groups.set(ranks, e.key);
    else assert.deepEqual(e.key, k);
  });
});

test("required examples", () => {
  beats("AS AH AD", "KS KH KD");
  beats("3S 3H 3D", "2S 2H 2D");
  beats("2S 2H 2D", "AH KH QH");
  beats("AH KH QH", "AS 2S 3S");
  beats("AS 2S 3S", "KD QD JD");
  beats("4S 3S 2S", "AH KS QD");
  beats("AH 2S 3D", "KS QH JD");
  assert.equal(evaluate(h("KS AH 2D")).category, "HIGH_CARD");
  assert.equal(evaluate(h("KS AS 2S")).category, "COLOR");
  beats("AS KS 2S", "AH QH JH");
  beats("AS AH 2D", "KS KH AD");
  beats("KS KH QD", "KD KC JS");
  beats("2S 2H 3D", "AS KH JD");
  ties("AH KH QH", "AS KS QS");
  ties("AH KS 9D", "AC KD 9S");
  ties("7H 7S 4D", "7C 7D 4H");
  // more from the rules
  beats("2S 3S 4S", "AH KS QD"); // pure 432 > mixed AKQ
  beats("4S 3H 2D", "AS KS JS"); // mixed 432 > color AKJ
  beats("5S 3S 2S", "AH AS KD"); // color 532 > pair AAK
  beats("AS KS 2S", "AH QH JH"); // color AK2 > AQJ
  beats("AS QS 2S", "AH JH TH"); // AQ2 > AJ10
  beats("AS JS 8S", "AH JH 7H"); // AJ8 > AJ7
  beats("AS AH 2D", "KS KH AD"); // AA2 > KKA
  beats("2S 2H AD", "2D 2C KS"); // 22A > 22K
  beats("3S 3H 2D", "2S 2H AD"); // 332 > 22A
  beats("AS KH 2D", "AD QH JS"); // high AK2 > AQJ
  beats("AS QH 9D", "AD JH TS"); // AQ9 > AJ10
  beats("KS QH 9D", "KD QS 8H"); // KQ9 > KQ8
  const pair = evaluate(h("AH AS KD"));
  assert.deepEqual(pair.key, [2, 14, 13]);
});

test("invalid hands and rosters are rejected", () => {
  assert.throws(() => evaluate(h("AS KS")), InvalidHandError);
  assert.throws(() => evaluate(h("AS KS QS JS")), InvalidHandError);
  assert.throws(() => evaluate(h("AS AS KS")), InvalidHandError);
  assert.throws(() => evaluate([{ r: 14, s: "X" as Suit }, { r: 13, s: "S" }, { r: 12, s: "S" }]), InvalidHandError);
  assert.throws(() => evaluate([{ r: 1 as Rank, s: "S" }, { r: 13, s: "S" }, { r: 12, s: "S" }]), InvalidHandError);
  assert.throws(() => evaluate([{ r: 15 as Rank, s: "S" }, { r: 13, s: "S" }, { r: 12, s: "S" }]), InvalidHandError);
  assert.throws(() => validateRoster([h("AS KS QS"), h("AS 2H 3D")]), InvalidHandError);
  validateRoster([h("AS KS QS"), h("AH 2H 3D")]);
});
