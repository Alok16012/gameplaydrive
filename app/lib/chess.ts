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

// King in the endgame: walk to the centre.
const KING_END = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];
const PASSED = [0, 120, 80, 50, 30, 15, 10, 0]; // bonus for a passed pawn by rows left to promote (white: its row)

/** Score from white's point of view (centipawns): material, piece squares, bishop pair, passed pawns, open-file
 *  rooks, and a king that comes to the centre once the queens and most pieces are gone. */
function evaluate(b: Board): number {
  let s = 0, wMat = 0, bMat = 0, wB = 0, bB = 0;
  const wPawnCol = new Array(8).fill(0), bPawnCol = new Array(8).fill(0);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const pc = b[r][c];
    if (pc === "p") bPawnCol[c]++;
    else if (pc === "P") wPawnCol[c]++;
    else if (pc !== "." && pc.toLowerCase() !== "k") {
      if (isW(pc)) wMat += VAL[pc.toLowerCase()]; else bMat += VAL[pc];
      if (pc === "B") wB++; if (pc === "b") bB++;
    }
  }
  const endgame = wMat + bMat <= 2600;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const pc = b[r][c];
    if (pc === ".") continue;
    const t = pc.toLowerCase();
    const wsq = r * 8 + c, bsq = (7 - r) * 8 + c;
    const pst = t === "k" && endgame ? KING_END : PST[t];
    if (isW(pc)) s += VAL[t] + pst[wsq];
    else s -= VAL[t] + pst[bsq];
    if (t === "p") {
      // passed pawn: no enemy pawn ahead on this or a neighbouring file
      let passed = true;
      for (let cc = Math.max(0, c - 1); cc <= Math.min(7, c + 1) && passed; cc++) {
        if (isW(pc)) { for (let rr = r - 1; rr >= 0; rr--) if (b[rr][cc] === "p") { passed = false; break; } }
        else { for (let rr = r + 1; rr < 8; rr++) if (b[rr][cc] === "P") { passed = false; break; } }
      }
      if (passed) s += isW(pc) ? PASSED[r] : -PASSED[7 - r];
    } else if (t === "r") {
      const open = !wPawnCol[c] && !bPawnCol[c], half = isW(pc) ? !wPawnCol[c] : !bPawnCol[c];
      const bonus = open ? 20 : half ? 10 : 0;
      s += isW(pc) ? bonus : -bonus;
    }
  }
  if (wB >= 2) s += 30;
  if (bB >= 2) s -= 30;
  return s;
}

/** Captures first (most valuable victim, least valuable attacker), then promotions, then the killer moves. */
const mvv = (m: Move) => (m.captured === "." ? 0 : VAL[m.captured.toLowerCase()] * 10 - VAL[m.piece.toLowerCase()] + 10000) + (m.promo ? 9000 : 0);
const same = (a: Move | undefined, b: Move) => !!a && a.from[0] === b.from[0] && a.from[1] === b.from[1] && a.to[0] === b.to[0] && a.to[1] === b.to[1];
const order = (ms: Move[], ply = -1) =>
  ms.sort((a, b) => (mvv(b) + (ply >= 0 && (same(killers[ply]?.[0], b) || same(killers[ply]?.[1], b)) ? 5000 : 0)) - (mvv(a) + (ply >= 0 && (same(killers[ply]?.[0], a) || same(killers[ply]?.[1], a)) ? 5000 : 0)));

// Search state: killer moves per ply, a node counter and a deadline (the search stops when time is up).
let killers: Move[][] = [];
let nodes = 0;
let deadline = Infinity;
class TimeUp extends Error {}
const clock = () => { if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new TimeUp(); };

/** Follow captures to the end so the computer doesn't stop counting in the middle of a trade. */
function quiesce(p: Pos, alpha: number, beta: number, depth: number): number {
  clock();
  const stand = (p.turn === "w" ? 1 : -1) * evaluate(p.board);
  if (stand >= beta) return beta;
  if (alpha < stand) alpha = stand;
  if (depth <= 0) return alpha;
  for (const m of order(pseudo(p).filter((x) => x.captured !== "." || x.promo))) {
    const next = makeMove(p, m);
    if (inCheck(next, p.turn)) continue; // illegal: leaves own king in check
    const sc = -quiesce(next, -beta, -alpha, depth - 1);
    if (sc >= beta) return beta;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

function search(p: Pos, depth: number, alpha: number, beta: number, ply: number): number {
  clock();
  const check = inCheck(p);
  if (check && ply < 12) depth += 1; // look further when in check
  if (depth <= 0) {
    if (!legalMoves(p).length) return check ? -100000 + ply : 0;
    return quiesce(p, alpha, beta, 6);
  }
  let legal = 0;
  for (const m of order(pseudo(p), ply)) {
    const next = makeMove(p, m);
    if (inCheck(next, p.turn)) continue; // illegal: leaves own king in check
    legal++;
    const sc = -search(next, depth - 1, -beta, -alpha, ply + 1);
    if (sc >= beta) {
      if (m.captured === ".") { const k = killers[ply] ?? (killers[ply] = []); if (!same(k[0], m)) { k[1] = k[0]; k[0] = m; } }
      return beta;
    }
    if (sc > alpha) alpha = sc;
  }
  if (!legal) return check ? -100000 + ply : 0; // mated (prefer the quickest mate) or stalemate
  return alpha;
}

/**
 * The computer's move: iterative deepening (1, 2, 3 … ply) until the time budget runs out, keeping the best move
 * of the deepest search that finished. `variety` picks among near-equal moves (used in the opening so games
 * differ). A number argument is read as a plain depth, for older callers.
 */
export function bestMove(p: Pos, opt: number | { ms?: number; maxDepth?: number; variety?: boolean } = {}): Move | null {
  const o = typeof opt === "number" ? { ms: Infinity, maxDepth: opt } : opt;
  const ms = o.ms ?? 900, maxDepth = o.maxDepth ?? 6;
  let root = order(legalMoves(p));
  if (!root.length) return null;
  if (root.length === 1) return root[0];
  killers = [];
  nodes = 0;
  deadline = Date.now() + ms;
  let best = root[0];
  let lastScores: { m: Move; sc: number }[] = [];
  for (let d = 1; d <= maxDepth; d++) {
    try {
      let alpha = -Infinity;
      const scores: { m: Move; sc: number }[] = [];
      for (const m of root) {
        // a little slack on the window keeps near-best scores exact enough to choose between
        const sc = -search(makeMove(p, m), d - 1, -Infinity, -(alpha - 12), 1);
        scores.push({ m, sc });
        if (sc > alpha) alpha = sc;
      }
      scores.sort((a, b) => b.sc - a.sc);
      root = scores.map((x) => x.m); // best first for the next, deeper pass
      best = scores[0].m;
      lastScores = scores;
      if (Math.abs(scores[0].sc) > 90000) break; // found a mate
    } catch (e) {
      if (e instanceof TimeUp) break;
      throw e;
    }
  }
  deadline = Infinity;
  if (o.variety && lastScores.length) {
    const near = lastScores.filter((x) => x.sc >= lastScores[0].sc - 10);
    return near[Math.floor(Math.random() * near.length)].m;
  }
  return best;
}
