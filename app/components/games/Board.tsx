"use client";

import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { inr, type GameId } from "../../lib/data";
import { pickBots, type Bot } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money } from "../ui";
import { NEXT_GAME_SECS, ResultSheet, useAutoNext } from "./bots";
import type { Nav } from "../nav";

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

function Ludo({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const { total, debit, credit, showToast } = useStore();
  const [started, setStarted] = useState(false);
  const [tokens, setTokens] = useState<number[][]>(() => LPLAYERS.map(() => [-1, -1, -1, -1]));
  const tokRef = useRef(tokens);
  const [turn, setTurn] = useState(0);
  const [dice, setDice] = useState(6);
  const [rolling, setRolling] = useState(false);
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

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const setT = (t: number[][]) => {
    tokRef.current = t;
    setTokens(t);
  };

  const movable = (p: number, d: number) => tokRef.current[p].map((prog, i) => ((prog === -1 && d === 6) || (prog >= 0 && prog + d <= 56) ? i : -1)).filter((i) => i >= 0);

  // Returns "win", or true if the player earns a bonus roll (six, capture or reaching home).
  const move = (p: number, i: number, d: number): boolean | "win" => {
    const t = tokRef.current.map((r) => [...r]);
    const prog = t[p][i] === -1 ? 0 : t[p][i] + d;
    t[p][i] = prog;
    let bonus = d === 6 || prog === 56;
    const a = absIdx(p, prog);
    if (a >= 0 && !SAFE.has(a)) {
      for (let q = 0; q < 4; q++) {
        if (q === p) continue;
        t[q].forEach((op, j) => {
          if (absIdx(q, op) === a) {
            t[q][j] = -1;
            bonus = true;
            setMsg(`${names[p]} captured ${names[q]}'s token!`);
          }
        });
      }
    }
    setT(t);
    if (t[p].every((x) => x === 56)) {
      finish(p);
      return "win";
    }
    return bonus;
  };

  const finish = (p: number) => {
    over.current = true;
    setWinner(p);
    if (p === 0) credit(Math.floor(buyIn * 4 * 0.9), label);
  };

  const nextTurn = (from: number) => {
    const n = (from + 1) % 4;
    sixes.current = 0;
    setTurn(n);
    if (n !== 0) botPlay(n);
    else setMsg("Your turn — roll the dice");
  };

  const roll = async (p: number) => {
    setRolling(true);
    await sleep(500);
    const d = 1 + Math.floor(Math.random() * 6);
    setDice(d);
    setRolling(false);
    if (d === 6) sixes.current += 1;
    if (sixes.current === 3) {
      setMsg(`${names[p]} rolled three 6s — turn skipped`);
      return -1;
    }
    return d;
  };

  const botPlay = async (p: number) => {
    await sleep(600);
    if (!alive.current || over.current) return;
    const d = await roll(p);
    if (d < 0) return nextTurn(p);
    const opts = movable(p, d);
    if (!opts.length) {
      setMsg(`${names[p]} rolled ${d} — no move`);
      await sleep(500);
      return nextTurn(p);
    }
    await sleep(400);
    // prefer a capture, then the most advanced token
    const pick = opts.find((i) => {
      const prog = tokRef.current[p][i] === -1 ? 0 : tokRef.current[p][i] + d;
      const a = absIdx(p, prog);
      return a >= 0 && !SAFE.has(a) && tokRef.current.some((row, q) => q !== p && row.some((op) => absIdx(q, op) === a));
    }) ?? opts.sort((x, y) => tokRef.current[p][y] - tokRef.current[p][x])[0];
    setMsg(`${names[p]} rolled ${d}`);
    const again = move(p, pick, d);
    if (!alive.current || again === "win") return;
    if (again) botPlay(p);
    else nextTurn(p);
  };

  const myRoll = async () => {
    if (turn !== 0 || rolling || awaitMove || winner !== null) return;
    const d = await roll(0);
    if (d < 0) return nextTurn(0);
    const opts = movable(0, d);
    if (!opts.length) {
      setMsg(`You rolled ${d} — no move`);
      await sleep(700);
      return nextTurn(0);
    }
    if (opts.length === 1) {
      const again = move(0, opts[0], d);
      if (again === "win") return;
      if (again) setMsg("Bonus roll! Roll again");
      else nextTurn(0);
      return;
    }
    setAwaitMove(true);
    setMsg(`You rolled ${d} — tap a glowing token`);
  };

  const tapToken = (p: number, i: number) => {
    if (p !== 0 || !awaitMove || !movable(0, dice).includes(i)) return;
    setAwaitMove(false);
    const again = move(0, i, dice);
    if (again === "win") return;
    if (again) setMsg("Bonus roll! Roll again");
    else nextTurn(0);
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setStarted(false);
      setWinner(null);
      return showToast("Not enough balance — add cash");
    }
    setLowBal(false);
    if (games.current++ > 0) setNames(["You", ...pickBots(3, names).map((b) => b.name)]);
    setT(LPLAYERS.map(() => [-1, -1, -1, -1]));
    over.current = false;
    sixes.current = 0;
    setAwaitMove(false);
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
      <Header title="Ludo" sub={`Table #${table} • 4 Players • Entry ₹${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="grid grid-cols-4 gap-1.5 mb-3">
          {LPLAYERS.map((pl, p) => (
            <div key={p} className={`rounded-xl px-1.5 py-1.5 flex items-center gap-1.5 border ${turn === p && started ? "border-white/60 bg-white/10" : "border-white/5 bg-white/[0.03]"}`}>
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: pl.color }} />
              <div className="min-w-0">
                <div className="text-[10px] font-medium truncate">{names[p]}</div>
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
          {/* tokens */}
          {tokens.map((row, p) =>
            row.map((prog, i) => {
              const [r, c] = cellOf(p, prog, i);
              const glow = p === 0 && myOpts.includes(i);
              const stackOffset = row.slice(0, i).filter((x, j) => x === prog && prog >= 0 && prog < 56 && j < i).length * 3;
              return (
                <button
                  key={`${p}-${i}`}
                  onClick={() => tapToken(p, i)}
                  className={`absolute rounded-full border-2 border-white transition-all duration-300 ${glow ? "pulse-ring z-20 scale-110" : "z-10"}`}
                  style={{
                    top: `calc(${r * CELL + CELL * 0.15}% - ${stackOffset}px)`,
                    left: `calc(${c * CELL + CELL * 0.15}% + ${stackOffset}px)`,
                    width: `${CELL * 0.7}%`,
                    height: `${CELL * 0.7}%`,
                    background: `radial-gradient(circle at 35% 30%, #fff8, ${LPLAYERS[p].color} 45%, ${LPLAYERS[p].dark})`,
                    boxShadow: "0 3px 6px rgba(0,0,0,.45)",
                  }}
                />
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
          <button onClick={myRoll} disabled={!started || turn !== 0 || rolling || awaitMove} className="disabled:opacity-50 active:scale-95 transition-transform">
            <DiceFace v={dice} rolling={rolling} size={64} />
          </button>
          <div className="flex-1">
            <div className="text-sm font-medium">{started ? (turn === 0 ? (awaitMove ? "Choose a token" : "Tap the dice to roll") : `${names[turn]}'s turn`) : "Waiting to start"}</div>
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

/** Overlay shown before a game: matchmaking countdown, or an Add Cash prompt when the entry can't be paid. */
function Waiting({ lowBal, left, onRetry, onAddCash }: { lowBal: boolean; left: number; onRetry: () => void; onAddCash: () => void }) {
  return lowBal ? (
    <div className="text-center">
      <div className="text-xs text-white/80">Not enough balance for the entry</div>
      <button onClick={onAddCash} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Add Cash</button>
      <button onClick={onRetry} className="block mx-auto text-[11px] text-white/60 mt-2">Try again</button>
    </div>
  ) : (
    <div className="text-center">
      <div className="text-sm font-semibold">Finding opponents…</div>
      <div className="text-xs text-white/70 mt-1">Starting in {left}s</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Chess (preview) */

const START_BOARD = [
  "rnbqkbnr",
  "pppppppp",
  "........",
  "........",
  "........",
  "........",
  "PPPPPPPP",
  "RNBQKBNR",
].map((r) => r.split(""));
const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟", K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };

function Chess({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const { total, credit, debit, showToast } = useStore();
  const [board, setBoard] = useState(START_BOARD.map((r) => [...r]));
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [white, setWhite] = useState(true);
  const [clock, setClock] = useState([600, 600]);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState<null | boolean>(null);
  const label = `Chess • Table #${table}`;
  const [opp, setOpp] = useState<Bot>(() => pickBots(1)[0]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);

  useEffect(() => {
    if (!started || done !== null) return;
    const t = setInterval(() => setClock((c) => (white ? [c[0] - 1, c[1]] : [c[0], c[1] - 1])), 1000);
    return () => clearInterval(t);
  }, [started, white, done]);

  // Opponent replies with a random legal-looking pawn/knight move (demo only — no rules engine).
  useEffect(() => {
    if (!started || white || done !== null) return;
    const t = setTimeout(() => {
      setBoard((b) => {
        const nb = b.map((r) => [...r]);
        for (let tries = 0; tries < 200; tries++) {
          const r = Math.floor(Math.random() * 8), c = Math.floor(Math.random() * 8);
          if (nb[r][c] === "p" && r < 7 && nb[r + 1][c] === ".") {
            nb[r + 1][c] = "p";
            nb[r][c] = ".";
            return nb;
          }
          if (nb[r][c] === "n") {
            const opts = [[2, 1], [2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2], [-2, 1], [-2, -1]].map(([dr, dc]) => [r + dr, c + dc]).filter(([a, d]) => a >= 0 && a < 8 && d >= 0 && d < 8 && !/[a-z]/.test(nb[a][d]));
            if (opts.length) {
              const [a, d] = opts[Math.floor(Math.random() * opts.length)];
              if (nb[a][d] === "K") setDone(false);
              nb[a][d] = "n";
              nb[r][c] = ".";
              return nb;
            }
          }
        }
        return nb;
      });
      setWhite(true);
    }, 900);
    return () => clearTimeout(t);
  }, [white, started, done]);

  const tap = (r: number, c: number) => {
    if (!started || !white || done !== null) return;
    const p = board[r][c];
    if (sel) {
      const [sr, sc] = sel;
      if (sr === r && sc === c) return setSel(null);
      if (/[A-Z]/.test(p)) return setSel([r, c]);
      const nb = board.map((row) => [...row]);
      if (nb[r][c] === "k") {
        setDone(true);
        credit(Math.floor(buyIn * 2 * 0.9), label);
      }
      nb[r][c] = nb[sr][sc];
      nb[sr][sc] = ".";
      setBoard(nb);
      setSel(null);
      setWhite(false);
    } else if (/[A-Z]/.test(p)) setSel([r, c]);
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setStarted(false);
      setDone(null);
      return showToast("Not enough balance — add cash");
    }
    setLowBal(false);
    if (games.current++ > 0) setOpp(pickBots(1, [opp.name])[0]);
    setBoard(START_BOARD.map((r) => [...r]));
    setClock([600, 600]);
    setWhite(true);
    setDone(null);
    setStarted(true);
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(done !== null, NEXT_GAME_SECS, start);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Chess" sub={`Table #${table} • Blitz 10 min • Entry ₹${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <PlayerBar name={opp.name} emoji={opp.emoji} time={fmt(clock[1])} active={started && !white} />
        <div className="relative mt-2 grid grid-cols-8 rounded-xl overflow-hidden shadow-2xl border-4 border-[#3b2412]">
          {board.map((row, r) =>
            row.map((p, c) => {
              const dark = (r + c) % 2 === 1;
              const s = sel && sel[0] === r && sel[1] === c;
              return (
                <button key={`${r}${c}`} onClick={() => tap(r, c)} className="aspect-square grid place-items-center text-[28px] leading-none" style={{ background: s ? "#facc15" : dark ? "#779556" : "#ebecd0" }}>
                  {p !== "." && <span style={{ color: /[A-Z]/.test(p) ? "#fff" : "#111", textShadow: /[A-Z]/.test(p) ? "0 0 2px #000, 0 1px 2px #000" : "0 0 1px #fff" }}>{GLYPH[p]}</span>}
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
        <div className="mt-2"><PlayerBar name="You" emoji="👨🏽" time={fmt(clock[0])} active={started && white} /></div>
        <div className="text-center text-[11px] text-white/40 mt-4">Preview build — full move validation arrives with the Chess module. Capture the king to win.</div>
      </div>
      <ResultSheet open={done !== null} won={!!done} title={done ? `You won ${inr(Math.floor(buyIn * 2 * 0.9))}!` : `${opp.name} wins`} left={nextIn} onLeave={nav.back} onClose={() => {}} />
    </div>
  );
}

function PlayerBar({ name, emoji, time, active }: { name: string; emoji: string; time: string; active: boolean }) {
  return (
    <div className="flex items-center gap-3 card px-3 py-2">
      <Avatar emoji={emoji} size={34} />
      <div className="flex-1 text-sm font-medium">{name}</div>
      <div className={`font-mono text-sm px-2.5 py-1 rounded-lg ${active ? "bg-white text-slate-900" : "bg-white/10 text-white/60"}`}>{time}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Carrom (preview) */

function Carrom({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const { total, debit, credit, showToast } = useStore();
  const [aim, setAim] = useState(50);
  const [power, setPower] = useState(60);
  const [score, setScore] = useState([0, 0]);
  const [started, setStarted] = useState(false);
  const [striking, setStriking] = useState(false);
  const [coins, setCoins] = useState(() => {
    const c: { x: number; y: number; k: "w" | "b" | "q" }[] = [{ x: 50, y: 50, k: "q" }];
    for (let i = 0; i < 6; i++) c.push({ x: 50 + 7 * Math.cos((i * Math.PI) / 3), y: 50 + 7 * Math.sin((i * Math.PI) / 3), k: i % 2 ? "w" : "b" });
    for (let i = 0; i < 12; i++) c.push({ x: 50 + 13.5 * Math.cos((i * Math.PI) / 6 + 0.26), y: 50 + 13.5 * Math.sin((i * Math.PI) / 6 + 0.26), k: i % 2 ? "b" : "w" });
    return c;
  });
  const [done, setDone] = useState<null | boolean>(null);
  const label = `Carrom • Table #${table}`;
  const [opp, setOpp] = useState<Bot>(() => pickBots(1)[0]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);

  const strike = async () => {
    if (!started || striking || done !== null) return;
    setStriking(true);
    await sleep(700);
    const pocketed = Math.random() < 0.35 + power / 400;
    if (pocketed) {
      setCoins((c) => {
        const idx = c.findIndex((x) => x.k === "w");
        return idx >= 0 ? c.filter((_, i) => i !== idx) : c;
      });
      const next = [score[0] + 1, score[1]];
      setScore(next);
      showToast("Pocketed! +1");
      if (next[0] >= 5) {
        setDone(true);
        credit(Math.floor(buyIn * 2 * 0.9), label);
      }
    } else {
      const s1 = score[1] + (Math.random() < 0.4 ? 1 : 0);
      setScore([score[0], s1]);
      if (s1 >= 5) setDone(false);
      showToast("Missed — opponent's turn");
    }
    setStriking(false);
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setStarted(false);
      setDone(null);
      return showToast("Not enough balance — add cash");
    }
    setLowBal(false);
    if (games.current++ > 0) setOpp(pickBots(1, [opp.name])[0]);
    setScore([0, 0]);
    setDone(null);
    setStarted(true);
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(done !== null, NEXT_GAME_SECS, start);

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Carrom" sub={`Table #${table} • First to 5 • Entry ₹${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="flex items-center justify-between card px-4 py-2.5">
          <div className="flex items-center gap-2"><Avatar size={30} /><span className="text-sm">You</span><b className="text-neon-400 ml-1">{score[0]}</b></div>
          <div className="text-xs text-white/50">vs</div>
          <div className="flex items-center gap-2"><b className="text-rose-400 mr-1">{score[1]}</b><span className="text-sm">{opp.name}</span><Avatar emoji={opp.emoji} size={30} /></div>
        </div>
        <div className="relative mt-3 aspect-square rounded-2xl p-[5%] shadow-2xl" style={{ background: "linear-gradient(135deg,#5b3417,#3b2412)" }}>
          <div className="relative w-full h-full rounded-md overflow-hidden" style={{ background: "radial-gradient(circle,#f6d8a8,#e9bf82)" }}>
            {[[0, 0], [0, 1], [1, 0], [1, 1]].map(([a, b]) => (
              <div key={`${a}${b}`} className="absolute w-[9%] h-[9%] rounded-full bg-[#1a0f07]" style={{ top: a ? "auto" : "1%", bottom: a ? "1%" : "auto", left: b ? "auto" : "1%", right: b ? "1%" : "auto" }} />
            ))}
            <div className="absolute inset-[12%] border-2 border-[#8b5a2b]/60 rounded" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[30%] h-[30%] rounded-full border-2 border-[#8b5a2b]/60" />
            {coins.map((c, i) => (
              <div key={i} className="absolute w-[6%] h-[6%] rounded-full -translate-x-1/2 -translate-y-1/2" style={{ left: `${c.x}%`, top: `${c.y}%`, background: c.k === "q" ? "radial-gradient(circle,#fca5a5,#dc2626)" : c.k === "w" ? "radial-gradient(circle,#fff,#e7e5e4)" : "radial-gradient(circle,#44403c,#0c0a09)", boxShadow: "0 2px 3px rgba(0,0,0,.45)" }} />
            ))}
            <div
              className="absolute w-[8%] h-[8%] rounded-full -translate-x-1/2 -translate-y-1/2 transition-all duration-700"
              style={{ left: `${14 + aim * 0.72}%`, top: striking ? "50%" : "85%", background: "radial-gradient(circle,#bfdbfe,#2563eb)", boxShadow: "0 3px 6px rgba(0,0,0,.5)" }}
            />
            {!started && (
              <div className="absolute inset-0 bg-black/55 grid place-items-center">
                <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block text-xs text-white/60">Striker position<input type="range" value={aim} onChange={(e) => setAim(Number(e.target.value))} className="w-full accent-green-400" /></label>
          <label className="block text-xs text-white/60">Power {power}%<input type="range" value={power} onChange={(e) => setPower(Number(e.target.value))} className="w-full accent-green-400" /></label>
          <button disabled={!started || striking} onClick={strike} className="btn-green w-full py-3 rounded-2xl">{striking ? "Striking…" : "Strike"}</button>
        </div>
        <div className="text-center text-[11px] text-white/40 mt-3">Preview build — real physics arrives with the Carrom module.</div>
      </div>
      <ResultSheet open={done !== null} won={!!done} title={done ? `You won ${inr(Math.floor(buyIn * 2 * 0.9))}!` : `${opp.name} wins`} left={nextIn} onLeave={nav.back} onClose={() => {}} />
    </div>
  );
}
