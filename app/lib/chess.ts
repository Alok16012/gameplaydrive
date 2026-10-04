// Small chess engine for the Chess table: full legal move generation (check, castling, en passant, promotion),
// game-end detection, and a computer opponent (alpha-beta search over material + piece-square tables).
// Board: 8×8, row 0 = black's back rank. Uppercase = white, lowercase = black, "." = empty.

export type Board = string[][];
export type Side = "w" | "b";
export interface Move { from: [number, number]; to: [number, number]; piece: string; captured: string; promo?: string; castle?: "K" | "Q"; ep?: boolean }
export interface Pos {
  board: Board;
  turn: Side;
  castle: { K: boolean; Q: boolean; k: boolean; q: boolean };
  ep: [number, number] | null; // square a pawn can capture onto en passant
}

export const START: Board = ["rnbqkbnr", "pppppppp", "........", "........", "........", "........", "PPPPPPPP", "RNBQKBNR"].map((r) => r.split(""));
export const startPos = (): Pos => ({ board: START.map((r) => [...r]), turn: "w", castle: { K: true, Q: true, k: true, q: true }, ep: null });

const isW = (p: string) => p !== "." && p === p.toUpperCase();
const sideOf = (p: string): Side | null => (p === "." ? null : isW(p) ? "w" : "b");
const inB = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;
const KN = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
const KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Is square (r, c) attacked by side `by`? */
export function attacked(b: Board, r: number, c: number, by: Side): boolean {
  const own = (p: string) => sideOf(p) === by;
  const pr = by === "w" ? r + 1 : r - 1; // attacking pawns sit one row "behind" the square
  for (const dc of [-1, 1]) if (inB(pr, c + dc) && b[pr][c + dc].toLowerCase() === "p" && own(b[pr][c + dc])) return true;
  for (const [dr, dc] of KN) if (inB(r + dr, c + dc) && b[r + dr][c + dc].toLowerCase() === "n" && own(b[r + dr][c + dc])) return true;
  for (const [dr, dc] of KG) if (inB(r + dr, c + dc) && b[r + dr][c + dc].toLowerCase() === "k" && own(b[r + dr][c + dc])) return true;
  const ray = (dirs: number[][], kinds: string) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inB(rr, cc)) {
        const p = b[rr][cc];
        if (p !== ".") { if (own(p) && kinds.includes(p.toLowerCase())) return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  };
  return ray(DIAG, "bq") || ray(ORTH, "rq");
}

export function kingSquare(b: Board, s: Side): [number, number] {
  const k = s === "w" ? "K" : "k";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (b[r][c] === k) return [r, c];
  return [-1, -1];
}
export const inCheck = (p: Pos, s: Side = p.turn) => { const [r, c] = kingSquare(p.board, s); return r >= 0 && attacked(p.board, r, c, s === "w" ? "b" : "w"); };

function pseudo(p: Pos): Move[] {
  const { board: b, turn } = p;
  const out: Move[] = [];
  const add = (fr: number, fc: number, tr: number, tc: number, extra: Partial<Move> = {}) =>
    out.push({ from: [fr, fc], to: [tr, tc], piece: b[fr][fc], captured: b[tr][tc], ...extra });
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const pc = b[r][c];
    if (sideOf(pc) !== turn) continue;
    const t = pc.toLowerCase();
    const enemy = (rr: number, cc: number) => { const s = sideOf(b[rr][cc]); return s !== null && s !== turn; };
    if (t === "p") {
      const dir = turn === "w" ? -1 : 1, startRow = turn === "w" ? 6 : 1, lastRow = turn === "w" ? 0 : 7;
      const promo = (tr: number) => (tr === lastRow ? { promo: turn === "w" ? "Q" : "q" } : {});
      if (inB(r + dir, c) && b[r + dir][c] === ".") {
        add(r, c, r + dir, c, promo(r + dir));
        if (r === startRow && b[r + 2 * dir][c] === ".") add(r, c, r + 2 * dir, c);
      }
      for (const dc of [-1, 1]) {
        const tr = r + dir, tc = c + dc;
        if (!inB(tr, tc)) continue;
        if (enemy(tr, tc)) add(r, c, tr, tc, promo(tr));
        else if (p.ep && p.ep[0] === tr && p.ep[1] === tc) out.push({ from: [r, c], to: [tr, tc], piece: pc, captured: b[r][tc], ep: true });
      }
    } else if (t === "n" || t === "k") {
      for (const [dr, dc] of t === "n" ? KN : KG) {
        const tr = r + dr, tc = c + dc;
        if (inB(tr, tc) && sideOf(b[tr][tc]) !== turn) add(r, c, tr, tc);
      }
      if (t === "k") {
        const row = turn === "w" ? 7 : 0, opp: Side = turn === "w" ? "b" : "w";
        const [cK, cQ] = turn === "w" ? [p.castle.K, p.castle.Q] : [p.castle.k, p.castle.q];
        if (r === row && c === 4 && !attacked(b, row, 4, opp)) {
          if (cK && b[row][5] === "." && b[row][6] === "." && !attacked(b, row, 5, opp) && !attacked(b, row, 6, opp)) add(r, c, row, 6, { castle: "K" });
          if (cQ && b[row][3] === "." && b[row][2] === "." && b[row][1] === "." && !attacked(b, row, 3, opp) && !attacked(b, row, 2, opp)) add(r, c, row, 2, { castle: "Q" });
        }
      }
    } else {
      const dirs = t === "b" ? DIAG : t === "r" ? ORTH : [...DIAG, ...ORTH];
      for (const [dr, dc] of dirs) {
        let tr = r + dr, tc = c + dc;
        while (inB(tr, tc)) {
          const s = sideOf(b[tr][tc]);
          if (s === turn) break;
          add(r, c, tr, tc);
          if (s !== null) break;
          tr += dr; tc += dc;
        }
      }
    }
  }
  return out;
}

export function makeMove(p: Pos, m: Move): Pos {
  const b = p.board.map((r) => [...r]);
  const [fr, fc] = m.from, [tr, tc] = m.to;
  b[tr][tc] = m.promo ?? b[fr][fc];
  b[fr][fc] = ".";
  if (m.ep) b[fr][tc] = ".";
  if (m.castle === "K") { b[tr][5] = b[tr][7]; b[tr][7] = "."; }
  if (m.castle === "Q") { b[tr][3] = b[tr][0]; b[tr][0] = "."; }
  const castle = { ...p.castle };
  if (m.piece === "K") castle.K = castle.Q = false;
  if (m.piece === "k") castle.k = castle.q = false;
  const touch = (r: number, c: number) => {
    if (r === 7 && c === 7) castle.K = false;
    if (r === 7 && c === 0) castle.Q = false;
    if (r === 0 && c === 7) castle.k = false;
    if (r === 0 && c === 0) castle.q = false;
  };
  touch(fr, fc); touch(tr, tc);
  const ep: [number, number] | null = m.piece.toLowerCase() === "p" && Math.abs(tr - fr) === 2 ? [(fr + tr) / 2, fc] : null;
  return { board: b, turn: p.turn === "w" ? "b" : "w", castle, ep };
}

export function legalMoves(p: Pos): Move[] {
  return pseudo(p).filter((m) => !inCheck(makeMove(p, m), p.turn));
}

export type Status = "play" | "checkmate" | "stalemate" | "draw";
export function status(p: Pos): Status {
  if (legalMoves(p).length === 0) return inCheck(p) ? "checkmate" : "stalemate";
  // Only kings (or king + one minor piece) left: nobody can mate.
  const rest = p.board.flat().filter((x) => x !== "." && x.toLowerCase() !== "k");
  if (rest.length === 0 || (rest.length === 1 && "nb".includes(rest[0].toLowerCase()))) return "draw";
  return "play";
}

// ---------------------------------------------------------------- computer player

const VAL: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// Piece-square tables from white's point of view (row 0 = rank 8).
const PST: Record<string, number[]> = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};

/** Score from white's point of view (centipawns). */
function evaluate(b: Board): number {
  let s = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const pc = b[r][c];
    if (pc === ".") continue;
    const t = pc.toLowerCase();
    if (isW(pc)) s += VAL[t] + PST[t][r * 8 + c];
    else s -= VAL[t] + PST[t][(7 - r) * 8 + c];
  }
  return s;
}

/** Captures first (most valuable victim, least valuable attacker) so alpha-beta prunes well. */
const order = (ms: Move[]) => ms.sort((a, b) => (b.captured === "." ? 0 : VAL[b.captured.toLowerCase()] * 10 - VAL[b.piece.toLowerCase()]) - (a.captured === "." ? 0 : VAL[a.captured.toLowerCase()] * 10 - VAL[a.piece.toLowerCase()]) + ((b.promo ? 800 : 0) - (a.promo ? 800 : 0)));

/** Follow captures to the end so the computer doesn't stop counting in the middle of a trade. */
function quiesce(p: Pos, alpha: number, beta: number, depth: number): number {
  const stand = (p.turn === "w" ? 1 : -1) * evaluate(p.board);
  if (stand >= beta) return beta;
  if (alpha < stand) alpha = stand;
  if (depth <= 0) return alpha;
  for (const m of order(legalMoves(p).filter((x) => x.captured !== "." || x.promo))) {
    const sc = -quiesce(makeMove(p, m), -beta, -alpha, depth - 1);
    if (sc >= beta) return beta;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

function search(p: Pos, depth: number, alpha: number, beta: number, ply: number): number {
  const moves = legalMoves(p);
  if (!moves.length) return inCheck(p) ? -100000 + ply : 0; // mated (prefer the quickest mate) or stalemate
  if (depth === 0) return quiesce(p, alpha, beta, 4);
  for (const m of order(moves)) {
    const sc = -search(makeMove(p, m), depth - 1, -beta, -alpha, ply + 1);
    if (sc >= beta) return beta;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

/** The computer's move. `level` = search depth (2 is quick and plays sensible, capturing chess). */
export function bestMove(p: Pos, level = 2): Move | null {
  const moves = order(legalMoves(p));
  if (!moves.length) return null;
  const scored = moves.map((m) => ({ m, sc: -search(makeMove(p, m), level - 1, -Infinity, Infinity, 1) }));
  const top = Math.max(...scored.map((x) => x.sc));
  // Pick at random among moves within 15 centipawns of the best, so games don't repeat.
  const near = scored.filter((x) => x.sc >= top - 15);
  return near[Math.floor(Math.random() * near.length)].m;
}
