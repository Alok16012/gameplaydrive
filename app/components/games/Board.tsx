"use client";

import { clearActive, dropSnap, loadSnap, markActive, saveSnap } from "../../lib/rejoin";
import { sfx, vibrate } from "../../lib/sound";
import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { inr, type GameId } from "../../lib/data";
import { pickBots, type Bot } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money } from "../ui";
import { BotTag, NEXT_GAME_SECS, ResultSheet, useAutoNext } from "./bots";
import type { Nav, Route } from "../nav";
import { botPace, feeOf, useGameSettings } from "../../lib/gameConfig";
import { bestMove, inCheck, kingSquare, legalMoves, makeMove, startPos, status as chessStatus, type Move, type Pos } from "../../lib/chess";

export function BoardGame({ nav, gameId, table, buyIn, players }: { nav: Nav; gameId: GameId; table: string; buyIn: number; players?: 2 | 4 }) {
  if (gameId === "ludo") return <Ludo nav={nav} table={table} buyIn={buyIn} players={players} />;
  return <Chess nav={nav} table={table} buyIn={buyIn} />;
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

export const LPLAYERS: LP[] = [
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

export function DiceFace({ v, size = 56, rolling }: { v: number; size?: number; rolling?: boolean }) {
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
export const LUDO_TURN_SECS = 20; // each player's turn; when yours runs out the game rolls and moves for you
const BOT_STEP_MS = 320; // bots walk their tokens a little slower, like a person tapping square by square
const ROLL_MS = 560;
/** A human-looking pause: usually between a and b ms, now and then a longer think. */
/** Bot pacing from the admin's "bot speed" setting (1 = normal); set by each table on mount. */
let PACE = 1;
const think = (a: number, b: number) => sleep((a + Math.random() * (b - a) + (Math.random() < 0.15 ? 700 + Math.random() * 900 : 0)) * PACE);

function Ludo({ nav, table, buyIn, players = 4 }: { nav: Nav; table: string; buyIn: number; players?: 2 | 4 }) {
  // Seats in play: all four colours, or (2 players) you on red against yellow, across the board.
  const SEATS = players === 2 ? [0, 2] : [0, 1, 2, 3];
  const inPlay = (p: number) => SEATS.includes(p);
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
  const namesRef = useRef(names);
  namesRef.current = names;
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

  // Rejoin: the game is saved on this phone at every settled point (and right after you roll), so leaving the
  // screen and coming back carries on from there — same tokens, same dice, entry not charged again.
  const snapKey = `ludo:${table}:${buyIn}:${players}`;
  const route: Route = { name: "board", game: "ludo", table, buyIn, players };
  interface LudoSnap { tokens: number[][]; turn: number; dice: number; awaitMove: boolean; names: string[] }
  const snap = (over: Partial<LudoSnap> = {}) =>
    saveSnap<LudoSnap>(snapKey, { tokens: tokRef.current, turn, dice, awaitMove, names: namesRef.current, ...over });
  useEffect(() => {
    if (!started || winner !== null || rolling || moving || over.current) return;
    snap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, winner, rolling, moving, tokens, turn, dice, awaitMove, names]);
  const resumed = useRef(false); // once only (React may run mount effects twice in development)
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const sn = loadSnap<LudoSnap>(snapKey);
    if (!sn) return;
    gameNo.current += 1;
    over.current = false;
    games.current = 1;
    namesRef.current = sn.names;
    setNames(sn.names);
    setT(sn.tokens);
    setTurn(sn.turn);
    setDice(sn.dice);
    setAwaitMove(sn.turn === 0 && sn.awaitMove);
    setStarted(true);
    startClock(sn.turn);
    if (sn.turn === 0) setMsg(sn.awaitMove ? `Welcome back — you rolled ${sn.dice}, tap a glowing token` : "Welcome back — your turn, roll the dice");
    else { setMsg("Welcome back"); window.setTimeout(() => botPlay(sn.turn), 700); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      for (const q of SEATS) {
        if (q === p) continue;
        t[q].forEach((op, j) => {
          if (absIdx(q, op) === a) {
            t[q][j] = -1;
            hit = true;
            setMsg(`${namesRef.current[p]} captured ${namesRef.current[q]}'s token!`);
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
    dropSnap(snapKey);
    clearActive(route);
    if (p === 0) credit(Math.floor(buyIn * SEATS.length * keep), label);
  };

  const nextTurn = (from: number) => {
    if (over.current || !alive.current) return;
    const n = SEATS[(SEATS.indexOf(from) + 1) % SEATS.length];
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
      setMsg(`${namesRef.current[p]} rolled three 6s — turn skipped`);
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
    setMsg(`${namesRef.current[p]}'s turn`);
    await think(1500, 3200); // picks up the dice
    if (!alive.current || over.current || g !== gameNo.current) return;
    const d = await roll(p);
    if (g !== gameNo.current) return;
    if (d < 0) return nextTurn(p);
    const opts = movable(p, d);
    if (!opts.length) {
      setMsg(`${namesRef.current[p]} rolled ${d} — no move`);
      await sleep(1100);
      return nextTurn(p);
    }
    setMsg(`${namesRef.current[p]} rolled ${d}`);
    await think(opts.length > 1 ? 1300 : 700, opts.length > 1 ? 3000 : 1500); // decides which token to move
    const pick = pickToken(p, d, opts);
    setMsg(`${namesRef.current[p]} rolled ${d}`);
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
    snap({ dice: d, awaitMove: true }); // rolled: leaving now can't buy a re-roll
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
    snap({ dice: d, awaitMove: true });
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
    markActive(route, `Ludo ${players === 2 ? "1 vs 1" : "4 players"} • Table #${table}`);
    setMsg("Your turn — roll the dice");
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(winner !== null, NEXT_GAME_SECS, start);
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
      <Header title="Ludo" sub={`Table #${table} • ${players === 2 ? "1 vs 1" : "4 Players"} • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="flex justify-between items-center mb-2 px-1 min-h-[46px]">{badge(0, "left")}{inPlay(1) && badge(1, "right")}</div>

        <LudoBoardSurface
          tokens={tokens}
          inPlay={inPlay}
          glowAt={(p, i) => p === 0 && myOpts.includes(i)}
          onTap={tapToken}
          overlay={!started && (
            <div className="absolute inset-0 bg-black/55 grid place-items-center z-30">
              <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
            </div>
          )}
        />

        <div className="flex justify-between items-center mt-2 px-1 min-h-[46px]">{inPlay(3) ? badge(3, "left") : <span />}{badge(2, "right")}</div>

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
        title={winner === 0 ? `You won ${inr(Math.floor(buyIn * SEATS.length * keep))}!` : `${winner !== null ? names[winner] : ""} wins`}
        left={nextIn}
        onLeave={nav.back}
        onClose={() => {}}
      />
    </div>
  );
}

const CELL = 100 / 15;

/** The Ludo board with its tokens (shared by the practice table and the online private table). */
export function LudoBoardSurface({ tokens, inPlay, glowAt, onTap, overlay }: {
  tokens: number[][]; inPlay: (p: number) => boolean; glowAt: (p: number, i: number) => boolean; onTap: (p: number, i: number) => void; overlay?: React.ReactNode;
}) {
  return (
    <>
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
            !inPlay(p) ? null : row.map((prog, i) => {
              const [r, c] = cellOf(p, prog, i);
              const glow = glowAt(p, i);
              // Tokens sharing a square fan out a little so each stays visible.
              const same = prog >= 0 && prog < 56 ? tokens.flatMap((rw, q) => rw.map((x, j) => ({ q, j, x }))).filter((o) => cellOf(o.q, o.x, o.j)[0] === r && cellOf(o.q, o.x, o.j)[1] === c) : [];
              const k = same.findIndex((o) => o.q === p && o.j === i);
              const shift = same.length > 1 ? (k - (same.length - 1) / 2) * 22 : 0;
              const small = same.length > 1 ? 0.8 : 1;
              return (
                <button
                  key={`${p}-${i}`}
                  onClick={() => onTap(p, i)}
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
          {overlay}
        </div>
        </div>
    </>
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

  // Computer's turn: it takes its time like a person playing 10-minute blitz (see chessThinkMs), then plays.
  const botMoves = useRef(0);
  useEffect(() => {
    if (!started || white || done !== null) return;
    const g = gameNo.current;
    const wait = chessThinkMs(pos, last, botMoves.current, clock[1]) * pace;
    let t2 = 0;
    // Work the move out first (iterative deepening, up to ~1 s), then play it when the "thinking" time is up.
    const t = setTimeout(() => {
      if (g !== gameNo.current) return;
      const began = Date.now();
      const m = bestMove(pos, { ms: Math.min(1100, Math.max(300, wait - 200)), variety: botMoves.current < 4 });
      const rest = Math.max(0, wait - 60 - (Date.now() - began));
      t2 = window.setTimeout(() => {
        if (g !== gameNo.current) return;
        botMoves.current += 1;
        if (m) play(pos, m);
      }, rest);
    }, 60);
    return () => { clearTimeout(t); clearTimeout(t2); };
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
    botMoves.current = 0;
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

/**
 * How long the computer spends on a chess move, in ms — like a person at 10-minute blitz: quick in the opening,
 * on forced moves and on obvious recaptures, longer in the middle game with the odd long think, longer when in
 * check, and faster as its own clock runs down.
 */
function chessThinkMs(pos: Pos, last: Move | null, played: number, clockLeft: number) {
  const between = (a: number, b: number) => a + Math.random() * (b - a);
  const n = legalMoves(pos).length;
  let s: number;
  if (n <= 1) s = between(0.8, 2);
  else if (inCheck(pos, pos.turn)) s = between(3, 8);
  else if (last && last.captured !== "." && Math.random() < 0.55) s = between(1.5, 4); // takes back
  else if (played < 4) s = between(1, 3.5); // opening moves it knows
  else {
    const r = Math.random();
    s = r < 0.6 ? between(3, 9) : r < 0.9 ? between(8, 16) : between(15, 28);
  }
  return Math.max(800, Math.min(s, Math.max(1.2, clockLeft / 20)) * 1000);
}

function PlayerBar({ name, emoji, time, active, bot }: { name: string; emoji: string; time: string; active: boolean; bot?: boolean }) {
  return (
    <div className="flex items-center gap-3 card px-3 py-2">
      <Avatar emoji={emoji} size={34} />
      <div className="flex-1 text-sm font-medium leading-tight">
        {name}{bot && <BotTag />}
        {bot && active && <div className="text-[11px] font-normal text-white/50">thinking<span className="inline-block w-4 text-left animate-pulse">…</span></div>}
      </div>
      <div className={`font-mono text-sm px-2.5 py-1 rounded-lg ${active ? "bg-white text-slate-900" : "bg-white/10 text-white/60"}`}>{time}</div>
    </div>
  );
}
