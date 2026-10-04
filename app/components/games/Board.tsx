"use client";

import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { inr, type GameId } from "../../lib/data";
import { pickBots, type Bot } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money } from "../ui";
import { BotTag, NEXT_GAME_SECS, ResultSheet, useAutoNext } from "./bots";
import type { Nav } from "../nav";
import { bestMove, inCheck, kingSquare, legalMoves, makeMove, startPos, status as chessStatus, type Move, type Pos } from "../../lib/chess";

export function BoardGame({ nav, gameId, table, buyIn }: { nav: Nav; gameId: GameId; table: string; buyIn: number }) {
  if (gameId === "ludo") return <Ludo nav={nav} table={table} buyIn={buyIn} />;
  if (gameId === "chess") return <Chess nav={nav} table={table} buyIn={buyIn} />;
  return <Carrom nav={nav} table={table} buyIn={buyIn} />;
}

/* ------------------------------------------------------------------ Ludo (PRD §6.3) */

// 52-step common track (row, col) on a 15×15 board, starting at Red's start square.
const TRACK: [number, number][] = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7], [0, 8],
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14],
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6],
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0], [7, 0], [6, 0],
];
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

interface LP {
  name: string;
  color: string;
  dark: string;
  start: number;
  home: [number, number][]; // 5 home-column cells
  yard: [number, number][]; // 4 yard spots
}

const LPLAYERS: LP[] = [
  { name: "You", color: "#ef4444", dark: "#991b1b", start: 0, home: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]], yard: [[1.5, 1.5], [1.5, 3.5], [3.5, 1.5], [3.5, 3.5]] },
  { name: "", color: "#22c55e", dark: "#166534", start: 13, home: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]], yard: [[1.5, 10.5], [1.5, 12.5], [3.5, 10.5], [3.5, 12.5]] },
  { name: "", color: "#eab308", dark: "#854d0e", start: 26, home: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]], yard: [[10.5, 10.5], [10.5, 12.5], [12.5, 10.5], [12.5, 12.5]] },
  { name: "", color: "#3b82f6", dark: "#1e3a8a", start: 39, home: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]], yard: [[10.5, 1.5], [10.5, 3.5], [12.5, 1.5], [12.5, 3.5]] },
];

// progress: -1 yard, 0..50 main track, 51..55 home column, 56 finished
function cellOf(p: number, prog: number, token: number): [number, number] {
  const pl = LPLAYERS[p];
  if (prog < 0) return pl.yard[token];
  if (prog <= 50) return TRACK[(pl.start + prog) % 52];
  if (prog <= 55) return pl.home[prog - 51];
  return ([[7, 6.3], [6.3, 7], [7, 7.7], [7.7, 7]] as [number, number][])[p]; // centre triangle
}
const absIdx = (p: number, prog: number) => (prog >= 0 && prog <= 50 ? (LPLAYERS[p].start + prog) % 52 : -1);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function DiceFace({ v, size = 56, rolling }: { v: number; size?: number; rolling?: boolean }) {
  const spots: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  return (
    <div className={`grid grid-cols-3 p-2 gap-0.5 rounded-xl bg-white ${rolling ? "roll" : ""}`} style={{ width: size, height: size, boxShadow: "inset -3px -3px 6px rgba(0,0,0,.2), 0 6px 14px rgba(0,0,0,.5)" }}>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="grid place-items-center">{spots[v]?.includes(i) && <div className="w-2.5 h-2.5 rounded-full bg-slate-900" />}</div>
      ))}
    </div>
  );
}

// Animation pacing: tokens walk one square at a time so every move can be followed.
const STEP_MS = 170;
const ROLL_MS = 560;

function Ludo({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const { total, debit, credit, showToast } = useStore();
  const [started, setStarted] = useState(false);
  const [tokens, setTokens] = useState<number[][]>(() => LPLAYERS.map(() => [-1, -1, -1, -1]));
  const tokRef = useRef(tokens);
  const [turn, setTurn] = useState(0);
  const [dice, setDice] = useState(6);
  const [rolling, setRolling] = useState(false);
  const [moving, setMoving] = useState(false);
  const [awaitMove, setAwaitMove] = useState(false);
  const [msg, setMsg] = useState("Roll a 6 to bring a token out");
  const [winner, setWinner] = useState<number | null>(null);
  const sixes = useRef(0);
  const alive = useRef(true);
  const over = useRef(false);
  const label = `Ludo • Table #${table}`;
  // Fresh opponents every game (matchmaking), index 0 is you.
  const [names, setNames] = useState<string[]>(() => ["You", ...pickBots(3).map((b) => b.name)]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);
  const gameNo = useRef(0); // bumps on every new game so a bot loop from the last game stops

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const setT = (t: number[][]) => {
    tokRef.current = t;
    setTokens(t);
  };

  const movable = (p: number, d: number) => tokRef.current[p].map((prog, i) => ((prog === -1 && d === 6) || (prog >= 0 && prog + d <= 56) ? i : -1)).filter((i) => i >= 0);

  /** Walk token i of player p forward d squares, one square at a time, then resolve captures.
   *  Resolves to "win", or true if the player earns a bonus roll (six, capture or reaching home). */
  const move = async (p: number, i: number, d: number): Promise<boolean | "win" | "stop"> => {
    const g = gameNo.current;
    setMoving(true);
    const from = tokRef.current[p][i];
    const steps = from === -1 ? [0] : Array.from({ length: d }, (_, k) => from + k + 1);
    for (const prog of steps) {
      if (!alive.current || g !== gameNo.current || over.current) return "stop";
      const t = tokRef.current.map((r) => [...r]);
      t[p][i] = prog;
      setT(t);
      await sleep(STEP_MS);
    }
    if (!alive.current || g !== gameNo.current) return "stop";
    const prog = steps[steps.length - 1];
    let bonus = d === 6 || prog === 56;
    const a = absIdx(p, prog);
    if (a >= 0 && !SAFE.has(a)) {
      const t = tokRef.current.map((r) => [...r]);
      let hit = false;
      for (let q = 0; q < 4; q++) {
        if (q === p) continue;
        t[q].forEach((op, j) => {
          if (absIdx(q, op) === a) {
            t[q][j] = -1;
            hit = true;
            setMsg(`${names[p]} captured ${names[q]}'s token!`);
          }
        });
      }
      if (hit) {
        bonus = true;
        setT(t);
        await sleep(380); // let the captured token slide back to its yard
      }
    }
    setMoving(false);
    if (tokRef.current[p].every((x) => x === 56)) {
      finish(p);
      return "win";
    }
    return bonus;
  };

  const finish = (p: number) => {
    over.current = true;
    setMoving(false);
    setWinner(p);
    if (p === 0) credit(Math.floor(buyIn * 4 * 0.9), label);
  };

  const nextTurn = (from: number) => {
    if (over.current || !alive.current) return;
    const n = (from + 1) % 4;
    sixes.current = 0;
    setTurn(n);
    if (n !== 0) botPlay(n);
    else setMsg("Your turn — roll the dice");
  };

  const roll = async (p: number) => {
    setRolling(true);
    // Tumble through faces, then settle on the result.
    const end = Date.now() + ROLL_MS;
    while (Date.now() < end) {
      setDice(1 + Math.floor(Math.random() * 6));
      await sleep(70);
    }
    const d = 1 + Math.floor(Math.random() * 6);
    setDice(d);
    setRolling(false);
    if (d === 6) sixes.current += 1;
    if (sixes.current === 3) {
      setMsg(`${names[p]} rolled three 6s — turn skipped`);
      await sleep(500);
      return -1;
    }
    return d;
  };

  const botPlay = async (p: number) => {
    const g = gameNo.current;
    await sleep(450);
    if (!alive.current || over.current || g !== gameNo.current) return;
    const d = await roll(p);
    if (g !== gameNo.current) return;
    if (d < 0) return nextTurn(p);
    const opts = movable(p, d);
    if (!opts.length) {
      setMsg(`${names[p]} rolled ${d} — no move`);
      await sleep(450);
      return nextTurn(p);
    }
    await sleep(250);
    // prefer a capture, then the most advanced token
    const pick = opts.find((i) => {
      const prog = tokRef.current[p][i] === -1 ? 0 : tokRef.current[p][i] + d;
      const a = absIdx(p, prog);
      return a >= 0 && !SAFE.has(a) && tokRef.current.some((row, q) => q !== p && row.some((op) => absIdx(q, op) === a));
    }) ?? opts.sort((x, y) => tokRef.current[p][y] - tokRef.current[p][x])[0];
    setMsg(`${names[p]} rolled ${d}`);
    const again = await move(p, pick, d);
    if (!alive.current || again === "win" || again === "stop") return;
    if (again) botPlay(p);
    else nextTurn(p);
  };

  const afterMyMove = (again: boolean | "win" | "stop") => {
    if (again === "win" || again === "stop") return;
    if (again) setMsg("Bonus roll! Roll again");
    else nextTurn(0);
  };

  const myRoll = async () => {
    if (turn !== 0 || rolling || moving || awaitMove || winner !== null) return;
    const d = await roll(0);
    if (d < 0) return nextTurn(0);
    const opts = movable(0, d);
    if (!opts.length) {
      setMsg(`You rolled ${d} — no move`);
      await sleep(600);
      return nextTurn(0);
    }
    // One choice (or every choice lands on the same square): just move it.
    const lands = new Set(opts.map((i) => (tokRef.current[0][i] === -1 ? -1 : tokRef.current[0][i] + d)));
    if (opts.length === 1 || lands.size === 1) return afterMyMove(await move(0, opts[0], d));
    setAwaitMove(true);
    setMsg(`You rolled ${d} — tap a glowing token`);
  };

  const tapToken = async (p: number, i: number) => {
    if (p !== 0 || !awaitMove || moving || !movable(0, dice).includes(i)) return;
    setAwaitMove(false);
    afterMyMove(await move(0, i, dice));
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setStarted(false);
      setWinner(null);
      return showToast("Not enough coins — ask your agent");
    }
    setLowBal(false);
    gameNo.current += 1;
    if (games.current++ > 0) setNames(["You", ...pickBots(3, names).map((b) => b.name)]);
    setT(LPLAYERS.map(() => [-1, -1, -1, -1]));
    over.current = false;
    sixes.current = 0;
    setAwaitMove(false);
    setMoving(false);
    setRolling(false);
    setTurn(0);
    setWinner(null);
    setStarted(true);
    setMsg("Your turn — roll the dice");
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(winner !== null, NEXT_GAME_SECS, start);
  const CELL = 100 / 15;
  const myOpts = awaitMove ? movable(0, dice) : [];

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Ludo" sub={`Table #${table} • 4 Players • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="grid grid-cols-4 gap-1.5 mb-3">
          {LPLAYERS.map((pl, p) => (
            <div key={p} className={`rounded-xl px-1.5 py-1.5 flex items-center gap-1.5 border ${turn === p && started ? "border-white/60 bg-white/10" : "border-white/5 bg-white/[0.03]"}`}>
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: pl.color }} />
              <div className="min-w-0">
                <div className="text-[10px] font-medium truncate">{names[p]}{p > 0 && <BotTag />}</div>
                <div className="text-[9px] text-white/50">{tokens[p].filter((x) => x === 56).length}/4 home</div>
              </div>
            </div>
          ))}
        </div>

        <div className="relative w-full aspect-square rounded-2xl overflow-hidden bg-[#f8fafc] shadow-2xl">
          {/* track cells */}
          {TRACK.map(([r, c], i) => {
            const startOf = LPLAYERS.find((pl) => pl.start === i);
            return (
              <div key={i} className="absolute border border-slate-300 grid place-items-center" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%`, background: startOf ? startOf.color : "#fff" }}>
                {SAFE.has(i) && !startOf && <Star size={12} className="text-slate-400" />}
              </div>
            );
          })}
          {LPLAYERS.map((pl, p) => (
            <div key={p}>
              {pl.home.map(([r, c], i) => (
                <div key={i} className="absolute border border-slate-300" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%`, background: pl.color }} />
              ))}
              {/* yard */}
              <div className="absolute p-[2.2%]" style={{ top: `${(p === 0 || p === 1 ? 0 : 9) * CELL}%`, left: `${(p === 0 || p === 3 ? 0 : 9) * CELL}%`, width: `${6 * CELL}%`, height: `${6 * CELL}%`, background: pl.color }}>
                <div className="w-full h-full bg-white rounded-lg" />
              </div>
            </div>
          ))}
          {/* centre */}
          <div className="absolute" style={{ top: `${6 * CELL}%`, left: `${6 * CELL}%`, width: `${3 * CELL}%`, height: `${3 * CELL}%`, background: `conic-gradient(from 45deg, ${LPLAYERS[2].color} 0 90deg, ${LPLAYERS[3].color} 90deg 180deg, ${LPLAYERS[0].color} 180deg 270deg, ${LPLAYERS[1].color} 270deg 360deg)` }} />
          {/* tokens: positioned with transforms (GPU) and a hop on every square they land on */}
          {tokens.map((row, p) =>
            row.map((prog, i) => {
              const [r, c] = cellOf(p, prog, i);
              const glow = p === 0 && myOpts.includes(i);
              // Tokens sharing a square fan out a little so each stays visible.
              const same = prog >= 0 && prog < 56 ? tokens.flatMap((rw, q) => rw.map((x, j) => ({ q, j, x }))).filter((o) => cellOf(o.q, o.x, o.j)[0] === r && cellOf(o.q, o.x, o.j)[1] === c) : [];
              const k = same.findIndex((o) => o.q === p && o.j === i);
              const shift = same.length > 1 ? (k - (same.length - 1) / 2) * 22 : 0;
              const small = same.length > 1 ? 0.8 : 1;
              return (
                <button
                  key={`${p}-${i}`}
                  onClick={() => tapToken(p, i)}
                  className={`absolute left-0 top-0 ${glow ? "z-20" : "z-10"}`}
                  style={{
                    width: `${CELL}%`,
                    height: `${CELL}%`,
                    transform: `translate(${c * 100 + shift}%, ${r * 100}%)`,
                    transition: prog < 0 ? "transform .38s cubic-bezier(.3,.7,.3,1)" : "transform .15s ease-out",
                    willChange: "transform",
                  }}
                >
                  <span key={prog} className={`block w-full h-full p-[15%] ${prog >= 0 ? "hop" : ""}`}>
                    <span
                      className={`block w-full h-full rounded-full border-2 border-white ${glow ? "pulse-ring" : ""}`}
                      style={{
                        transform: `scale(${glow ? 1.12 * small : small})`,
                        transition: "transform .15s",
                        background: `radial-gradient(circle at 35% 30%, #fff8, ${LPLAYERS[p].color} 45%, ${LPLAYERS[p].dark})`,
                        boxShadow: "0 3px 6px rgba(0,0,0,.45)",
                      }}
                    />
                  </span>
                </button>
              );
            }),
          )}
          {!started && (
            <div className="absolute inset-0 bg-black/55 grid place-items-center z-30">
              <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-4">
          <button onClick={myRoll} disabled={!started || turn !== 0 || rolling || moving || awaitMove} className={`active:scale-95 transition-[transform,opacity] ${!started || turn !== 0 || moving || awaitMove ? "opacity-50" : ""} ${started && turn === 0 && !rolling && !moving && !awaitMove ? "pulse-ring rounded-xl" : ""}`}>
            <DiceFace v={dice} rolling={rolling} size={64} />
          </button>
          <div className="flex-1">
            <div className="text-sm font-medium">{started ? (turn === 0 ? (awaitMove ? "Choose a token" : moving ? "Moving…" : rolling ? "Rolling…" : "Tap the dice to roll") : `${names[turn]}'s turn`) : "Waiting to start"}</div>
            <div className="text-xs text-white/60 mt-0.5">{msg}</div>
          </div>
        </div>
        {started && winner === null && (
          <button onClick={() => finish(0)} className="w-full text-center text-[11px] text-white/40 mt-4 border border-dashed border-white/15 rounded-xl py-2">Demo: finish game</button>
        )}
      </div>

      <ResultSheet
        open={winner !== null}
        won={winner === 0}
        title={winner === 0 ? `You won ${inr(Math.floor(buyIn * 4 * 0.9))}!` : `${winner !== null ? names[winner] : ""} wins`}
        left={nextIn}
        onLeave={nav.back}
        onClose={() => {}}
      />
    </div>
  );
}

/** Overlay shown before a game: matchmaking countdown, or a Get Coins prompt when the entry can't be paid. */
function Waiting({ lowBal, left, onRetry, onAddCash }: { lowBal: boolean; left: number; onRetry: () => void; onAddCash: () => void }) {
  return lowBal ? (
    <div className="text-center">
      <div className="text-xs text-white/80">Not enough balance for the entry</div>
      <button onClick={onAddCash} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Get Coins</button>
      <button onClick={onRetry} className="block mx-auto text-[11px] text-white/60 mt-2">Try again</button>
    </div>
  ) : (
    <div className="text-center">
      <div className="text-sm font-semibold">Finding opponents…</div>
      <div className="text-xs text-white/70 mt-1">Starting in {left}s</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Chess */

// Full rules (app/lib/chess.ts): legal moves only, check, checkmate, stalemate, castling, en passant, promotion to
// a queen. The computer searches a few moves ahead, so it captures loose pieces and goes for mate.
const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟", K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };
const CHESS_SECS = 600;

function Chess({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const { total, credit, debit, showToast } = useStore();
  const [pos, setPos] = useState<Pos>(startPos);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [last, setLast] = useState<Move | null>(null);
  const [taken, setTaken] = useState<{ w: string[]; b: string[] }>({ w: [], b: [] }); // pieces each side has captured
  const [clock, setClock] = useState([CHESS_SECS, CHESS_SECS]);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState<null | "win" | "loss" | "draw">(null);
  const [why, setWhy] = useState("");
  const label = `Chess • Table #${table}`;
  const [opp, setOpp] = useState<Bot>(() => pickBots(1)[0]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);
  const gameNo = useRef(0);
  const white = pos.turn === "w";

  const end = (result: "win" | "loss" | "draw", reason: string) => {
    setDone(result);
    setWhy(reason);
    if (result === "win") credit(Math.floor(buyIn * 2 * 0.9), label);
    if (result === "draw") credit(buyIn, label, "Refund");
  };

  const play = (p: Pos, m: Move) => {
    const next = makeMove(p, m);
    setPos(next);
    setLast(m);
    setSel(null);
    if (m.captured !== ".") setTaken((t) => (p.turn === "w" ? { ...t, w: [...t.w, m.captured] } : { ...t, b: [...t.b, m.captured] }));
    const st = chessStatus(next);
    if (st === "checkmate") end(p.turn === "w" ? "win" : "loss", "Checkmate");
    else if (st === "stalemate") end("draw", "Stalemate");
    else if (st === "draw") end("draw", "Not enough pieces to mate");
    return st;
  };

  // Clocks: the side to move loses time; running out loses the game.
  useEffect(() => {
    if (!started || done !== null) return;
    const t = setInterval(() => setClock((c) => (white ? [c[0] - 1, c[1]] : [c[0], c[1] - 1])), 1000);
    return () => clearInterval(t);
  }, [started, white, done]);
  useEffect(() => {
    if (done !== null || !started) return;
    if (clock[0] <= 0) end("loss", "You ran out of time");
    else if (clock[1] <= 0) end("win", `${opp.name} ran out of time`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock]);

  // Computer's turn: think for a moment, then play the engine's move.
  useEffect(() => {
    if (!started || white || done !== null) return;
    const g = gameNo.current;
    const t = setTimeout(() => {
      if (g !== gameNo.current) return;
      const m = bestMove(pos, 2);
      if (m) play(pos, m);
    }, 450 + Math.random() * 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, started, done]);

  const myMoves = started && white && done === null ? legalMoves(pos) : [];
  const targets = sel ? myMoves.filter((m) => m.from[0] === sel[0] && m.from[1] === sel[1]) : [];

  const tap = (r: number, c: number) => {
    if (!started || !white || done !== null) return;
    const m = targets.find((x) => x.to[0] === r && x.to[1] === c);
    if (m) return void play(pos, m);
    const pc = pos.board[r][c];
    if (pc !== "." && pc === pc.toUpperCase()) {
      if (!myMoves.some((x) => x.from[0] === r && x.from[1] === c)) return setSel([r, c]); // selectable, just no moves
      return setSel(sel && sel[0] === r && sel[1] === c ? null : [r, c]);
    }
    setSel(null);
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setStarted(false);
      setDone(null);
      return showToast("Not enough coins — ask your agent");
    }
    setLowBal(false);
    gameNo.current += 1;
    if (games.current++ > 0) setOpp(pickBots(1, [opp.name])[0]);
    setPos(startPos());
    setSel(null);
    setLast(null);
    setTaken({ w: [], b: [] });
    setClock([CHESS_SECS, CHESS_SECS]);
    setDone(null);
    setWhy("");
    setStarted(true);
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(done !== null, NEXT_GAME_SECS, start);
  const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
  const check = started && done === null && inCheck(pos);
  const [kr, kc] = kingSquare(pos.board, pos.turn);
  const Taken = ({ list }: { list: string[] }) => (
    <div className="h-5 flex items-center gap-[1px] text-[15px] leading-none text-white/80 px-1">
      {[...list].sort((a, b) => "qrbnp".indexOf(a.toLowerCase()) - "qrbnp".indexOf(b.toLowerCase())).map((p, i) => <span key={i}>{GLYPH[p]}</span>)}
    </div>
  );

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Chess" sub={`Table #${table} • Blitz 10 min • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <PlayerBar name={opp.name} bot emoji={opp.emoji} time={fmt(clock[1])} active={started && !white && done === null} />
        <Taken list={taken.b} />
        <div className="relative grid grid-cols-8 rounded-xl overflow-hidden shadow-2xl border-4 border-[#3b2412]">
          {pos.board.map((row, r) =>
            row.map((p, c) => {
              const dark = (r + c) % 2 === 1;
              const isSel = sel && sel[0] === r && sel[1] === c;
              const isLast = last && ((last.from[0] === r && last.from[1] === c) || (last.to[0] === r && last.to[1] === c));
              const tgt = targets.find((m) => m.to[0] === r && m.to[1] === c);
              const inChk = check && r === kr && c === kc;
              return (
                <button
                  key={`${r}${c}`}
                  onClick={() => tap(r, c)}
                  className="relative aspect-square grid place-items-center text-[30px] leading-none"
                  style={{
                    background: isSel ? "#f6e05e" : isLast ? (dark ? "#b9ca43" : "#f5f682") : dark ? "#779556" : "#ebecd0",
                    boxShadow: inChk ? "inset 0 0 14px 5px #ef4444" : undefined,
                  }}
                >
                  {c === 0 && <span className={`absolute left-0.5 top-0.5 text-[9px] font-semibold ${dark ? "text-[#ebecd0]" : "text-[#779556]"}`}>{8 - r}</span>}
                  {r === 7 && <span className={`absolute right-0.5 bottom-0 text-[9px] font-semibold ${dark ? "text-[#ebecd0]" : "text-[#779556]"}`}>{"abcdefgh"[c]}</span>}
                  {p !== "." && (
                    <span key={`${p}${last?.to.join() ?? ""}`} className={isLast && last && last.to[0] === r && last.to[1] === c ? "pop" : ""} style={{ color: /[A-Z]/.test(p) ? "#fff" : "#111", textShadow: /[A-Z]/.test(p) ? "0 0 2px #000, 0 1px 2px #000" : "0 0 1px #fff" }}>
                      {GLYPH[p]}
                    </span>
                  )}
                  {tgt && (tgt.captured !== "." ? (
                    <span className="absolute inset-[6%] rounded-full border-[4px] border-black/25" />
                  ) : (
                    <span className="absolute w-[28%] h-[28%] rounded-full bg-black/25" />
                  ))}
                </button>
              );
            }),
          )}
          {!started && (
            <div className="absolute inset-0 bg-black/55 grid place-items-center">
              <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
            </div>
          )}
        </div>
        <Taken list={taken.w} />
        <PlayerBar name="You" emoji="👨🏽" time={fmt(clock[0])} active={started && white && done === null} />
        <div className={`text-center text-[12px] mt-3 ${check ? "text-rose-400 font-semibold" : "text-white/45"}`}>
          {done !== null ? why : check ? (white ? "Check! Protect your king" : `You gave check!`) : started ? (white ? "Your move — tap a piece to see where it can go" : `${opp.name} is thinking…`) : ""}
        </div>
      </div>
      <ResultSheet
        open={done !== null}
        won={done === "win"}
        title={done === "win" ? `${why} — you won ${inr(Math.floor(buyIn * 2 * 0.9))}!` : done === "draw" ? `${why} — draw, entry refunded` : `${why} — ${opp.name} wins`}
        left={nextIn}
        onLeave={nav.back}
        onClose={() => {}}
      />
    </div>
  );
}

function PlayerBar({ name, emoji, time, active, bot }: { name: string; emoji: string; time: string; active: boolean; bot?: boolean }) {
  return (
    <div className="flex items-center gap-3 card px-3 py-2">
      <Avatar emoji={emoji} size={34} />
      <div className="flex-1 text-sm font-medium">{name}{bot && <BotTag />}</div>
      <div className={`font-mono text-sm px-2.5 py-1 rounded-lg ${active ? "bg-white text-slate-900" : "bg-white/10 text-white/60"}`}>{time}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Carrom */

// Real 2-D physics on a 100×100 board (units = % of the playing surface): friction, wall bounces, disc-to-disc
// collisions and corner pockets, stepped at a fixed 240 Hz and drawn every animation frame.
// You play white from the bottom baseline, the bot plays black from the top. Pocket your colour: +1 and shoot
// again. The queen: +2 and shoot again. The other colour scores for its owner. Pocketing the striker is a foul
// (−1). First to 5.

type DiscKind = "w" | "b" | "q" | "s";
interface Disc { id: number; k: DiscKind; x: number; y: number; vx: number; vy: number; r: number; m: number; sunk: boolean }

const COIN_R = 3;
const STRIKER_R = 4;
const POCKETS: [number, number][] = [[5.5, 5.5], [94.5, 5.5], [5.5, 94.5], [94.5, 94.5]];
const POCKET_R = 5;
const BASELINE = [82, 18]; // y of the baseline for you / the bot
const BASE_MIN = 22, BASE_MAX = 78;
const MAX_SPEED = 270;
const PHYS_DT = 1 / 240;
const CARROM_WIN = 5;
const KIND_OF = ["w", "b"] as const;

function rackCarrom(): Disc[] {
  const d: Disc[] = [];
  const add = (k: DiscKind, x: number, y: number) => d.push({ id: d.length, k, x, y, vx: 0, vy: 0, r: COIN_R, m: 1, sunk: false });
  add("q", 50, 50);
  for (let i = 0; i < 6; i++) add(i % 2 ? "w" : "b", 50 + 6.3 * Math.cos((i * Math.PI) / 3), 50 + 6.3 * Math.sin((i * Math.PI) / 3));
  for (let i = 0; i < 12; i++) add(i % 2 ? "b" : "w", 50 + 12.4 * Math.cos((i * Math.PI) / 6 + Math.PI / 12), 50 + 12.4 * Math.sin((i * Math.PI) / 6 + Math.PI / 12));
  d.push({ id: 99, k: "s", x: 50, y: BASELINE[0], vx: 0, vy: 0, r: STRIKER_R, m: 2, sunk: false });
  return d;
}

/** Advance the board by dt seconds. Discs that drop into a pocket are pushed onto `sunk`. */
function carromStep(ds: Disc[], dt: number, sunk: Disc[]) {
  for (const d of ds) {
    if (d.sunk) continue;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    const sp = Math.hypot(d.vx, d.vy);
    if (sp > 0) {
      const ns = Math.max(0, sp - (sp * 1.15 + 14) * dt);
      d.vx *= ns / sp;
      d.vy *= ns / sp;
    }
    if (d.x < d.r) { d.x = d.r; d.vx = -d.vx * 0.72; }
    if (d.x > 100 - d.r) { d.x = 100 - d.r; d.vx = -d.vx * 0.72; }
    if (d.y < d.r) { d.y = d.r; d.vy = -d.vy * 0.72; }
    if (d.y > 100 - d.r) { d.y = 100 - d.r; d.vy = -d.vy * 0.72; }
    for (const [px, py] of POCKETS) {
      if (Math.hypot(d.x - px, d.y - py) < POCKET_R) {
        d.sunk = true;
        d.x = px; d.y = py; d.vx = 0; d.vy = 0;
        sunk.push(d);
        break;
      }
    }
  }
  for (let i = 0; i < ds.length; i++) {
    const a = ds[i];
    if (a.sunk) continue;
    for (let j = i + 1; j < ds.length; j++) {
      const b = ds[j];
      if (b.sunk) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const min = a.r + b.r;
      if (dist >= min || dist === 0) continue;
      const nx = dx / dist, ny = dy / dist;
      // Push apart (by mass), then exchange momentum along the line of centres.
      const push = (min - dist) / (a.m + b.m);
      a.x -= nx * push * b.m; a.y -= ny * push * b.m;
      b.x += nx * push * a.m; b.y += ny * push * a.m;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel >= 0) continue;
      const j2 = (-(1 + 0.9) * rel) / (1 / a.m + 1 / b.m);
      a.vx -= (j2 / a.m) * nx; a.vy -= (j2 / a.m) * ny;
      b.vx += (j2 / b.m) * nx; b.vy += (j2 / b.m) * ny;
    }
  }
}

/** Bot aim: the best cut shot onto one of its coins into a pocket, with a little human error. */
function botShot(ds: Disc[]): { x: number; vx: number; vy: number } {
  const y = BASELINE[1];
  let best: { score: number; x: number; ang: number; speed: number } | null = null;
  for (const c of ds) {
    if (c.sunk || (c.k !== "b" && c.k !== "q")) continue;
    for (const [px, py] of POCKETS) {
      const cp = Math.hypot(px - c.x, py - c.y);
      const nx = (c.x - px) / cp, ny = (c.y - py) / cp;
      const gx = c.x + nx * (COIN_R + STRIKER_R), gy = c.y + ny * (COIN_R + STRIKER_R);
      for (let x = BASE_MIN; x <= BASE_MAX; x += 4) {
        const sx = gx - x, sy = gy - y;
        const sg = Math.hypot(sx, sy);
        const cut = (sx * -nx + sy * -ny) / sg; // 1 = straight shot
        if (cut < 0.45 || sy <= 0) continue;
        const score = cut * 2 - (sg + cp) / 120 + (c.k === "q" ? 0.2 : 0);
        if (!best || score > best.score) best = { score, x, ang: Math.atan2(sy, sx), speed: Math.min(MAX_SPEED * 0.9, 70 + (sg + cp) * 1.15 / Math.max(0.5, cut)) };
      }
    }
  }
  if (!best) {
    const x = BASE_MIN + Math.random() * (BASE_MAX - BASE_MIN);
    best = { score: 0, x, ang: Math.atan2(50 - y, 50 - x) + (Math.random() - 0.5) * 0.3, speed: MAX_SPEED * 0.8 };
  }
  const ang = best.ang + (Math.random() - 0.5) * 0.07;
  return { x: best.x, vx: Math.cos(ang) * best.speed, vy: Math.sin(ang) * best.speed };
}

function Carrom({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const { total, debit, credit, showToast } = useStore();
  const discs = useRef<Disc[]>(rackCarrom());
  const [, setFrame] = useState(0);
  const redraw = () => setFrame((f) => f + 1);
  const [phase, setPhase] = useState<"wait" | "aim" | "moving" | "bot">("wait");
  const [who, setWho] = useState(0); // 0 you, 1 bot
  const [score, setScore] = useState([0, 0]);
  const [msg, setMsg] = useState("");
  const [pull, setPull] = useState<{ dx: number; dy: number } | null>(null); // aim vector (board units)
  const [done, setDone] = useState<null | boolean>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const label = `Carrom • Table #${table}`;
  const [opp, setOpp] = useState<Bot>(() => pickBots(1)[0]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);
  const scoreRef = useRef(score);
  scoreRef.current = score;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const striker = () => discs.current.find((d) => d.k === "s")!;

  const placeStriker = (p: number, x = 50) => {
    const s = striker();
    Object.assign(s, { x, y: BASELINE[p], vx: 0, vy: 0, sunk: false });
  };

  /** Run the physics until everything stops, then score the shot. */
  const shoot = (vx: number, vy: number, p: number) => {
    const s = striker();
    s.vx = vx; s.vy = vy;
    setPhase("moving");
    setPull(null);
    const sunk: Disc[] = [];
    let last = performance.now(), acc = 0;
    const loop = (t: number) => {
      if (!alive.current) return;
      acc += Math.min(0.25, (t - last) / 1000); // keep real time even if frames drop
      last = t;
      while (acc >= PHYS_DT) { carromStep(discs.current, PHYS_DT, sunk); acc -= PHYS_DT; }
      redraw();
      const still = discs.current.every((d) => d.sunk || Math.hypot(d.vx, d.vy) < 0.8);
      if (!still) return void requestAnimationFrame(loop);
      for (const d of discs.current) { d.vx = 0; d.vy = 0; }
      settle(p, sunk);
    };
    requestAnimationFrame(loop);
  };

  const settle = (p: number, sunk: Disc[]) => {
    const mine = KIND_OF[p];
    const foul = sunk.some((d) => d.k === "s");
    const own = sunk.filter((d) => d.k === mine).length;
    const other = sunk.filter((d) => d.k === KIND_OF[1 - p]).length;
    const queen = sunk.some((d) => d.k === "q");
    const sc = [...scoreRef.current];
    sc[p] += own + (queen ? 2 : 0);
    sc[1 - p] += other;
    if (foul) sc[p] = Math.max(0, sc[p] - 1);
    setScore(sc);
    const name = p === 0 ? "You" : opp.name;
    const parts = [own && `${own} coin${own > 1 ? "s" : ""}`, queen && "the queen"].filter(Boolean);
    setMsg(foul ? `${name} pocketed the striker — foul (−1)` : parts.length ? `${name} pocketed ${parts.join(" and ")}!` : other ? `${name} pocketed the other colour` : `${p === 0 ? "No pocket" : `${opp.name} missed`}`);

    const left = (k: DiscKind) => discs.current.some((d) => d.k === k && !d.sunk);
    if (sc[0] >= CARROM_WIN || sc[1] >= CARROM_WIN || (!left("w") && !left("b"))) {
      const iWon = sc[0] >= sc[1];
      setDone(iWon);
      setPhase("wait");
      if (iWon) credit(Math.floor(buyIn * 2 * 0.9), label);
      return;
    }
    const again = !foul && (own > 0 || queen);
    const next = again ? p : 1 - p;
    // Re-rack any coin that would be unreachable? Keep it simple: the striker goes back to the next baseline.
    placeStriker(next);
    setWho(next);
    redraw();
    if (next === 0) setPhase("aim");
    else botTurn();
  };

  const botTurn = () => {
    setPhase("bot");
    window.setTimeout(() => {
      if (!alive.current) return;
      const shot = botShot(discs.current);
      placeStriker(1, shot.x); // slides across (CSS transition while phase is "bot")
      redraw();
      window.setTimeout(() => alive.current && shoot(shot.vx, shot.vy, 1), 700);
    }, 600);
  };

  // Aiming: drag back from the striker like a slingshot, release to shoot.
  const toBoard = (e: React.PointerEvent) => {
    const r = boardRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100];
  };
  const onDown = (e: React.PointerEvent) => {
    if (phase !== "aim" || done !== null) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = toBoard(e);
    const s = striker();
    setPull({ dx: s.x - x, dy: s.y - y });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pull || phase !== "aim") return;
    const [x, y] = toBoard(e);
    const s = striker();
    setPull({ dx: s.x - x, dy: s.y - y });
  };
  const onUp = () => {
    if (!pull || phase !== "aim") return;
    const len = Math.hypot(pull.dx, pull.dy);
    const power = Math.min(1, len / 32);
    if (power < 0.08) return setPull(null);
    shoot((pull.dx / len) * power * MAX_SPEED, (pull.dy / len) * power * MAX_SPEED, 0);
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setPhase("wait");
      setDone(null);
      return showToast("Not enough coins — ask your agent");
    }
    setLowBal(false);
    if (games.current++ > 0) setOpp(pickBots(1, [opp.name])[0]);
    discs.current = rackCarrom();
    setScore([0, 0]);
    setDone(null);
    setWho(0);
    setPull(null);
    setMsg("Drag back from the striker and let go to shoot");
    setPhase("aim");
  };

  const started = phase !== "wait" || done !== null;
  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(done !== null, NEXT_GAME_SECS, start);

  const s = striker();
  const pullLen = pull ? Math.hypot(pull.dx, pull.dy) : 0;
  const power = Math.min(1, pullLen / 32);
  const dir = pull && pullLen > 0 ? [pull.dx / pullLen, pull.dy / pullLen] : [0, 0];
  const coinsLeft = (k: DiscKind) => discs.current.filter((d) => d.k === k && !d.sunk).length;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Carrom" sub={`Table #${table} • First to ${CARROM_WIN} • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="flex items-center justify-between card px-4 py-2.5">
          <div className={`flex items-center gap-2 ${who === 0 && started ? "" : "opacity-60"}`}><Avatar size={30} /><span className="text-sm">You <span className="inline-block w-2.5 h-2.5 rounded-full bg-white align-middle ml-0.5" /></span><b className="text-neon-400 ml-1">{score[0]}</b></div>
          <div className="text-xs text-white/50">vs</div>
          <div className={`flex items-center gap-2 ${who === 1 && started ? "" : "opacity-60"}`}><b className="text-rose-400 mr-1">{score[1]}</b><span className="text-sm">{opp.name}<BotTag /> <span className="inline-block w-2.5 h-2.5 rounded-full bg-stone-900 border border-white/40 align-middle" /></span><Avatar emoji={opp.emoji} size={30} /></div>
        </div>
        <div className="relative mt-3 aspect-square rounded-2xl p-[5%] shadow-2xl select-none" style={{ background: "linear-gradient(135deg,#5b3417,#3b2412)" }}>
          <div
            ref={boardRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setPull(null)}
            className="relative w-full h-full rounded-md overflow-hidden"
            style={{ background: "radial-gradient(circle,#f6d8a8,#e9bf82)", touchAction: "none", cursor: phase === "aim" ? "crosshair" : "default" }}
          >
            {POCKETS.map(([x, y], i) => (
              <div key={i} className="absolute rounded-full bg-[#1a0f07] -translate-x-1/2 -translate-y-1/2" style={{ left: `${x}%`, top: `${y}%`, width: "9%", height: "9%", boxShadow: "inset 0 3px 6px rgba(0,0,0,.8)" }} />
            ))}
            <div className="absolute inset-[12%] border-2 border-[#8b5a2b]/60 rounded" />
            {BASELINE.map((y) => (
              <div key={y} className="absolute border-y-2 border-[#8b5a2b]/50" style={{ left: `${BASE_MIN - 4}%`, right: `${100 - BASE_MAX - 4}%`, top: `${y - 4}%`, height: "8%" }} />
            ))}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[30%] h-[30%] rounded-full border-2 border-[#8b5a2b]/60" />

            {/* aim guide */}
            {pull && power >= 0.08 && (
              <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none">
                <line x1={s.x} y1={s.y} x2={s.x + dir[0] * 70} y2={s.y + dir[1] * 70} stroke="rgba(255,255,255,.55)" strokeWidth=".5" strokeDasharray="1.5 1.5" />
                <line x1={s.x} y1={s.y} x2={s.x - dir[0] * power * 16} y2={s.y - dir[1] * power * 16} stroke={power > 0.75 ? "#ef4444" : power > 0.4 ? "#f59e0b" : "#22c55e"} strokeWidth="1.4" strokeLinecap="round" />
                <circle cx={s.x} cy={s.y} r={STRIKER_R + 1 + power * 3} fill="none" stroke="rgba(255,255,255,.5)" strokeWidth=".4" />
              </svg>
            )}

            {discs.current.map((d) => (
              <div
                key={d.id}
                className="absolute rounded-full pointer-events-none"
                style={{
                  left: 0,
                  top: 0,
                  width: `${d.r * 2}%`,
                  height: `${d.r * 2}%`,
                  transform: `translate(${((d.x - d.r) / (d.r * 2)) * 100}%, ${((d.y - d.r) / (d.r * 2)) * 100}%) scale(${d.sunk ? 0.2 : 1})`,
                  opacity: d.sunk ? 0 : 1,
                  transition: d.sunk ? "transform .25s ease-in, opacity .25s ease-in" : d.k === "s" && phase === "bot" ? "transform .6s ease-in-out" : "none",
                  willChange: "transform",
                  background:
                    d.k === "s" ? "radial-gradient(circle at 35% 35%,#dbeafe,#2563eb 60%,#1e3a8a)"
                    : d.k === "q" ? "radial-gradient(circle at 35% 35%,#fecaca,#dc2626 60%,#7f1d1d)"
                    : d.k === "w" ? "radial-gradient(circle at 35% 35%,#fff,#f5f5f4 55%,#d6d3d1)"
                    : "radial-gradient(circle at 35% 35%,#57534e,#1c1917 60%,#0c0a09)",
                  boxShadow: "0 2px 3px rgba(0,0,0,.45), inset 0 0 0 1.5px rgba(0,0,0,.15)",
                }}
              />
            ))}

            {!started && (
              <div className="absolute inset-0 bg-black/55 grid place-items-center">
                <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 text-center text-sm min-h-5 text-white/80">{msg}</div>
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-white/60">
            Striker position
            <input
              type="range"
              min={BASE_MIN}
              max={BASE_MAX}
              step={0.5}
              value={who === 0 ? s.x : 50}
              disabled={phase !== "aim"}
              onChange={(e) => { placeStriker(0, Number(e.target.value)); redraw(); }}
              className="w-full accent-green-400 disabled:opacity-40"
            />
          </label>
          <div className="text-center text-[12px] text-white/50">
            {phase === "aim" ? "Your turn: slide the striker, then drag back on the board and release" : phase === "moving" ? "…" : phase === "bot" ? `${opp.name} is lining up a shot` : ""}
          </div>
          <div className="flex justify-center gap-4 text-[11px] text-white/45">
            <span>White left: {coinsLeft("w")}</span><span>Black left: {coinsLeft("b")}</span><span>Queen: {coinsLeft("q") ? "on board" : "pocketed"}</span>
          </div>
        </div>
      </div>
      <ResultSheet open={done !== null} won={!!done} title={done ? `You won ${inr(Math.floor(buyIn * 2 * 0.9))}!` : `${opp.name} wins`} left={nextIn} onLeave={nav.back} onClose={() => {}} />
    </div>
  );
}
