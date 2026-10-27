// Chess with a friend (migration 109): the server checks every move with the same rules as the computer games
// (app/lib/chess.ts), keeps both clocks and ends the game on mate, stalemate, a draw or a flag. The table row is
// written with ch_apply only if nobody moved in between, so two quick taps can never both land.

import { legalMoves, makeMove, posKey, san, status, type Pos } from "../chess";
import { rpc, selectOne } from "./supabaseAdmin";
import { TableError } from "./teenpatti";

interface Row {
  id: string; code: string; entry: number; status: "waiting" | "playing" | "done" | "cancelled";
  host: string; guest: string | null; white: string | null; black: string | null; names: Record<string, string>;
  pos: Pos | null; moves: string[]; hist: string[]; last: { from: [number, number]; to: [number, number] } | null;
  clock_w: number; clock_b: number; turn_since: string | null;
  winner: string | null; result: "win" | "draw" | null; reason: string | null; prize: number | null; seq: number;
}

export interface ChessView {
  id: string; code: string; entry: number; status: Row["status"];
  /** Your colour (null before the friend joins). */
  me: "w" | "b" | null;
  names: { w: string | null; b: string | null; host: string | null };
  pos: Pos | null; moves: string[]; last: Row["last"];
  /** Time left in ms as of serverNow (the side to move's clock already counted down). */
  clock: { w: number; b: number };
  /** "w" / "b" won, "draw", or null while playing. */
  outcome: "w" | "b" | "draw" | null; reason: string | null; prize: number;
  seq: number; serverNow: number;
}

const load = async (id: string) => {
  const r = await selectOne<Row>("ch_tables", `select=*&id=eq.${id}`);
  if (!r) throw new TableError("Table not found", 404);
  return r;
};

/** Time the side to move has used since its clock started (0 before White's first clock starts). */
const used = (r: Row, now: number) => (r.status === "playing" && r.turn_since ? Math.max(0, now - new Date(r.turn_since).getTime()) : 0);

function view(r: Row, uid: string, now: number): ChessView {
  const me = uid === r.white ? "w" : uid === r.black ? "b" : null;
  const turn = r.pos?.turn ?? "w";
  const u = used(r, now);
  return {
    id: r.id, code: r.code, entry: Number(r.entry), status: r.status, me,
    names: { w: r.white ? r.names[r.white] ?? null : null, b: r.black ? r.names[r.black] ?? null : null, host: r.names[r.host] ?? null },
    pos: r.pos, moves: r.moves, last: r.last,
    clock: { w: Math.max(0, r.clock_w - (turn === "w" ? u : 0)), b: Math.max(0, r.clock_b - (turn === "b" ? u : 0)) },
    outcome: r.status === "done" ? (r.result === "draw" ? "draw" : r.winner === r.white ? "w" : "b") : null,
    reason: r.reason, prize: Number(r.prize ?? 0), seq: r.seq, serverNow: now,
  };
}

/** Your view of the table; a clock that ran out ends the game first. */
export async function chessState(id: string, uid: string): Promise<ChessView> {
  let r = await load(id);
  if (uid !== r.host && uid !== r.guest) throw new TableError("Not your table", 403);
  const now = Date.now();
  if (r.status === "playing" && r.pos) {
    const left = (r.pos.turn === "w" ? r.clock_w : r.clock_b) - used(r, now);
    if (left <= 0) {
      await rpc("ch_timeout", { p_table: id, p_seq: r.seq });
      r = await load(id);
    }
  }
  return view(r, uid, Date.now());
}

/** Play your move (board squares as [row, col], row 0 = Black's back rank). */
export async function chessMove(id: string, uid: string, from: [number, number], to: [number, number], promo?: string): Promise<ChessView> {
  const r = await load(id);
  if (uid !== r.host && uid !== r.guest) throw new TableError("Not your table", 403);
  if (r.status !== "playing" || !r.pos) throw new TableError("The game is not on");
  const me = uid === r.white ? "w" : "b";
  if (r.pos.turn !== me) throw new TableError("Not your move");
  const now = Date.now();
  const left = (me === "w" ? r.clock_w : r.clock_b) - used(r, now);
  if (left <= 0) {
    await rpc("ch_timeout", { p_table: id, p_seq: r.seq });
    return chessState(id, uid);
  }
  const m = legalMoves(r.pos).find((x) => x.from[0] === from[0] && x.from[1] === from[1] && x.to[0] === to[0] && x.to[1] === to[1] && (!x.promo || x.promo.toUpperCase() === (promo ?? "Q").toUpperCase()));
  if (!m) throw new TableError("That move is not allowed");
  const next = makeMove(r.pos, m);
  const key = posKey(next);
  const hist = [...(r.hist ?? []), key];
  const st = status(next);
  const end = st === "checkmate" ? { e: "win", why: "checkmate" }
    : st === "stalemate" ? { e: "draw", why: "stalemate" }
    : st === "draw" ? { e: "draw", why: "insufficient material" }
    : st === "fifty" ? { e: "draw", why: "50-move rule" }
    : hist.filter((k) => k === key).length >= 3 ? { e: "draw", why: "threefold repetition" }
    : null;
  const ok = await rpc<boolean>("ch_apply", {
    p_table: id, p_seq: r.seq, p_pos: next, p_moves: [...(r.moves ?? []), san(r.pos, m)], p_hist: hist, p_last: { from: m.from, to: m.to },
    p_clock_w: me === "w" ? Math.round(left) : r.clock_w, p_clock_b: me === "b" ? Math.round(left) : r.clock_b,
    p_end: end?.e ?? null, p_reason: end?.why ?? null,
  });
  if (!ok) throw new TableError("The board changed — try again", 409);
  return chessState(id, uid);
}
