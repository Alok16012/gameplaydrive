import { test } from "node:test";
import assert from "node:assert/strict";
import { insufficient, legalMoves, makeMove, posKey, san, startPos, status, type Move, type Pos } from "../../app/lib/chess.ts";

/** A position from FEN (board, side, castling, en passant, halfmove clock). */
function fen(f: string): Pos {
  const [rows, turn, cas, ep, half] = f.split(" ");
  const board = rows.split("/").map((r) => r.replace(/\d/g, (d) => ".".repeat(Number(d))).split(""));
  const epSq: [number, number] | null = ep && ep !== "-" ? [8 - Number(ep[1]), "abcdefgh".indexOf(ep[0])] : null;
  return { board, turn: turn as "w" | "b", castle: { K: cas.includes("K"), Q: cas.includes("Q"), k: cas.includes("k"), q: cas.includes("q") }, ep: epSq, half: Number(half ?? 0) };
}
function perft(p: Pos, d: number): number {
  if (d === 0) return 1;
  let n = 0;
  for (const m of legalMoves(p)) n += perft(makeMove(p, m), d - 1);
  return n;
}
const find = (p: Pos, uci: string): Move => {
  const sq = (s: string): [number, number] => [8 - Number(s[1]), "abcdefgh".indexOf(s[0])];
  const [f, t, pr] = [sq(uci.slice(0, 2)), sq(uci.slice(2, 4)), uci[4]];
  const m = legalMoves(p).find((x) => x.from[0] === f[0] && x.from[1] === f[1] && x.to[0] === t[0] && x.to[1] === t[1] && (!pr || x.promo?.toLowerCase() === pr));
  assert.ok(m, `no legal move ${uci}`);
  return m!;
};

test("move generation matches the standard perft counts (start position and Kiwipete)", () => {
  const s = startPos();
  assert.equal(perft(s, 1), 20);
  assert.equal(perft(s, 2), 400);
  assert.equal(perft(s, 3), 8902);
  // Kiwipete: castling both ways, en passant, promotions, pins.
  const k = fen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0");
  assert.equal(perft(k, 1), 48);
  assert.equal(perft(k, 2), 2039);
  // Position 3 of the standard suite: en passant into discovered check, rook endgame.
  const p3 = fen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0");
  assert.equal(perft(p3, 3), 2812);
});

test("a pawn reaching the last row may become a queen, rook, bishop or knight", () => {
  const p = fen("8/P6k/8/8/8/8/8/K7 w - - 0");
  const promos = legalMoves(p).filter((m) => m.promo).map((m) => m.promo).sort();
  assert.deepEqual(promos, ["B", "N", "Q", "R"]);
  assert.equal(makeMove(p, find(p, "a7a8n")).board[0][0], "N");
});

test("notation: pawn moves, pieces, captures, castling, disambiguation, promotion, check and mate", () => {
  let p = startPos();
  assert.equal(san(p, find(p, "e2e4")), "e4");
  p = makeMove(p, find(p, "e2e4"));
  assert.equal(san(p, find(p, "d7d5")), "d5");
  p = makeMove(p, find(p, "d7d5"));
  assert.equal(san(p, find(p, "e4d5")), "exd5");
  assert.equal(san(p, find(p, "g1f3")), "Nf3");
  const c = fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0");
  assert.equal(san(c, find(c, "e1g1")), "O-O");
  assert.equal(san(c, find(c, "e1c1")), "O-O-O");
  // Two knights can reach d2: name the file.
  const d = fen("4k3/8/8/8/8/8/8/1N2KN2 w - - 0");
  assert.equal(san(d, find(d, "b1d2")), "Nbd2");
  // Two rooks on one file can reach a4: name the rank.
  const r = fen("4k3/8/R7/8/8/8/R7/4K3 w - - 0");
  assert.equal(san(r, find(r, "a6a4")), "R6a4");
  const pr = fen("8/P6k/8/8/8/8/8/K7 w - - 0");
  assert.equal(san(pr, find(pr, "a7a8q")), "a8=Q");
  // Back-rank mate.
  const m = fen("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0");
  assert.equal(san(m, find(m, "a1a8")), "Ra8#");
  const ch = fen("4k3/8/8/8/8/8/8/R3K3 w - - 0");
  assert.equal(san(ch, find(ch, "a1a8")), "Ra8+");
});

test("draws: insufficient material, the 50-move rule, and the same position three times", () => {
  assert.equal(insufficient(fen("8/8/4k3/8/8/3K4/8/8 w - - 0")), true);
  assert.equal(insufficient(fen("8/8/4k3/8/8/3KN3/8/8 w - - 0")), true);
  assert.equal(insufficient(fen("8/8/4kb2/8/8/3K4/4B3/8 w - - 0")), false, "bishops on opposite colours can still mate");
  assert.equal(insufficient(fen("8/8/4k3/5b2/8/3K4/4B3/8 w - - 0")), true, "bishops on the same colour cannot");
  assert.equal(insufficient(fen("8/8/4k3/8/8/3KR3/8/8 w - - 0")), false);
  assert.equal(status(fen("8/8/4k3/8/8/3KR3/8/8 w - - 99")), "play");
  // A quiet move on 99 reaches 100: drawn by the 50-move rule; a pawn move resets the count.
  const q = fen("8/8/4k3/8/8/3KR3/8/8 w - - 99");
  assert.equal(status(makeMove(q, find(q, "e3e2"))), "fifty");
  const pw = fen("8/8/4k3/8/8/3K4/4P3/8 w - - 99");
  assert.equal(makeMove(pw, find(pw, "e2e4")).half, 0);
  // Knights out and back twice: the start position comes round a third time.
  let p = startPos();
  const seen = new Map<string, number>([[posKey(p), 1]]);
  for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]) {
    p = makeMove(p, find(p, uci));
    seen.set(posKey(p), (seen.get(posKey(p)) ?? 0) + 1);
  }
  assert.equal(seen.get(posKey(startPos())), 3);
});
