"use client";

import { sfx, vibrate } from "../../lib/sound";
import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { inr, type GameId } from "../../lib/data";
import { pickBots, type Bot } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money } from "../ui";
import { BotTag, NEXT_GAME_SECS, ResultSheet, useAutoNext } from "./bots";
import type { Nav } from "../nav";
import { botPace, feeOf, useGameSettings } from "../../lib/gameConfig";
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
const LUDO_TURN_SECS = 20; // each player's turn; when yours runs out the game rolls and moves for you
const BOT_STEP_MS = 260; // bots walk their tokens a little slower, like a person tapping square by square
const ROLL_MS = 560;
/** A human-looking pause: usually between a and b ms, now and then a longer think. */
/** Bot pacing from the admin's "bot speed" setting (1 = normal); set by each table on mount. */
let PACE = 1;
const think = (a: number, b: number) => sleep((a + Math.random() * (b - a) + (Math.random() < 0.15 ? 700 + Math.random() * 900 : 0)) * PACE);

function Ludo({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const gs = useGameSettings();
  const keep = 1 - feeOf(gs, "ludo", 10);
  PACE = botPace(gs, "ludo");
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

  // Turn clock: a ring runs round the active player's photo. Restarted for every turn (and bonus roll).
  const [clock, setClock] = useState<{ p: number; id: number } | null>(null);
  const clockId = useRef(0);
  const startClock = (p: number) => setClock({ p, id: ++clockId.current });
  const autoRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!clock || clock.p !== 0) return;
    const id = clock.id;
    const timers = [15, 16, 17, 18, 19].map((sec) => window.setTimeout(() => { if (clockId.current === id) sfx.tickUrgent(); }, sec * 1000));
    timers.push(window.setTimeout(() => { if (clockId.current === id) autoRef.current(); }, LUDO_TURN_SECS * 1000));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [clock]);

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
      if (prog === 56) sfx.home(); else sfx.hop();
      await sleep(p === 0 ? STEP_MS : BOT_STEP_MS);
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
        sfx.capture();
        if (p !== 0 && t[0].some((x, j) => x === -1 && tokRef.current[0][j] !== -1)) vibrate(120);
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
    setClock(null);
    setWinner(p);
    if (p === 0) credit(Math.floor(buyIn * 4 * keep), label);
  };

  const nextTurn = (from: number) => {
    if (over.current || !alive.current) return;
    const n = (from + 1) % 4;
    sixes.current = 0;
    setTurn(n);
    startClock(n);
    if (n !== 0) botPlay(n);
    else setMsg("Your turn — roll the dice");
  };

  const roll = async (p: number) => {
    setRolling(true);
    sfx.dice();
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

  // Prefer a capture, then the most advanced token.
  const pickToken = (p: number, d: number, opts: number[]) =>
    opts.find((i) => {
      const prog = tokRef.current[p][i] === -1 ? 0 : tokRef.current[p][i] + d;
      const a = absIdx(p, prog);
      return a >= 0 && !SAFE.has(a) && tokRef.current.some((row, q) => q !== p && row.some((op) => absIdx(q, op) === a));
    }) ?? [...opts].sort((x, y) => tokRef.current[p][y] - tokRef.current[p][x])[0];

  const botPlay = async (p: number) => {
    const g = gameNo.current;
    setMsg(`${names[p]}'s turn`);
    await think(900, 1800); // picks up the dice
    if (!alive.current || over.current || g !== gameNo.current) return;
    const d = await roll(p);
    if (g !== gameNo.current) return;
    if (d < 0) return nextTurn(p);
    const opts = movable(p, d);
    if (!opts.length) {
      setMsg(`${names[p]} rolled ${d} — no move`);
      await sleep(1100);
      return nextTurn(p);
    }
    setMsg(`${names[p]} rolled ${d}`);
    await think(opts.length > 1 ? 800 : 500, opts.length > 1 ? 1600 : 900); // decides which token to move
    const pick = pickToken(p, d, opts);
    setMsg(`${names[p]} rolled ${d}`);
    const again = await move(p, pick, d);
    if (!alive.current || again === "win" || again === "stop") return;
    if (again) { startClock(p); botPlay(p); }
    else nextTurn(p);
  };

  const afterMyMove = (again: boolean | "win" | "stop") => {
    if (again === "win" || again === "stop") return;
    if (again) { setMsg("Bonus roll! Roll again"); startClock(0); }
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

  // Your clock ran out: roll (if you hadn't) and make the best move for you.
  autoRef.current = async () => {
    if (turn !== 0 || winner !== null || over.current || rolling || moving) return;
    setMsg("Time's up — auto move");
    if (awaitMove) {
      const opts = movable(0, dice);
      setAwaitMove(false);
      if (opts.length) return afterMyMove(await move(0, pickToken(0, dice, opts), dice));
      return nextTurn(0);
    }
    const d = await roll(0);
    if (d < 0) return nextTurn(0);
    const opts = movable(0, d);
    if (!opts.length) { await sleep(600); return nextTurn(0); }
    afterMyMove(await move(0, pickToken(0, d, opts), d));
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
    startClock(0);
    setWinner(null);
    setStarted(true);
    setMsg("Your turn — roll the dice");
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(winner !== null, NEXT_GAME_SECS, start);
  const CELL = 100 / 15;
  const myOpts = awaitMove ? movable(0, dice) : [];

  // Player badges sit at the board corners next to their yards (red top-left, green top-right, blue bottom-left,
  // yellow bottom-right); the one whose turn it is glows and shows the dice.
  // (A plain render function, not a component: a component defined in here would be rebuilt on every render and
  // restart the timer ring.)
  const badge = (p: number, align: "left" | "right") => {
    const pl = LPLAYERS[p];
    const active = started && turn === p && winner === null;
    const home = tokens[p].filter((x) => x === 56).length;
    return (
      <div className={`flex items-center gap-2 ${align === "right" ? "flex-row-reverse text-right" : ""}`}>
        <div className={`relative rounded-full p-[3px] transition-shadow ${active ? "shadow-[0_0_16px_4px_rgba(255,255,255,.35)]" : ""}`} style={{ background: pl.color }}>
          <Avatar size={34} emoji={p === 0 ? "🧑🏽" : ["", "👨🏻", "👩🏽", "🧔🏾"][p]} />
          {active && clock?.p === p && (
            <svg key={clock.id} viewBox="0 0 52 52" className="absolute -inset-[6px] w-[calc(100%+12px)] h-[calc(100%+12px)] -rotate-90 pointer-events-none">
              <circle cx="26" cy="26" r="24" fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="4" />
              <circle cx="26" cy="26" r="24" fill="none" strokeWidth="4" strokeLinecap="round" pathLength={100} strokeDasharray="100" className="ludo-timer" style={{ animationDuration: `${LUDO_TURN_SECS}s` }} />
            </svg>
          )}
          {active && p !== 0 && <div className="absolute -bottom-1 -right-1 scale-[.42] origin-bottom-right"><DiceFace v={dice} rolling={rolling} size={56} /></div>}
        </div>
        <div className="min-w-0">
          <div className={`text-[12px] font-semibold truncate max-w-[110px] ${active ? "text-white" : "text-white/70"}`}>{names[p]}{p > 0 && <BotTag />}</div>
          <div className="text-[10px] text-white/50 flex items-center gap-1" style={{ justifyContent: align === "right" ? "flex-end" : undefined }}>
            {[0, 1, 2, 3].map((k) => <span key={k} className="w-1.5 h-1.5 rounded-full" style={{ background: k < home ? pl.color : "rgba(255,255,255,.18)" }} />)}
            <span className="ml-0.5">{home}/4 home</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein" style={{ background: "radial-gradient(120% 70% at 50% 35%, #1d3a8a 0%, #0b1438 60%, #070b22 100%)" }}>
      <Header title="Ludo" sub={`Table #${table} • 4 Players • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="flex justify-between items-center mb-2 px-1">{badge(0, "left")}{badge(1, "right")}</div>

        {/* Board in a wooden frame */}
        <div className="rounded-[22px] p-[2.6%] shadow-[0_18px_40px_rgba(0,0,0,.55)]" style={{ background: "linear-gradient(145deg,#8a5a2b,#5a3416 55%,#3f2410)" }}>
        <div className="relative w-full aspect-square rounded-[14px] overflow-hidden bg-white shadow-[inset_0_0_0_2px_rgba(0,0,0,.25)]">
          {/* track cells */}
          {TRACK.map(([r, c], i) => {
            const startOf = LPLAYERS.find((pl) => pl.start === i);
            const safeOwner = SAFE.has(i) && !startOf ? LPLAYERS[Math.floor(((i + 52 - 8) % 52) / 13)] : null;
            return (
              <div key={i} className="absolute grid place-items-center" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%`, background: startOf ? startOf.color : "#fff", boxShadow: "inset 0 0 0 0.5px #b9c2d0" }}>
                {startOf && <span className="text-white/90 text-[9px] font-black">▶</span>}
                {safeOwner && <Star size={13} fill={safeOwner.color} color={safeOwner.dark} strokeWidth={1.2} />}
              </div>
            );
          })}
          {LPLAYERS.map((pl, p) => (
            <div key={p}>
              {pl.home.map(([r, c], i) => (
                <div key={i} className="absolute" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%`, background: pl.color, boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,.18)" }} />
              ))}
              {/* yard: coloured square, white panel, four token spots */}
              <div className="absolute p-[0.9%]" style={{ top: `${(p === 0 || p === 1 ? 0 : 9) * CELL}%`, left: `${(p === 0 || p === 3 ? 0 : 9) * CELL}%`, width: `${6 * CELL}%`, height: `${6 * CELL}%`, background: `linear-gradient(145deg, ${pl.color}, ${pl.dark})` }}>
                <div className="w-full h-full rounded-[18%] bg-white/95 shadow-[inset_0_2px_6px_rgba(0,0,0,.18)]" />
              </div>
              {pl.yard.map(([r, c], i) => (
                <div key={`s${i}`} className="absolute grid place-items-center" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%` }}>
                  <div className="w-[86%] h-[86%] rounded-full" style={{ background: `radial-gradient(circle at 50% 40%, ${pl.color}55, ${pl.color}22 60%)`, boxShadow: `inset 0 0 0 2px ${pl.color}` }} />
                </div>
              ))}
            </div>
          ))}
          {/* centre: the four home triangles */}
          <div className="absolute" style={{ top: `${6 * CELL}%`, left: `${6 * CELL}%`, width: `${3 * CELL}%`, height: `${3 * CELL}%`, background: `conic-gradient(from 45deg, ${LPLAYERS[2].color} 0 90deg, ${LPLAYERS[3].color} 90deg 180deg, ${LPLAYERS[0].color} 180deg 270deg, ${LPLAYERS[1].color} 270deg 360deg)`, boxShadow: "inset 0 0 10px rgba(0,0,0,.35)" }} />
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
                  <span key={prog} className={`relative block w-full h-full ${prog >= 0 ? "hop" : ""}`}>
                    {glow && <span className="absolute left-1/2 bottom-[8%] -translate-x-1/2 w-[80%] h-[34%] rounded-full pulse-ring" style={{ background: "rgba(255,255,255,.55)" }} />}
                    <svg viewBox="0 0 40 52" className="absolute left-1/2 bottom-[14%] drop-shadow-[0_3px_2px_rgba(0,0,0,.45)]" style={{ width: `${86 * small}%`, height: `${112 * small}%`, transform: `translateX(-50%) scale(${glow ? 1.1 : 1})`, transition: "transform .15s" }}>
                      <defs>
                        <linearGradient id={`pin${p}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
                          <stop offset=".35" stopColor={LPLAYERS[p].color} />
                          <stop offset="1" stopColor={LPLAYERS[p].dark} />
                        </linearGradient>
                      </defs>
                      <path d="M20 50 C9 35 4 27 4 18 A16 16 0 1 1 36 18 C36 27 31 35 20 50 Z" fill={`url(#pin${p})`} stroke="#fff" strokeWidth="2.5" />
                      <circle cx="20" cy="18" r="8" fill="#fff" />
                      <circle cx="20" cy="18" r="4.6" fill={LPLAYERS[p].color} />
                    </svg>
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
        </div>

        <div className="flex justify-between items-center mt-2 px-1">{badge(3, "left")}{badge(2, "right")}</div>

        {/* Your dice */}
        <div className="mt-4 flex flex-col items-center">
          <button onClick={myRoll} disabled={!started || turn !== 0 || rolling || moving || awaitMove} className={`rounded-2xl p-2 active:scale-95 transition-[transform,opacity] ${!started || turn !== 0 || moving || awaitMove ? "opacity-45" : ""} ${started && turn === 0 && !rolling && !moving && !awaitMove ? "pulse-ring" : ""}`} style={{ background: "linear-gradient(145deg,#ef4444,#991b1b)", boxShadow: "0 8px 18px rgba(0,0,0,.45)" }}>
            <DiceFace v={dice} rolling={rolling} size={68} />
          </button>
          <div className="text-sm font-semibold mt-2.5">{started ? (turn === 0 ? (awaitMove ? "Choose a token" : moving ? "Moving…" : rolling ? "Rolling…" : "Tap the dice to roll") : `${names[turn]}'s turn`) : "Waiting to start"}</div>
          <div className="text-xs text-white/60 mt-0.5 text-center min-h-4">{msg}</div>
        </div>
      </div>

      <ResultSheet
        open={winner !== null}
        won={winner === 0}
        title={winner === 0 ? `You won ${inr(Math.floor(buyIn * 4 * keep))}!` : `${winner !== null ? names[winner] : ""} wins`}
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
  const gs = useGameSettings();
  const keep = 1 - feeOf(gs, "chess", 10);
  const pace = botPace(gs, "chess");
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
    if (result === "win") credit(Math.floor(buyIn * 2 * keep), label);
    if (result === "draw") credit(buyIn, label, "Refund");
  };

  const play = (p: Pos, m: Move) => {
    const next = makeMove(p, m);
    if (m.captured !== ".") sfx.capture(); else sfx.move();
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
    }, (450 + Math.random() * 900) * pace);
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
        title={done === "win" ? `${why} — you won ${inr(Math.floor(buyIn * 2 * keep))}!` : done === "draw" ? `${why} — draw, entry refunded` : `${why} — ${opp.name} wins`}
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
// You shoot from the bottom baseline, the opponent from the top. 9 white, 9 black and the red queen.
// Rules:
//   • Striker placement: on your baseline, and each red end-circle is either fully covered or not touched.
//   • Colour claim: the first colour a player pockets is theirs for the board; the other player gets the other.
//   • Streak: pocket your own colour and you shoot again; otherwise the turn passes.
//   • Queen: may be taken once the first coin of the board is gone, and must be covered by pocketing one of
//     your own coins in the same or the next shot; if not, she goes back to the centre. She can't be left for
//     last: pocketing your final coin while the queen is still unsecured is a foul.
//   • Fouls (striker pocketed, or the opponent's coin pocketed without one of yours, or the final coin before
//     the queen): the turn ends, that shot's coins of yours go back, and one of your pocketed coins returns to
//     the centre — if you have none down yet, the penalty is owed and paid with your next pocketed coin.
//     (Pieces can't fly off this board — the frame keeps them in.)
//   • Board: won by pocketing all 9 of your coins with the queen covered. The winner scores 1 point per
//     opponent coin still on the board, +3 if they covered the queen. First to 21 points wins the match.

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
const MATCH_POINTS = 21;
const QUEEN_BONUS = 3;
const END_R = 3.2; // the red circles at both ends of each baseline
const ENDS = [BASE_MIN, BASE_MAX];
type Colour = "w" | "b";
const otherColour = (c: Colour): Colour => (c === "w" ? "b" : "w");
const colourName = (c: Colour | null) => (c === "w" ? "white" : c === "b" ? "black" : "—");

/** Striker placement rule: kept on the baseline, and each red end-circle fully covered or not touched at all. */
function legalX(x: number) {
  const c = Math.max(BASE_MIN, Math.min(BASE_MAX, x));
  for (const e of ENDS) {
    const d = Math.abs(c - e);
    if (d > STRIKER_R - END_R && d < STRIKER_R + END_R) return d < STRIKER_R ? e : e + (e === BASE_MIN ? 1 : -1) * (STRIKER_R + END_R);
  }
  return c;
}

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
function carromStep(ds: Disc[], dt: number, sunk: Disc[], hits?: number[]) {
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
      hits?.push(-rel);
      a.vx -= (j2 / a.m) * nx; a.vy -= (j2 / a.m) * ny;
      b.vx += (j2 / b.m) * nx; b.vy += (j2 / b.m) * ny;
    }
  }
}

/** Distance from point (x, y) to the segment a→b. */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Is the straight path a→b free of other discs for something of radius `rad`? */
function pathClear(ds: Disc[], ax: number, ay: number, bx: number, by: number, rad: number, skip: number) {
  return ds.every((o) => o.sunk || o.k === "s" || o.id === skip || segDist(o.x, o.y, ax, ay, bx, by) > rad + o.r + 0.4);
}

/** A free spot on the baseline (the striker may not sit on a coin). */
const baseFree = (ds: Disc[], x: number, y: number) => ds.every((o) => o.sunk || o.k === "s" || Math.hypot(o.x - x, o.y - y) > o.r + STRIKER_R + 0.3);

/** Play a shot out on a copy of the board and report what went into the pockets. */
function simulate(ds: Disc[], x: number, y: number, vx: number, vy: number): DiscKind[] {
  const copy = ds.map((d) => ({ ...d }));
  Object.assign(copy.find((d) => d.k === "s")!, { x, y, vx, vy, sunk: false });
  const sunk: Disc[] = [];
  for (let i = 0; i < 240 * 7; i++) {
    carromStep(copy, PHYS_DT, sunk);
    if (i % 24 === 0 && copy.every((d) => d.sunk || Math.hypot(d.vx, d.vy) < 0.8)) break;
  }
  return sunk.map((d) => d.k);
}

const gauss = () => Math.random() + Math.random() + Math.random() - 1.5; // ≈ normal, sd 0.5

interface BotCtx { mine: Colour | null; targets: DiscKind[]; queenAllowed: boolean; mustCover: boolean; lastCoinRisk: boolean }

/**
 * Opponent aim. It lines up cut shots onto the coins it may play (its colour, the queen when allowed), keeps
 * the most promising ones, plays each of them out on a copy of the board, and takes the shot that does best
 * under the rules (own coins down, no fouls, covering the queen). Then a small human error on angle and power.
 */
function botShot(ds: Disc[], ctx: BotCtx): { x: number; vx: number; vy: number } {
  const y = BASELINE[1];
  const cands: { score: number; x: number; ang: number; speed: number }[] = [];
  for (const c of ds) {
    if (c.sunk || !ctx.targets.includes(c.k)) continue;
    for (const [px, py] of POCKETS) {
      const cp = Math.hypot(px - c.x, py - c.y);
      const nx = (c.x - px) / cp, ny = (c.y - py) / cp;
      const gx = c.x + nx * (COIN_R + STRIKER_R), gy = c.y + ny * (COIN_R + STRIKER_R);
      const pocketOpen = pathClear(ds, c.x, c.y, px, py, COIN_R, c.id);
      for (let x = BASE_MIN; x <= BASE_MAX; x += 1.5) {
        if (legalX(x) !== x || !baseFree(ds, x, y)) continue;
        const sx = gx - x, sy = gy - y;
        const sg = Math.hypot(sx, sy);
        const cut = (sx * -nx + sy * -ny) / sg; // 1 = straight shot
        if (cut < 0.4 || sy <= 0) continue;
        const open = pocketOpen && pathClear(ds, x, y, gx, gy, STRIKER_R, c.id);
        cands.push({
          score: cut * 2 - (sg + cp) / 120 + (c.k === "q" ? 0.2 : 0) - (open ? 0 : 3),
          x, ang: Math.atan2(sy, sx),
          speed: Math.min(MAX_SPEED * 0.8, 65 + ((sg + cp) * 1.1) / Math.max(0.5, cut)),
        });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const pool = cands.slice(0, 16);
  // Always keep a couple of soft shots at its nearest coin as a fall-back.
  const near = ds.filter((d) => !d.sunk && ctx.targets.includes(d.k) && d.k !== "q").sort((a, b) => Math.abs(a.x - 50) - Math.abs(b.x - 50))[0];
  if (near) for (const dx of [-8, 8]) {
    const x = legalX(near.x + dx);
    if (baseFree(ds, x, y)) pool.push({ score: -1, x, ang: Math.atan2(near.y - y, near.x - x), speed: 110 });
  }
  if (!pool.length) pool.push({ score: -2, x: 50, ang: Math.PI / 2, speed: 120 });

  const value = (kinds: DiscKind[], base: number) => {
    const foul = kinds.includes("s");
    const w = kinds.filter((k) => k === "w").length, b = kinds.filter((k) => k === "b").length;
    const own = ctx.mine ? (ctx.mine === "w" ? w : b) : Math.max(w, b);
    const opp = ctx.mine ? (ctx.mine === "w" ? b : w) : 0;
    const q = kinds.includes("q");
    let v = own * 3 - opp * 2.5 + base * 0.2;
    if (foul) v -= 8;
    if (q) v += ctx.queenAllowed ? (own > 0 ? 6 : 2) : -1;
    if (ctx.mustCover) v += own > 0 ? 5 : -4;
    if (ctx.lastCoinRisk && own > 0 && !q && !ctx.mustCover) v -= 12; // would pocket the final coin before the queen
    if (ctx.mine && opp > 0 && own === 0) v -= 6; // wrong-coin foul
    return v;
  };
  let best = { v: -Infinity, x: 50, vx: 0, vy: 120 };
  for (const c of pool) {
    for (const f of [1, 0.85, 1.15]) {
      const vx = Math.cos(c.ang) * c.speed * f, vy = Math.sin(c.ang) * c.speed * f;
      const v = value(simulate(ds, c.x, y, vx, vy), c.score);
      if (v > best.v) best = { v, x: c.x, vx, vy };
    }
  }
  // Human touch: a little error on angle and power.
  const ang = Math.atan2(best.vy, best.vx) + gauss() * 0.022;
  const sp = Math.hypot(best.vx, best.vy) * (1 + gauss() * 0.05);
  return { x: best.x, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp };
}

/** Put a returned coin back on the board: the centre, or the nearest free spot around it. */
function toCentre(ds: Disc[], d: Disc) {
  const free = (x: number, y: number) => ds.every((o) => o === d || o.sunk || Math.hypot(o.x - x, o.y - y) > o.r + d.r + 0.3);
  const spots: [number, number][] = [[50, 50]];
  for (const rad of [6.3, 12.4, 18.6]) for (let a = 0; a < 12; a++) spots.push([50 + rad * Math.cos((a * Math.PI) / 6), 50 + rad * Math.sin((a * Math.PI) / 6)]);
  const [x, y] = spots.find(([x, y]) => free(x, y)) ?? [50, 50];
  Object.assign(d, { x, y, vx: 0, vy: 0, sunk: false });
}

interface CarromRules {
  colours: [Colour | null, Colour | null]; // claimed by the first coin each player pockets
  debt: [number, number];                  // penalty coins owed (fouled with nothing pocketed)
  queenDue: number | null;                 // who must cover the queen with the next shot
  queenBy: number | null;                  // who covered the queen this board
  firstGone: boolean;                      // has any coin been pocketed this board?
}
const freshRules = (): CarromRules => ({ colours: [null, null], debt: [0, 0], queenDue: null, queenBy: null, firstGone: false });

function Carrom({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const gs = useGameSettings();
  const keep = 1 - feeOf(gs, "carrom", 10);
  const pace = botPace(gs, "carrom");
  const { total, debit, credit, showToast } = useStore();
  const discs = useRef<Disc[]>(rackCarrom());
  const [, setFrame] = useState(0);
  const redraw = () => setFrame((f) => f + 1);
  const [phase, setPhase] = useState<"wait" | "aim" | "moving" | "bot" | "between">("wait");
  const [who, setWho] = useState(0); // 0 you, 1 the opponent
  const [points, setPoints] = useState([0, 0]); // match points, first to 21
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const [boardNo, setBoardNo] = useState(1);
  const breaker = useRef(0);
  const rules = useRef<CarromRules>(freshRules());
  const [msg, setMsg] = useState("");
  const [pull, setPull] = useState<{ dx: number; dy: number } | null>(null); // aim vector (board units)
  const [botAim, setBotAim] = useState<{ dx: number; dy: number } | null>(null); // the opponent's line, shown before it shoots
  const [done, setDone] = useState<null | boolean>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const label = `Carrom • Table #${table}`;
  const [opp, setOpp] = useState<Bot>(() => pickBots(1)[0]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const striker = () => discs.current.find((d) => d.k === "s")!;

  const placeStriker = (p: number, x = 50) => {
    const s = striker();
    Object.assign(s, { x: legalX(x), y: BASELINE[p], vx: 0, vy: 0, sunk: false });
  };

  /** Run the physics until everything stops, then apply the rules to the shot. */
  const shoot = (vx: number, vy: number, p: number) => {
    const s = striker();
    s.vx = vx; s.vy = vy;
    sfx.strike();
    setPhase("moving");
    setPull(null);
    const sunk: Disc[] = [];
    let last = performance.now(), acc = 0;
    const loop = (t: number) => {
      if (!alive.current) return;
      acc += Math.min(0.25, (t - last) / 1000); // keep real time even if frames drop
      last = t;
      const before = sunk.length;
      const hits: number[] = [];
      while (acc >= PHYS_DT) { carromStep(discs.current, PHYS_DT, sunk, hits); acc -= PHYS_DT; }
      if (hits.length) { const h = Math.max(...hits); if (h > 12) sfx.knock(h / MAX_SPEED); }
      if (sunk.length > before) sfx.pocket();
      redraw();
      const still = discs.current.every((d) => d.sunk || Math.hypot(d.vx, d.vy) < 0.8);
      if (!still) return void requestAnimationFrame(loop);
      for (const d of discs.current) { d.vx = 0; d.vy = 0; }
      settle(p, sunk);
    };
    requestAnimationFrame(loop);
  };

  const settle = (p: number, sunk: Disc[]) => {
    const ds = discs.current;
    const st = rules.current;
    const name = p === 0 ? "You" : opp.name;
    const queen = ds.find((d) => d.k === "q")!;
    const strikerFoul = sunk.some((d) => d.k === "s");
    const coins = sunk.filter((d) => d.k === "w" || d.k === "b");
    const queenNow = sunk.some((d) => d.k === "q");
    const notes: string[] = [];

    // Colour claim: the first colour pocketed (on a clean shot) is yours for the board.
    if (!st.colours[p] && coins.length && !strikerFoul) {
      const c = coins[0].k as Colour;
      st.colours[p] = c;
      st.colours[1 - p] = otherColour(c);
      notes.push(`${name} ${p === 0 ? "play" : "plays"} ${colourName(c)}`);
    }
    const mine = st.colours[p];
    const own = mine ? coins.filter((d) => d.k === mine) : [];
    const opps = mine ? coins.filter((d) => d.k === otherColour(mine)) : [];
    const firstGoneBefore = st.firstGone;
    if (coins.length) st.firstGone = true;
    const ownLeft = mine ? ds.filter((d) => d.k === mine && !d.sunk).length : 9;
    const coversNow = own.length > 0 && (queenNow || st.queenDue === p);

    let foul: string | null = null;
    if (strikerFoul) foul = "pocketed the striker";
    else if (mine && opps.length && !own.length) foul = "pocketed the opponent's coin";
    else if (mine && own.length && ownLeft === 0 && st.queenBy === null && !coversNow) foul = "pocketed the last coin before the queen";

    let again = false;
    if (foul) {
      // The turn ends; this shot's coins of yours (and an uncovered queen) go back, plus one penalty coin.
      (mine ? own : coins).forEach((d) => toCentre(ds, d));
      if (queenNow || st.queenDue === p) toCentre(ds, queen);
      st.queenDue = null;
      const pen = mine ? ds.find((d) => d.k === mine && d.sunk) : undefined;
      if (pen) { toCentre(ds, pen); notes.push(`${name} ${foul} — foul, a coin goes back`); }
      else { st.debt[p] += 1; notes.push(`${name} ${foul} — foul, penalty owed`); }
      if (opps.length) notes.push(`${opps.length} ${colourName(otherColour(mine!))} down for ${p === 0 ? opp.name : "you"}`);
    } else {
      if (queenNow) {
        if (!firstGoneBefore && !coins.length) { toCentre(ds, queen); notes.push("Queen can't go before the first coin — back to the centre"); }
        else if (own.length || (mine && ownLeft === 0)) { st.queenBy = p; st.queenDue = null; notes.push(`${name} pocketed and covered the queen!`); }
        else { st.queenDue = p; notes.push(`${name} pocketed the queen — cover it with the next shot`); }
      } else if (st.queenDue === p) {
        if (own.length) { st.queenBy = p; notes.push(`${name} covered the queen!`); }
        else { toCentre(ds, queen); notes.push("Queen not covered — back to the centre"); }
        st.queenDue = null;
      }
      // Owed penalties are paid with the coins just pocketed.
      while (st.debt[p] > 0 && mine) {
        const c = ds.find((d) => d.k === mine && d.sunk);
        if (!c) break;
        toCentre(ds, c);
        st.debt[p] -= 1;
        notes.push("owed penalty paid");
      }
      if (!notes.length) notes.push(own.length ? `${name} pocketed ${own.length} coin${own.length > 1 ? "s" : ""}!` : p === 0 ? "No pocket" : `${opp.name} missed`);
      again = own.length > 0 || st.queenDue === p;
    }
    setMsg(notes.join(" • "));

    // Board over? All of a player's coins down with the queen covered.
    for (const w of [p, 1 - p]) {
      const c = st.colours[w];
      if (c && st.queenBy !== null && !ds.some((d) => d.k === c && !d.sunk)) return boardWon(w);
    }
    const next = again ? p : 1 - p;
    placeStriker(next);
    setWho(next);
    redraw();
    if (next === 0) setPhase("aim");
    else botTurn();
  };

  const boardWon = (w: number) => {
    const ds = discs.current;
    const st = rules.current;
    const loserColour = st.colours[1 - w];
    const left = ds.filter((d) => d.k === loserColour && !d.sunk).length;
    const gain = Math.max(1, left + (st.queenBy === w ? QUEEN_BONUS : 0));
    const pts = [...pointsRef.current];
    pts[w] = Math.min(MATCH_POINTS, pts[w] + gain);
    setPoints(pts);
    pointsRef.current = pts;
    const name = w === 0 ? "You" : opp.name;
    if (pts[w] >= MATCH_POINTS) {
      setMsg(`${name} won the board (+${gain}) and the match!`);
      setDone(w === 0);
      setPhase("wait");
      if (w === 0) credit(Math.floor(buyIn * 2 * keep), label);
      return;
    }
    setMsg(`${name} won board ${boardNo} (+${gain}) — ${pts[0]} : ${pts[1]}. Next board…`);
    setPhase("between");
    window.setTimeout(() => {
      if (!alive.current) return;
      discs.current = rackCarrom();
      rules.current = freshRules();
      breaker.current = 1 - breaker.current;
      setBoardNo((n) => n + 1);
      const b = breaker.current;
      placeStriker(b);
      setWho(b);
      redraw();
      setMsg(b === 0 ? "New board — your break" : `New board — ${opp.name} breaks`);
      if (b === 0) setPhase("aim");
      else botTurn();
    }, 2800);
  };

  // The opponent takes its time like a person: looks at the board, slides the striker over, lines the shot up
  // (you see its aim), then shoots.
  const botTurn = () => {
    setPhase("bot");
    const look = (1400 + Math.random() * 1400 + (Math.random() < 0.2 ? 1200 : 0)) * pace;
    window.setTimeout(() => {
      if (!alive.current) return;
      const ds = discs.current;
      const st = rules.current;
      const mine = st.colours[1];
      const queenOn = !ds.find((d) => d.k === "q")!.sunk;
      const mustCover = st.queenDue === 1;
      const queenAllowed = st.firstGone && queenOn && st.queenBy === null && !mustCover;
      const ownLeft = mine ? ds.filter((d) => d.k === mine && !d.sunk).length : 9;
      const lastCoinRisk = ownLeft === 1 && st.queenBy === null && !mustCover;
      const targets: DiscKind[] = mine ? (lastCoinRisk && queenAllowed ? [] : [mine]) : ["w", "b"];
      if (queenAllowed) targets.push("q");
      if (!targets.length) targets.push(mine ?? "b");
      const shot = botShot(ds, { mine, targets, queenAllowed, mustCover, lastCoinRisk });
      placeStriker(1, shot.x); // slides across (CSS transition while phase is "bot")
      redraw();
      window.setTimeout(() => {
        if (!alive.current) return;
        setBotAim({ dx: shot.vx, dy: shot.vy });
        window.setTimeout(() => {
          if (!alive.current) return;
          setBotAim(null);
          shoot(shot.vx, shot.vy, 1);
        }, (800 + Math.random() * 600) * pace);
      }, 1000 * pace);
    }, look);
  };

  // Finger controls, like carrom apps:
  //   • touch the striker (or anywhere on your baseline) and slide sideways to place it;
  //   • pull back from the striker — or drag back from anywhere on the board — and let go to shoot.
  //     The further you pull, the harder the shot; the dotted line shows where it will go.
  const grip = useRef<{ mode: "slide" | "aim"; sx: number; sy: number; fromStriker: boolean } | null>(null);
  const toBoard = (e: React.PointerEvent) => {
    const r = boardRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100];
  };
  const slideTo = (x: number) => { placeStriker(0, x); redraw(); };
  const onDown = (e: React.PointerEvent) => {
    if (phase !== "aim" || done !== null) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = toBoard(e);
    const s = striker();
    const onStriker = Math.hypot(x - s.x, y - s.y) <= STRIKER_R * 2.4;
    const onBaseline = Math.abs(y - BASELINE[0]) <= 5;
    if (onStriker || onBaseline) {
      if (!onStriker) slideTo(x); // tap the baseline to move the striker there
      grip.current = { mode: "slide", sx: x, sy: y, fromStriker: true };
    } else {
      grip.current = { mode: "aim", sx: x, sy: y, fromStriker: false };
    }
    setPull(null);
  };
  const onMove = (e: React.PointerEvent) => {
    const gp = grip.current;
    if (!gp || phase !== "aim") return;
    const [x, y] = toBoard(e);
    const s = striker();
    if (gp.mode === "slide") {
      // Pulled away from the baseline (down, behind the striker): switch to aiming from the striker.
      if (Math.abs(y - BASELINE[0]) > 6) { gp.mode = "aim"; }
      else { slideTo(x); return; }
    }
    setPull(gp.fromStriker ? { dx: s.x - x, dy: s.y - y } : { dx: gp.sx - x, dy: gp.sy - y });
  };
  const onUp = () => {
    const gp = grip.current;
    grip.current = null;
    if (!gp || gp.mode !== "aim" || !pull || phase !== "aim") return setPull(null);
    const len = Math.hypot(pull.dx, pull.dy);
    const power = Math.min(1, len / 32);
    if (power < 0.08) return setPull(null);
    const s = striker();
    if (!baseFree(discs.current, s.x, s.y)) { setPull(null); return setMsg("The striker is on a coin — slide it to a clear spot"); }
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
    rules.current = freshRules();
    breaker.current = 0;
    setBoardNo(1);
    setBotAim(null);
    setPoints([0, 0]);
    pointsRef.current = [0, 0];
    setDone(null);
    setWho(0);
    setPull(null);
    setMsg("Your break — slide the striker, then pull back and let go");
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
  const st = rules.current;
  const dot = (c: Colour | null) => c === "w" ? "bg-white" : c === "b" ? "bg-stone-900 border border-white/40" : "bg-transparent border border-dashed border-white/40";
  const queenState = st.queenBy !== null ? `covered by ${st.queenBy === 0 ? "you" : opp.name}` : st.queenDue !== null ? "to be covered" : coinsLeft("q") ? "on board" : "—";

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Carrom" sub={`Table #${table} • First to ${MATCH_POINTS} points • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="flex items-center justify-between card px-4 py-2.5">
          <div className={`flex items-center gap-2 ${who === 0 && started ? "" : "opacity-60"}`}><Avatar size={30} /><span className="text-sm">You <span className={`inline-block w-2.5 h-2.5 rounded-full align-middle ml-0.5 ${dot(st.colours[0])}`} /></span><b className="text-neon-400 ml-1">{points[0]}</b></div>
          <div className="text-center leading-tight"><div className="text-[10px] text-white/50">Board {boardNo}</div><div className="text-[10px] text-white/40">to {MATCH_POINTS}</div></div>
          <div className={`flex items-center gap-2 ${who === 1 && started ? "" : "opacity-60"}`}><b className="text-rose-400 mr-1">{points[1]}</b><span className="text-sm">{opp.name}<BotTag /> <span className={`inline-block w-2.5 h-2.5 rounded-full align-middle ${dot(st.colours[1])}`} /></span><Avatar emoji={opp.emoji} size={30} /></div>
        </div>
        <div className="relative mt-3 aspect-square rounded-2xl p-[5%] shadow-2xl select-none" style={{ background: "linear-gradient(135deg,#5b3417,#3b2412)" }}>
          <div
            ref={boardRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => { grip.current = null; setPull(null); }}
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
            {BASELINE.flatMap((y) => ENDS.map((x) => (
              <div key={`${x}-${y}`} className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 border border-[#7f1d1d]" style={{ left: `${x}%`, top: `${y}%`, width: `${END_R * 2}%`, height: `${END_R * 2}%`, background: "#dc2626cc" }} />
            )))}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[30%] h-[30%] rounded-full border-2 border-[#8b5a2b]/60" />

            {/* aim guide */}
            {pull && power >= 0.08 && (
              <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none">
                <line x1={s.x} y1={s.y} x2={s.x + dir[0] * 70} y2={s.y + dir[1] * 70} stroke="rgba(255,255,255,.55)" strokeWidth=".5" strokeDasharray="1.5 1.5" />
                <line x1={s.x} y1={s.y} x2={s.x - dir[0] * power * 16} y2={s.y - dir[1] * power * 16} stroke={power > 0.75 ? "#ef4444" : power > 0.4 ? "#f59e0b" : "#22c55e"} strokeWidth="1.4" strokeLinecap="round" />
                <circle cx={s.x} cy={s.y} r={STRIKER_R + 1 + power * 3} fill="none" stroke="rgba(255,255,255,.5)" strokeWidth=".4" />
              </svg>
            )}

            {botAim && (() => {
              const l = Math.hypot(botAim.dx, botAim.dy) || 1;
              const pw = Math.min(1, l / MAX_SPEED);
              return (
                <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none fadein">
                  <line x1={s.x} y1={s.y} x2={s.x + (botAim.dx / l) * 70} y2={s.y + (botAim.dy / l) * 70} stroke="rgba(0,0,0,.35)" strokeWidth=".5" strokeDasharray="1.5 1.5" />
                  <line x1={s.x} y1={s.y} x2={s.x - (botAim.dx / l) * pw * 16} y2={s.y - (botAim.dy / l) * pw * 16} stroke={pw > 0.75 ? "#ef4444" : pw > 0.4 ? "#f59e0b" : "#22c55e"} strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              );
            })()}

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
                  transition: d.sunk ? "transform .25s ease-in, opacity .25s ease-in" : d.k === "s" && phase === "bot" ? "transform 1s ease-in-out" : "none",
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
            {phase === "aim" ? (st.queenDue === 0 ? "Cover the queen: pocket one of your coins now" : "Your turn: slide the striker with your finger, then pull back and let go") : phase === "moving" ? "…" : phase === "bot" ? `${opp.name} is lining up a shot` : ""}
          </div>
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] text-white/45">
            <span>You: {colourName(st.colours[0])}{st.colours[0] ? ` (${coinsLeft(st.colours[0])} left)` : ""}</span>
            <span>{opp.name}: {colourName(st.colours[1])}{st.colours[1] ? ` (${coinsLeft(st.colours[1])} left)` : ""}</span>
            <span>Queen: {queenState}</span>
            {(st.debt[0] > 0 || st.debt[1] > 0) && <span>Penalty owed: you {st.debt[0]} • {opp.name} {st.debt[1]}</span>}
          </div>
        </div>
      </div>
      <ResultSheet open={done !== null} won={!!done} title={done ? `You won ${inr(Math.floor(buyIn * 2 * keep))}!` : `${opp.name} wins`} sub={`Match ${points[0]} : ${points[1]}`} left={nextIn} onLeave={nav.back} onClose={() => {}} />
    </div>
  );
}
