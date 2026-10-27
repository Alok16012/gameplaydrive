"use client";

import { REJOIN_MS, clearActive, dropSnap, loadSnap, markActive, saveSnap, snapAge } from "../../lib/rejoin";
import { sfx } from "../../lib/sound";
import { useEffect, useRef, useState } from "react";
import { LogOut, Star } from "lucide-react";
import { inr, type GameId } from "../../lib/data";
import { pickBots, type Bot } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money } from "../ui";
import { BotTag, NEXT_GAME_SECS, ResultSheet, useAutoNext } from "./bots";
import type { Nav, Route } from "../nav";
import { botPace, feeOf, useGameSettings } from "../../lib/gameConfig";
import { analyse, assess, bestMove, classify, inCheck, kingSquare, legalMoves, makeMove, materialEdge, posKey, san, startPos, status as chessStatus, type Move, type MoveClass, type Pos } from "../../lib/chess";
import { ChessPiece } from "./ChessPieces";
import { supabase } from "../../lib/supabase";

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
/** Quarter turns (clockwise) that bring colour `me`'s yard to the bottom-left corner, where the player always sits. */
export const ludoTurns = (me: number) => (7 - me) % 4;
/** The colour whose yard shows in a screen corner (0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left) once the
 *  board is turned. */
export const ludoColourAt = (corner: number, turns: number) => (corner - turns + 4) % 4;
/** Top-left of a size×size box at (r, c) after turning the board `turns` quarter turns clockwise. */
function turnCell(r: number, c: number, turns: number, size = 1): [number, number] {
  for (let k = 0; k < turns; k++) [r, c] = [c, 15 - r - size];
  return [r, c];
}
const absIdx = (p: number, prog: number) => (prog >= 0 && prog <= 50 ? (LPLAYERS[p].start + prog) % 52 : -1);
/** Does colour p's token at progress `prog` stand on a safe (star or start) square? */
export const ludoOnSafe = (p: number, prog: number) => { const a = absIdx(p, prog); return a >= 0 && SAFE.has(a); };

/**
 * Which token to move, the way a player picks (same as ld_best on the server): a capture, then getting a token
 * home, then bringing a new token out on a 6, getting out of reach / onto a safe square, and only then the token
 * that is furthest along — so a 6 doesn't just push the one token that is already out.
 */
function ludoPick(t: number[][], seats: number[], p: number, d: number, opts: number[]): number {
  const rivals = seats.filter((q) => q !== p);
  // Could an opponent land on square a with their next roll?
  const threat = (a: number) => a >= 0 && !SAFE.has(a) && rivals.some((q) => t[q].some((op) => {
    const gap = (a - absIdx(q, op) + 52) % 52;
    return op >= 0 && op <= 50 && gap >= 1 && gap <= 6 && op + gap <= 50;
  }));
  const hit = (a: number) => a >= 0 && !SAFE.has(a) && rivals.some((q) => t[q].some((op) => absIdx(q, op) === a));
  const out = t[p].filter((x) => x >= 0 && x < 56).length;
  let best = opts[0], bestScore = -Infinity;
  for (const i of opts) {
    const from = t[p][i];
    const to = from === -1 ? 0 : from + d;
    const a = absIdx(p, to);
    let s = to / 10 + Math.random() * 2; // a little variety, never enough to override a real reason
    if (hit(a)) s += 100;
    if (to === 56) s += 80;
    if (from === -1) s += 60 - 10 * out;
    if (from <= 50 && to >= 51 && to <= 55) s += 30; // into the home column (not just shuffling inside it)
    if (a >= 0 && SAFE.has(a)) s += 15;
    if (from >= 0 && from <= 50 && threat(absIdx(p, from)) && !threat(a)) s += 40;
    if (threat(a)) s -= 45;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

async function fetchOutcomeMode(gameId: string): Promise<"fair" | "force_win" | "force_loss"> {
  try {
    const { data: rpcMode, error: rpcErr } = await supabase().rpc("my_outcome_mode", { p_game: gameId });
    if (!rpcErr && rpcMode && ["fair", "force_win", "force_loss"].includes(rpcMode)) {
      return rpcMode as "fair" | "force_win" | "force_loss";
    }
  } catch {}

  try {
    const { data: userRes } = await supabase().auth.getUser();
    const uid = userRes?.user?.id;
    const { data: row } = await supabase().from("app_settings").select("value").eq("key", "outcome_control").maybeSingle();
    const ctrl = row?.value as any;
    if (ctrl) {
      if (uid && ctrl.players?.[uid] && ["fair", "force_win", "force_loss"].includes(ctrl.players[uid])) {
        return ctrl.players[uid];
      }
      if (ctrl.games?.[gameId] && ["fair", "force_win", "force_loss"].includes(ctrl.games[gameId])) {
        return ctrl.games[gameId];
      }
      if (ctrl.global_mode && ["fair", "force_win", "force_loss"].includes(ctrl.global_mode)) {
        return ctrl.global_mode;
      }
    }
  } catch {}

  return "fair";
}

/** How hard the outcome mode leans on the dice (see diceWeights). */
const LEAN = { capture: 1.7, score: 1.6, open: 1.35, stuck: 1.5 };

/**
 * Ludo dice against bots under the admin's outcome control. Fair is a plain 1–6. force_win / force_loss only tilt
 * the odds of each face — every number can still come up on every roll, so nobody can see the dice "knowing" what
 * they need: the favoured side is somewhat more likely to roll a capture, a token home or a 6 to open, the other
 * side somewhat less (and more often rolls a number with no move). The old picker handed out the exact capture /
 * home number most of the time: under force_loss a bot that could capture rolled it ~70% of the time and a game
 * had ~45 captures each way instead of ~6, which players saw as a pattern. Sixes after a six stay at 1 in 6.
 */
function pickOutcomeDice(p: number, t: number[][], seats: number[], mode: "fair" | "force_win" | "force_loss", streak = 0): number {
  if (mode === "fair") return 1 + Math.floor(Math.random() * 6);
  const w = diceWeights(p, t, seats, mode);
  if (streak >= 1) w[5] = Math.min(w[5], w.reduce((a, b) => a + b, 0) / 6); // a 6 after a 6: no more than a real dice
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < 6; k++) if ((r -= w[k]) < 0) return k + 1;
  return 6;
}

/** Weight of each face 1..6 for p's roll. The player is seat 0; bots' captures that matter are of the player. */
function diceWeights(p: number, t: number[][], seats: number[], mode: "force_win" | "force_loss"): number[] {
  const helped = (mode === "force_win") === (p === 0); // does this roll lean the roller's way?
  const targets = p === 0 ? seats.filter((q) => q !== 0) : [0];
  const mine = t[p];
  const homeNow = mine.filter((x) => x === 56).length;
  const lean = (f: number) => (helped ? f : 1 / f);
  return [1, 2, 3, 4, 5, 6].map((d) => {
    let w = 1;
    const captures = mine.some((from) => {
      if (from < 0 || from + d > 50) return false;
      const a = absIdx(p, from + d);
      return !SAFE.has(a) && targets.some((q) => t[q].some((op) => absIdx(q, op) === a));
    });
    const scores = mine.some((from) => from >= 0 && from + d === 56);
    const opens = d === 6 && mine.some((x) => x === -1);
    const moves = mine.some((from) => (from === -1 && d === 6) || (from >= 0 && from + d <= 56));
    if (captures) w *= lean(LEAN.capture);
    // The player's last token home decides the game: under force_loss it is noticeably harder to roll.
    if (scores) w *= p === 0 && homeNow === 3 && !helped ? 0.35 : lean(LEAN.score);
    if (opens) w *= lean(LEAN.open);
    if (!moves) w *= lean(1 / LEAN.stuck);
    return w;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A player's seat beside the board, as in Ludo King: the avatar (with the turn clock round it) and, next to it on
 * the board side, that player's own dice box. The dice shows only on the player's turn; on yours the box glows, a
 * hand points at it and tapping it rolls. Name and tokens home sit under (or over) the pair.
 */
export function LudoSeatPanel({ colour, name, emoji, align, top, active, timerKey, dice, rolling, canRoll, onRoll, home, bot, dim, note, showDice }: {
  colour: number; name: string; emoji?: string; align: "left" | "right"; top?: boolean; active: boolean; timerKey: string | number | null;
  dice: number | null; rolling?: boolean; canRoll?: boolean; onRoll?: () => void; home: number; bot?: boolean; dim?: boolean; note?: string;
  /** Keep showing this player's last roll after the turn has passed (a roll that moved the only token at once). */
  showDice?: boolean;
}) {
  const pl = LPLAYERS[colour];
  const lit = active || !!showDice;
  const info = (
    <div className={`min-w-0 ${align === "right" ? "text-right" : ""}`}>
      <div className={`text-[12px] font-semibold truncate max-w-[120px] ${active ? "text-white" : "text-white/70"}`}>{name}{bot && <BotTag />}{note ? <span className="text-white/50 font-normal"> • {note}</span> : null}</div>
      <div className="text-[10px] text-white/50 flex items-center gap-1" style={{ justifyContent: align === "right" ? "flex-end" : undefined }}>
        {[0, 1, 2, 3].map((k) => <span key={k} className="w-1.5 h-1.5 rounded-full" style={{ background: k < home ? pl.color : "rgba(255,255,255,.18)" }} />)}
        <span className="ml-0.5">{home}/4 home</span>
      </div>
    </div>
  );
  return (
    <div className={`flex flex-col gap-1 ${align === "right" ? "items-end" : "items-start"} ${dim ? "opacity-40" : ""}`}>
      {top && info}
      <div className={`flex items-center gap-2 ${align === "right" ? "flex-row-reverse" : ""}`}>
        <div className={`relative rounded-full p-[3px] transition-shadow ${active ? "shadow-[0_0_16px_4px_rgba(255,255,255,.35)]" : ""}`} style={{ background: pl.color }}>
          <Avatar size={36} emoji={emoji} />
          {active && timerKey !== null && (
            <svg key={timerKey} viewBox="0 0 52 52" className="absolute -inset-[6px] w-[calc(100%+12px)] h-[calc(100%+12px)] -rotate-90 pointer-events-none">
              <circle cx="26" cy="26" r="24" fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="4" />
              <circle cx="26" cy="26" r="24" fill="none" strokeWidth="4" strokeLinecap="round" pathLength={100} strokeDasharray="100" className="ludo-timer" style={{ animationDuration: `${LUDO_TURN_SECS}s` }} />
            </svg>
          )}
        </div>
        <div className="relative">
          {canRoll && <span className="absolute left-1/2 -top-9 text-[28px] leading-none nudge-y pointer-events-none" aria-hidden>👇</span>}
          <button
            onClick={canRoll ? onRoll : undefined}
            disabled={!canRoll}
            aria-label={canRoll ? "Roll the dice" : undefined}
            className={`w-[52px] h-[52px] rounded-xl grid place-items-center transition-[transform,opacity] ${canRoll ? "pulse-ring active:scale-95" : ""} ${active ? "" : showDice ? "opacity-80" : "opacity-35"}`}
            style={{ background: lit ? `linear-gradient(145deg,${pl.color},${pl.dark})` : "rgba(255,255,255,.08)", boxShadow: lit ? "0 6px 14px rgba(0,0,0,.45)" : undefined }}
          >
            {lit && dice !== null ? <DiceFace v={dice} rolling={rolling} size={40} /> : <span className="w-[40px] h-[40px] rounded-lg" style={{ background: "rgba(255,255,255,.06)" }} />}
          </button>
        </div>
      </div>
      {!top && info}
    </div>
  );
}

export function DiceFace({ v, size = 56, rolling }: { v: number; size?: number; rolling?: boolean }) {
  const spots: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  // While rolling the faces flash by quickly (never the same face twice in a row), then it lands on v.
  const [face, setFace] = useState(v);
  useEffect(() => {
    if (!rolling) return;
    const t = window.setInterval(() => setFace((f) => { let n = f; while (n === f) n = 1 + Math.floor(Math.random() * 6); return n; }), 55);
    return () => window.clearInterval(t);
  }, [rolling]);
  const shown = rolling ? face : v;
  return (
    // Pips drawn in the dice's own 100×100 box, so they scale with it and always stay inside the face.
    <div key={rolling ? "r" : "s"} className={`rounded-[22%] bg-white shrink-0 ${rolling ? "roll" : "dice-land"}`} style={{ width: size, height: size, boxShadow: "inset -3px -3px 6px rgba(0,0,0,.2), 0 6px 14px rgba(0,0,0,.5)" }}>
      <svg viewBox="0 0 100 100" className="block w-full h-full">
        {(spots[shown] ?? []).map((i) => <circle key={i} cx={26 + (i % 3) * 24} cy={26 + Math.floor(i / 3) * 24} r={9} fill="#0f172a" />)}
      </svg>
    </div>
  );
}

// Animation pacing: tokens walk one square at a time so every move can be followed.
export const LUDO_STEP_MS = 200;
const STEP_MS = LUDO_STEP_MS;
export const LUDO_TURN_SECS = 20; // each player's turn; when yours runs out the game rolls and moves for you
const BOT_STEP_MS = STEP_MS; // computer tokens walk at the same speed as yours
const ROLL_MS = 750;
/** A human-looking pause: usually between a and b ms, now and then a longer think. */
/** Bot pacing from the admin's "bot speed" setting (1 = normal); set by each table on mount. */
let PACE = 1;
const think = (a: number, b: number) => sleep((a + Math.random() * (b - a) + (Math.random() < 0.1 ? 250 + Math.random() * 350 : 0)) * PACE);

function Ludo({ nav, table, buyIn, players = 4 }: { nav: Nav; table: string; buyIn: number; players?: 2 | 4 }) {
  // Seats in play: all four colours, or (2 players) you on red against yellow, across the board.
  const SEATS = players === 2 ? [0, 2] : [0, 1, 2, 3];
  const inPlay = (p: number) => SEATS.includes(p);
  // The board is turned so your (red) yard sits at the bottom-left, next to your dice.
  const TURNS = ludoTurns(0);
  const corner = (k: number, align: "left" | "right", top = false) => { const p = ludoColourAt(k, TURNS); return inPlay(p) ? badge(p, align, top) : <span />; };
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
  const [outcomeMode, setOutcomeMode] = useState<"fair" | "force_win" | "force_loss">("fair");
  const outcomeRef = useRef<"fair" | "force_win" | "force_loss">("fair");
  const refreshOutcome = () => {
    fetchOutcomeMode("ludo").then((m) => {
      outcomeRef.current = m;
      setOutcomeMode(m);
    });
  };
  useEffect(() => {
    refreshOutcome();
  }, []);

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
    const age = snapAge(snapKey);
    const sn = loadSnap<LudoSnap>(snapKey);
    if (!sn) return;
    // Away for three turns or more: the game was given up while you were gone (the entry is lost).
    if (age !== null && age > REJOIN_MS.ludo) {
      dropSnap(snapKey);
      clearActive(route);
      showToast("You were away for 3 turns — that game was given up");
      return;
    }
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

  // Away for three turns or more while the game was on (phone locked, app in the background — timers stop there):
  // the game was given up, as with a table that puts out a player who misses three turns. Coming back shows
  // "Game over" instead of the game carrying on from where it froze, however long ago that was.
  const beat = useRef(Date.now());
  const watching = useRef(false); // a game is on and the clock below is running
  const [gaveUp, setGaveUp] = useState(false);
  // Exit: leave the game for good (the entry is lost), unlike Back, which keeps it for a quick rejoin.
  const [askExit, setAskExit] = useState(false);
  const exitGame = () => {
    over.current = true;
    gameNo.current += 1;
    setClock(null);
    dropSnap(snapKey);
    clearActive(route);
    nav.back();
  };
  const awayTooLong = () => {
    if (over.current || !watching.current || Date.now() - beat.current <= REJOIN_MS.ludo) return false;
    over.current = true;
    gameNo.current += 1;
    setClock(null);
    setAwaitMove(false);
    setMoving(false);
    setRolling(false);
    dropSnap(snapKey);
    clearActive(route);
    setGaveUp(true);
    return true;
  };
  useEffect(() => {
    if (!started || winner !== null) return;
    beat.current = Date.now();
    watching.current = true;
    const ping = () => { if (!awayTooLong()) beat.current = Date.now(); };
    const t = setInterval(ping, 1000);
    document.addEventListener("visibilitychange", ping);
    return () => { watching.current = false; clearInterval(t); document.removeEventListener("visibilitychange", ping); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, winner]);

  const movable = (p: number, d: number) => tokRef.current[p].map((prog, i) => ((prog === -1 && d === 6) || (prog >= 0 && prog + d <= 56) ? i : -1)).filter((i) => i >= 0);

  /** Walk token i of player p forward d squares, one square at a time, then resolve captures.
   *  Resolves to "win", or true if the player earns a bonus roll (six, capture or reaching home). */
  const move = async (p: number, i: number, d: number): Promise<boolean | "win" | "stop"> => {
    const g = gameNo.current;
    setMoving(true);
    const from = tokRef.current[p][i];
    const steps = from === -1 ? [0] : Array.from({ length: d }, (_, k) => from + k + 1);
    for (const prog of steps) {
      if (awayTooLong() || !alive.current || g !== gameNo.current || over.current) return "stop";
      const t = tokRef.current.map((r) => [...r]);
      t[p][i] = prog;
      setT(t);
      if (prog === 56) sfx.home(); else sfx.hop();
      await sleep(p === 0 ? STEP_MS : BOT_STEP_MS);
    }
    if (!alive.current || g !== gameNo.current) return "stop";
    const prog = steps[steps.length - 1];
    if (prog !== 56 && ludoOnSafe(p, prog)) sfx.bell(); // landed on a safe square
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
    dropSnap(snapKey);
    clearActive(route);
    if (p === 0) {
      setWinner(0);
      credit(Math.floor(buyIn * SEATS.length * keep), label);
    } else {
      setWinner(p);
    }
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
    await sleep(ROLL_MS); // the dice tumbles through its faces meanwhile (DiceFace), then settles on the result
    const d = pickOutcomeDice(p, tokRef.current, SEATS, outcomeRef.current, sixes.current);
    setDice(d);
    setRolling(false);
    sixes.current = d === 6 ? sixes.current + 1 : 0; // three 6s *in a row*: any other number breaks the run
    if (sixes.current === 3) {
      setMsg(`${namesRef.current[p]} rolled three 6s — turn skipped`);
      await sleep(500);
      return -1;
    }
    return d;
  };

  const pickToken = (p: number, d: number, opts: number[]) => ludoPick(tokRef.current, SEATS, p, d, opts);

  const botPlay = async (p: number) => {
    const g = gameNo.current;
    setMsg(`${namesRef.current[p]}'s turn`);
    await think(550, 950); // picks up the dice
    if (awayTooLong() || !alive.current || over.current || g !== gameNo.current) return;
    const d = await roll(p);
    if (g !== gameNo.current) return;
    if (d < 0) return nextTurn(p);
    const opts = movable(p, d);
    if (!opts.length) {
      setMsg(`${namesRef.current[p]} rolled ${d} — no move`);
      await sleep(600);
      return nextTurn(p);
    }
    setMsg(`${namesRef.current[p]} rolled ${d}`);
    await think(opts.length > 1 ? 350 : 200, opts.length > 1 ? 700 : 400); // decides which token to move
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
    if (awayTooLong() || turn !== 0 || winner !== null || over.current || rolling || moving) return;
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
    refreshOutcome();
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
    markActive(route, `Ludo ${players === 2 ? "1 vs 1" : "4 players"} • Table #${table}`, REJOIN_MS.ludo);
    setMsg("Your turn — roll the dice");
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(winner !== null, NEXT_GAME_SECS, start);
  const myOpts = awaitMove ? movable(0, dice) : [];

  // Player badges sit at the board corners next to their yards (you bottom-left); the one whose turn it is glows
  // and shows the dice.
  // (A plain render function, not a component: a component defined in here would be rebuilt on every render and
  // restart the timer ring.)
  const badge = (p: number, align: "left" | "right", top = false) => {
    const active = started && turn === p && winner === null;
    const canRoll = p === 0 && started && turn === 0 && !rolling && !moving && !awaitMove && winner === null;
    return (
      <LudoSeatPanel
        colour={p} name={names[p]} emoji={p === 0 ? "🧑🏽" : ["", "👨🏻", "👩🏽", "🧔🏾"][p]} align={align} top={top} bot={p > 0}
        active={active} timerKey={active && clock?.p === p ? clock.id : null}
        dice={dice} rolling={rolling} canRoll={canRoll} onRoll={myRoll}
        home={tokens[p].filter((x) => x === 56).length}
      />
    );
  };

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein" style={{ background: "radial-gradient(120% 70% at 50% 35%, #1d3a8a 0%, #0b1438 60%, #070b22 100%)" }}>
      <Header title="Ludo" sub={`Table #${table} • ${players === 2 ? "1 vs 1" : "4 Players"} • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <div className="flex justify-between items-end mb-2 px-1 min-h-[46px]">{corner(0, "left", true)}{corner(1, "right", true)}</div>

        <LudoBoardSurface
          tokens={tokens}
          inPlay={inPlay}
          turns={TURNS}
          glowAt={(p, i) => p === 0 && myOpts.includes(i)}
          onTap={tapToken}
          blinkYard={started && winner === null && turn === 0 && !rolling && !moving && !awaitMove ? 0 : null}
          overlay={!started && (
            <div className="absolute inset-0 bg-black/55 grid place-items-center z-30">
              <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
            </div>
          )}
        />

        <div className="flex justify-between items-center mt-2 px-1 min-h-[46px]">{corner(3, "left")}{corner(2, "right")}</div>

        {/* Turn status (your dice is in your corner, next to your photo) */}
        <div className="mt-3 flex flex-col items-center">
          <div className="text-sm font-semibold">{started ? (turn === 0 ? (awaitMove ? "Choose a token" : moving ? "Moving…" : rolling ? "Rolling…" : "Tap the dice to roll") : `${names[turn]}'s turn`) : "Waiting to start"}</div>
          <div className="text-xs text-white/60 mt-0.5 text-center min-h-4">{msg}</div>
          {started && winner === null && !gaveUp && (
            <button onClick={() => setAskExit(true)} className="mt-4 pill px-4 py-2 text-xs font-semibold bg-white/10 text-white/80 inline-flex items-center gap-1.5">
              <LogOut size={14} /> Exit game
            </button>
          )}
        </div>
      </div>

      {askExit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6" onClick={() => setAskExit(false)}>
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-6 text-center pop" onClick={(e) => e.stopPropagation()}>
            <div className="text-xl font-semibold">Exit this game?</div>
            <div className="text-sm text-white/60 mt-1">You will lose this game and the entry of {inr(buyIn)} is not returned.</div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setAskExit(false)} className="py-3 rounded-2xl bg-white/10 font-semibold">Keep playing</button>
              <button onClick={exitGame} className="py-3 rounded-2xl bg-rose-500 font-semibold">Exit</button>
            </div>
          </div>
        </div>
      )}

      <ResultSheet
        open={winner !== null}
        won={winner === 0}
        title={winner === 0 ? `You won ${inr(Math.floor(buyIn * SEATS.length * keep))}!` : `${winner !== null ? names[winner] : ""} wins`}
        left={nextIn}
        onLeave={nav.back}
        onClose={() => {}}
      />

      {gaveUp && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6">
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-6 text-center pop">
            <div className="inline-grid place-items-center w-20 h-20 rounded-full bg-white/10"><span className="text-4xl">⌛</span></div>
            <div className="text-2xl font-semibold mt-3">Game over</div>
            <div className="text-sm text-white/60 mt-1">You were away for more than 3 turns, so this game was given up. The entry is not returned.</div>
            <button onClick={() => { clearActive(); nav.back(); }} className="btn-green w-full py-3 rounded-2xl mt-5">Back to lobby</button>
          </div>
        </div>
      )}
    </div>
  );
}

const CELL = 100 / 15;

/** The Ludo board with its tokens (shared by the practice table and the online private table). */
/** Size of each token when several share a square, by how many there are (7 = seven or more). */
const CLUSTER_SCALE = [1, 1, 0.62, 0.56, 0.54, 0.46, 0.46, 0.4];
/** Where the k-th of n tokens on one square sits, as an offset from the square's centre in % of the square. */
function clusterSpot(n: number, k: number): [number, number] {
  const fixed: Record<number, [number, number][]> = {
    2: [[-22, 0], [22, 0]],
    3: [[0, -18], [-22, 12], [22, 12]],
    4: [[-22, -18], [22, -18], [-22, 14], [22, 14]],
  };
  if (fixed[n]) return fixed[n][k] ?? [0, 0];
  const rows = Math.ceil(n / 3), row = Math.floor(k / 3), col = k % 3;
  return [(col - 1) * 30, (row - (rows - 1) / 2) * (rows > 2 ? 22 : 30)];
}

export function LudoBoardSurface({ tokens, inPlay, glowAt, onTap, overlay, turns = 0, blinkYard = null }: {
  tokens: number[][]; inPlay: (p: number) => boolean; glowAt: (p: number, i: number) => boolean; onTap: (p: number, i: number) => void; overlay?: React.ReactNode;
  turns?: number; // quarter turns clockwise, so the player's own yard can sit at the bottom-left (ludoTurns)
  blinkYard?: number | null; // colour whose yard blinks (yours, while it's your turn)
}) {
  const at = (r: number, c: number, size = 1) => turnCell(r, c, turns, size);
  return (
    <>
        {/* Board in a wooden frame */}
        <div className="rounded-[22px] p-[2.6%] shadow-[0_18px_40px_rgba(0,0,0,.55)]" style={{ background: "linear-gradient(145deg,#8a5a2b,#5a3416 55%,#3f2410)" }}>
        <div className="relative w-full aspect-square rounded-[14px] overflow-hidden bg-white shadow-[inset_0_0_0_2px_rgba(0,0,0,.25)]">
          {/* track cells */}
          {TRACK.map(([r0, c0], i) => {
            const [r, c] = at(r0, c0);
            const startOf = LPLAYERS.find((pl) => pl.start === i);
            const safeOwner = SAFE.has(i) && !startOf ? LPLAYERS[Math.floor(((i + 52 - 8) % 52) / 13)] : null;
            return (
              <div key={i} className="absolute grid place-items-center" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%`, background: startOf ? startOf.color : "#fff", boxShadow: "inset 0 0 0 0.6px #8f9bab" }}>
                {startOf && <span className="text-white/90 text-[9px] font-black" style={{ transform: `rotate(${turns * 90}deg)` }}>▶</span>}
                {safeOwner && <Star size={14} fill="#cfd6df" color="#7d8896" strokeWidth={1.4} />}
              </div>
            );
          })}
          {LPLAYERS.map((pl, p) => (
            <div key={p}>
              {pl.home.map(([r0, c0], i) => { const [r, c] = at(r0, c0); return (
                <div key={i} className="absolute" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%`, background: pl.color, boxShadow: "inset 0 0 0 0.6px rgba(0,0,0,.22)" }} />
              ); })}
              {/* yard: coloured square, white panel, four token spots */}
              <div className="absolute p-[0.9%]" style={{ top: `${at(p === 0 || p === 1 ? 0 : 9, p === 0 || p === 3 ? 0 : 9, 6)[0] * CELL}%`, left: `${at(p === 0 || p === 1 ? 0 : 9, p === 0 || p === 3 ? 0 : 9, 6)[1] * CELL}%`, width: `${6 * CELL}%`, height: `${6 * CELL}%`, background: `linear-gradient(145deg, ${pl.color}, ${pl.dark})` }}>
                <div className="w-full h-full rounded-[18%] bg-white/95 shadow-[inset_0_2px_6px_rgba(0,0,0,.18)]" />
                {blinkYard === p && <div className="absolute inset-[3%] rounded-[18%] yard-blink pointer-events-none" style={{ boxShadow: "inset 0 0 0 4px #facc15, inset 0 0 26px 10px rgba(250,204,21,.75)" }} />}
              </div>
              {pl.yard.map(([r0, c0], i) => { const [r, c] = at(r0, c0); return (
                <div key={`s${i}`} className="absolute grid place-items-center" style={{ top: `${r * CELL}%`, left: `${c * CELL}%`, width: `${CELL}%`, height: `${CELL}%` }}>
                  <div className="w-[90%] h-[90%] rounded-full" style={{ background: "radial-gradient(circle at 50% 35%, #fff 0%, #eef1f5 70%, #dde2e9 100%)", boxShadow: `0 0 0 3px ${pl.color}, inset 0 2px 4px rgba(0,0,0,.22)` }} />
                </div>
              ); })}
            </div>
          ))}
          {/* centre: the four home triangles */}
          <div className="absolute" style={{ top: `${6 * CELL}%`, left: `${6 * CELL}%`, width: `${3 * CELL}%`, height: `${3 * CELL}%`, background: `conic-gradient(from ${45 + turns * 90}deg, ${LPLAYERS[2].color} 0 90deg, ${LPLAYERS[3].color} 90deg 180deg, ${LPLAYERS[0].color} 180deg 270deg, ${LPLAYERS[1].color} 270deg 360deg)`, boxShadow: "inset 0 0 10px rgba(0,0,0,.35)" }}>
            <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 50% 50%, rgba(255,255,255,.35) 0%, rgba(255,255,255,0) 55%)" }} />
          </div>
          {/* tokens: positioned with transforms (GPU) and a hop on every square they land on */}
          {tokens.map((row, p) =>
            !inPlay(p) ? null : row.map((prog, i) => {
              const [r, c] = at(...cellOf(p, prog, i));
              const glow = glowAt(p, i);
              // Tokens sharing a square (any colours, finished ones in the centre too) shrink and sit side by side
              // in a small cluster, like Ludo King, so every one of them shows.
              // Compare squares on the turned board (r, c are already turned), the same way for every token.
              const same = prog >= 0 ? tokens.flatMap((rw, q) => rw.map((x, j) => ({ q, j, x }))).filter((o) => {
                if (!inPlay(o.q) || o.x < 0) return false;
                const [r2, c2] = at(...cellOf(o.q, o.x, o.j));
                return r2 === r && c2 === c;
              }) : [];
              const k = same.findIndex((o) => o.q === p && o.j === i);
              const [dx, dy] = same.length > 1 && k >= 0 ? clusterSpot(same.length, k) : [0, 0];
              const small = same.length > 1 ? CLUSTER_SCALE[Math.min(same.length, 7)] : 1;
              return (
                <button
                  key={`${p}-${i}`}
                  onClick={() => onTap(p, i)}
                  className="absolute left-0 top-0"
                  style={{
                    width: `${CELL}%`,
                    height: `${CELL}%`,
                    zIndex: (glow ? 20 : 10) + Math.round(dy / 10) + 3, // the front row over the back row
                    transform: `translate(${c * 100 + dx}%, ${r * 100 + dy}%)`,
                    // One square per step, gliding for the whole step so a walk looks continuous; leaving or going
                    // back to the yard is a longer slide.
                    transition: prog <= 0 ? "transform .38s cubic-bezier(.3,.7,.3,1)" : `transform ${LUDO_STEP_MS}ms cubic-bezier(.45,.05,.55,.95)`,
                    willChange: "transform",
                  }}
                >
                  <span key={prog} className={`relative block w-full h-full ${prog >= 0 ? "hop" : ""}`} style={{ animationDuration: `${LUDO_STEP_MS}ms` }}>
                    {glow && <span className="absolute left-1/2 bottom-[8%] -translate-x-1/2 w-[80%] h-[34%] rounded-full pulse-ring" style={{ background: "rgba(255,255,255,.55)" }} />}
                    <svg viewBox="0 0 40 56" className="absolute left-1/2 bottom-[2%] drop-shadow-[0_2px_1.5px_rgba(0,0,0,.45)]" style={{ width: `${70 * small}%`, height: `${98 * small}%`, transform: `translateX(-50%) scale(${glow ? 1.1 : 1})`, transformOrigin: "50% 90%", transition: "transform .15s" }}>
                      <defs>
                        <radialGradient id={`pin${p}`} cx="35%" cy="28%" r="75%">
                          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
                          <stop offset=".22" stopColor={LPLAYERS[p].color} />
                          <stop offset="1" stopColor={LPLAYERS[p].dark} />
                        </radialGradient>
                        <linearGradient id={`base${p}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0" stopColor={LPLAYERS[p].color} />
                          <stop offset="1" stopColor={LPLAYERS[p].dark} />
                        </linearGradient>
                      </defs>
                      {/* base disc the pin stands on */}
                      <ellipse cx="20" cy="50" rx="13" ry="4.6" fill={`url(#base${p})`} stroke="#fff" strokeWidth="1.6" />
                      <path d="M20 49 C10 36 5 28 5 18 A15 15 0 1 1 35 18 C35 28 30 36 20 49 Z" fill={`url(#pin${p})`} stroke="#fff" strokeWidth="2.4" />
                      <circle cx="20" cy="18" r="7.4" fill="#fff" />
                      <circle cx="20" cy="18" r="4.4" fill={LPLAYERS[p].color} />
                      <ellipse cx="14" cy="10.5" rx="4.2" ry="2.6" fill="#fff" opacity=".55" transform="rotate(-30 14 10.5)" />
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
// any piece (you pick), and the draws a real board has — insufficient material, the 50-move rule, the same position
// three times, and a draw offer the computer weighs on the position. Pieces move by tap or drag; while the computer
// thinks you can queue a premove. Moves are listed in standard notation above the board.
const CHESS_SECS = 600;
/** Time controls, as on any chess site: minutes for each side, plus seconds added after every move. */
const TCS = [
  { id: "1", label: "1 min", kind: "Bullet", base: 60, inc: 0 },
  { id: "3+2", label: "3 | 2", kind: "Blitz", base: 180, inc: 2 },
  { id: "5", label: "5 min", kind: "Blitz", base: 300, inc: 0 },
  { id: "10", label: "10 min", kind: "Rapid", base: 600, inc: 0 },
  { id: "15+10", label: "15 | 10", kind: "Rapid", base: 900, inc: 10 },
] as const;
type Tc = (typeof TCS)[number];
const tcOf = (id: string | null | undefined): Tc => TCS.find((t) => t.id === id) ?? TCS[3];
const readLs = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLs = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
/** A computer opponent's rating: steady per name, 950-1650. */
const botRating = (name: string) => { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 950 + (h % 71) * 10; };
const CLS_STYLE: Record<MoveClass, { label: string; mark: string; color: string }> = {
  best: { label: "Best", mark: "★", color: "#81b64c" },
  excellent: { label: "Excellent", mark: "!", color: "#96bc4b" },
  good: { label: "Good", mark: "✓", color: "#95af8a" },
  inaccuracy: { label: "Inaccuracy", mark: "?!", color: "#f7c631" },
  mistake: { label: "Mistake", mark: "?", color: "#ffa459" },
  blunder: { label: "Blunder", mark: "??", color: "#fa412d" },
};
interface Review { done: boolean; acc: number | null; marks: { san: string; cls: MoveClass }[]; counts: Record<MoveClass, number> }
type Sq = [number, number];
const sameSq = (a: Sq | null | undefined, r: number, c: number) => !!a && a[0] === r && a[1] === c;

function Chess({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
  const gs = useGameSettings();
  const keep = 1 - feeOf(gs, "chess", 10);
  const pace = botPace(gs, "chess");
  const { total, credit, debit, showToast } = useStore();
  const [pos, setPos] = useState<Pos>(startPos);
  const [sel, setSel] = useState<Sq | null>(null);
  const [last, setLast] = useState<Move | null>(null);
  const [taken, setTaken] = useState<{ w: string[]; b: string[] }>({ w: [], b: [] }); // pieces each side has captured
  const [moves, setMoves] = useState<string[]>([]); // the game so far, in standard notation
  const hist = useRef<string[]>([]); // every position reached (posKey), for threefold repetition
  const [promo, setPromo] = useState<Move[] | null>(null); // a pawn reached the last row: pick the piece
  const [premove, setPremove] = useState<Move | null>(null); // queued while the computer thinks
  const [drag, setDrag] = useState<{ from: Sq; x: number; y: number; moved: boolean } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const lastOffer = useRef(-99); // ply of the last draw offer (one every ten plies)
  const [tc] = useState<Tc>(TCS[3]); // 10 minutes a side
  const tcRef = useRef<Tc>(tc); // the time control of the game in progress (a new pick applies from the next game)
  const [rating, setRating] = useState(1200);
  // Saved choices are read after the first render (the server has no localStorage, so the first render must match).
  useEffect(() => {
    const r = Number(readLs("chessRating"));
    if (r) setRating(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [delta, setDelta] = useState<number | null>(null); // rating change from the last game
  const line = useRef<{ pos: Pos; move: Move; san: string }[]>([]); // your moves this game, for the review
  const [review, setReview] = useState<Review | null>(null);
  const [clock, setClock] = useState([CHESS_SECS, CHESS_SECS]);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState<null | "win" | "loss" | "draw">(null);
  const [why, setWhy] = useState("");
  const label = `Chess • Table #${table}`;
  const [opp, setOpp] = useState<Bot>(() => pickBots(1)[0]);
  const [lowBal, setLowBal] = useState(false);
  const games = useRef(0);
  const gameNo = useRef(0);
  // Your colour for this game, drawn at random each game (Black plays from the other side, the computer opens).
  const [me, setMe] = useState<"w" | "b">("w");
  const white = pos.turn === me; // your move
  const flip = me === "b"; // board drawn from Black's side
  const myPromo = (k: string) => (me === "w" ? k : k.toLowerCase());
  const [outcomeMode, setOutcomeMode] = useState<"fair" | "force_win" | "force_loss">("fair");
  const outcomeRef = useRef<"fair" | "force_win" | "force_loss">("fair");
  useEffect(() => {
    fetchOutcomeMode("chess").then((m) => {
      outcomeRef.current = m;
      setOutcomeMode(m);
    });
  }, []);
  void outcomeMode;

  // Rejoin: the game is saved on this phone every second, so Back (or closing the app) and coming back carries on
  // from the same position — entry not charged again. Your clock keeps running while you're away: the time gone
  // comes off your clock, and if it ran out the game is lost. Exit gives the game up for good.
  const snapKey = `chess:${table}:${buyIn}`;
  const route: Route = { name: "board", game: "chess", table, buyIn };
  interface ChessSnap { pos: Pos; last: Move | null; taken: { w: string[]; b: string[] }; clock: number[]; opp: Bot; botMoves: number; moves?: string[]; hist?: string[]; tc?: string; line?: { pos: Pos; move: Move; san: string }[]; me?: "w" | "b" }
  const [askExit, setAskExit] = useState(false);
  const over = useRef(false); // game finished or given up: stop saving it (state updates land a render later)

  const end = (result: "win" | "loss" | "draw", reason: string) => {
    over.current = true;
    gameNo.current += 1;
    dropSnap(snapKey);
    clearActive(route);
    setPremove(null);
    setPromo(null);
    // Rating, the usual Elo way (K = 32) against the opponent's rating.
    const expect = 1 / (1 + Math.pow(10, (botRating(opp.name) - rating) / 400));
    const d = Math.round(32 * ((result === "win" ? 1 : result === "draw" ? 0.5 : 0) - expect));
    setRating((r) => { const n = Math.max(100, r + d); writeLs("chessRating", String(n)); return n; });
    setDelta(d);
    startReview();
    if (result === "win") {
      setDone("win");
      setWhy(reason);
      credit(Math.floor(buyIn * 2 * keep), label);
      return;
    }
    if (result === "draw") {
      setDone("draw");
      setWhy(reason);
      credit(buyIn, label, "Refund");
      return;
    }
    setDone(result);
    setWhy(reason);
  };

  const play = (p: Pos, m: Move) => {
    const note = san(p, m);
    const next = makeMove(p, m);
    if (note.endsWith("+") || note.endsWith("#")) sfx.tickUrgent(); else if (m.captured !== "." || m.ep) sfx.capture(); else sfx.move();
    if (p.turn === me) line.current = [...line.current, { pos: p, move: m, san: note }];
    const inc = tcRef.current.inc;
    if (inc) setClock((c) => (p.turn === me ? [c[0] + inc, c[1]] : [c[0], c[1] + inc]));
    setPos(next);
    setLast(m);
    setSel(null);
    setMoves((l) => [...l, note]);
    const key = posKey(next);
    hist.current = [...hist.current, key];
    if (m.captured !== ".") setTaken((t) => (p.turn === "w" ? { ...t, w: [...t.w, m.captured] } : { ...t, b: [...t.b, m.captured] }));
    else if (m.ep) setTaken((t) => (p.turn === "w" ? { ...t, w: [...t.w, "p"] } : { ...t, b: [...t.b, "P"] }));
    const st = chessStatus(next);
    if (st === "checkmate") end(p.turn === me ? "win" : "loss", "Checkmate");
    else if (st === "stalemate") end("draw", "Stalemate");
    else if (st === "draw") end("draw", "Not enough pieces to mate");
    else if (st === "fifty") end("draw", "50 moves without a capture or pawn move");
    else if (hist.current.filter((k) => k === key).length >= 3) end("draw", "Same position three times");
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
      const m = bestMove(pos, {
        ms: outcomeRef.current === "force_loss" ? 850 : outcomeRef.current === "force_win" ? 250 : Math.min(1100, Math.max(300, wait - 200)),
        variety: outcomeRef.current === "force_loss" ? false : botMoves.current < 4,
      });
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

  // Your turn again with a premove queued: play it if it is still legal, otherwise drop it.
  useEffect(() => {
    if (!started || !white || done !== null || !premove) return;
    const m = legalMoves(pos).find((x) => x.from[0] === premove.from[0] && x.from[1] === premove.from[1] && x.to[0] === premove.to[0] && x.to[1] === premove.to[1] && (!x.promo || x.promo === (premove.promo ?? myPromo("Q"))));
    setPremove(null);
    if (m) { const t = window.setTimeout(() => play(pos, m), 120); return () => window.clearTimeout(t); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, started, done]);

  useEffect(() => {
    if (!started || done !== null || over.current) return;
    saveSnap<ChessSnap>(snapKey, { pos, last, taken, clock, opp, botMoves: botMoves.current, moves, hist: hist.current, tc: tcRef.current.id, line: line.current, me });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, done, pos, clock]);
  useEffect(() => {
    if (started && done === null && !over.current) markActive(route, label, Math.max(0, clock[0]) * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, done, pos]);
  const resumed = useRef(false); // once only (React may run mount effects twice in development)
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const sn = loadSnap<ChessSnap>(snapKey);
    if (!sn) return;
    const away = Math.floor((snapAge(snapKey) ?? 0) / 1000);
    const mine = sn.clock[0] - away;
    if (mine <= 0) {
      dropSnap(snapKey);
      clearActive(route);
      showToast("Your clock ran out while you were away — that game was lost");
      return;
    }
    over.current = false;
    gameNo.current += 1;
    games.current = 1;
    botMoves.current = sn.botMoves;
    setOpp(sn.opp);
    setMe(sn.me ?? "w"); // a game saved before colours were drawn was played as White
    setPos(sn.pos);
    setLast(sn.last);
    setTaken(sn.taken);
    setMoves(sn.moves ?? []);
    hist.current = sn.hist ?? [posKey(sn.pos)];
    tcRef.current = tcOf(sn.tc); // a game saved before keeps its own time control
    line.current = sn.line ?? [];
    setClock([mine, sn.clock[1]]);
    setStarted(true);
    showToast("Welcome back — your game carries on");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const exitGame = () => {
    over.current = true;
    gameNo.current += 1;
    dropSnap(snapKey);
    clearActive(route);
    nav.back();
  };

  const live = started && done === null;
  const myMoves = live && white ? legalMoves(pos) : [];
  // While the computer thinks: the moves your pieces could make from here (checked again when your turn comes).
  const preMoves = live && !white ? legalMoves({ ...pos, turn: me, ep: null }) : [];
  const pool = white ? myMoves : preMoves;
  const targets = sel ? pool.filter((m) => m.from[0] === sel[0] && m.from[1] === sel[1]) : [];

  /** Move the selected piece to (r, c): a pawn reaching the last row asks which piece; off turn it's a premove. */
  const moveTo = (r: number, c: number) => {
    const ms = targets.filter((x) => x.to[0] === r && x.to[1] === c);
    if (!ms.length) return false;
    if (!white) {
      setPremove(ms.find((x) => !x.promo || x.promo === myPromo("Q")) ?? ms[0]);
      setSel(null);
      return true;
    }
    if (ms.length > 1) { setPromo(ms); setSel(null); return true; }
    play(pos, ms[0]);
    return true;
  };
  const own = (r: number, c: number) => { const pc = pos.board[r][c]; return pc !== "." && (me === "w" ? pc === pc.toUpperCase() : pc === pc.toLowerCase()); };
  const squareAt = (x: number, y: number): Sq | null => {
    const el = boardRef.current;
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const c = Math.floor(((x - b.left) / b.width) * 8), r = Math.floor(((y - b.top) / b.height) * 8);
    if (!(r >= 0 && r < 8 && c >= 0 && c < 8)) return null;
    return flip ? [7 - r, 7 - c] : [r, c];
  };

  // Tap or drag: press on a target square to move there; press on your piece to pick it up (and drag it if you like).
  const onDown = (e: React.PointerEvent) => {
    if (!live || promo) return;
    const sq = squareAt(e.clientX, e.clientY);
    if (!sq) return;
    const [r, c] = sq;
    if (sel && !sameSq(sel, r, c) && moveTo(r, c)) return;
    if (own(r, c)) {
      if (!white && premove) setPremove(null);
      setSel([r, c]);
      setDrag({ from: [r, c], x: e.clientX, y: e.clientY, moved: false });
      boardRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    setSel(null);
    if (!white) setPremove(null);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    const sq = squareAt(e.clientX, e.clientY);
    if (sq && !sameSq(d.from, sq[0], sq[1])) moveTo(sq[0], sq[1]);
  };

  const offerDraw = () => {
    if (!live || !white) return showToast("Offer a draw on your move");
    const ply = moves.length;
    if (ply - lastOffer.current < 10) return showToast("You can offer a draw again in a few moves");
    lastOffer.current = ply;
    // The computer takes a draw when it stands worse, or in a long, level game; never when it is set to win.
    const edge = (me === "w" ? 1 : -1) * assess(pos); // + = you better
    const yes = outcomeRef.current !== "force_loss" && (edge >= 150 || (ply >= 60 && Math.abs(edge) <= 40));
    if (yes) end("draw", "Draw agreed");
    else showToast(`${opp.name} declined the draw`);
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Entry`)) {
      setLowBal(true);
      setStarted(false);
      setDone(null);
      return showToast("Not enough coins — ask your agent");
    }
    setLowBal(false);
    over.current = false;
    gameNo.current += 1;
    if (games.current++ > 0) setOpp(pickBots(1, [opp.name])[0]);
    const s0 = startPos();
    setMe(Math.random() < 0.5 ? "w" : "b");
    setPos(s0);
    hist.current = [posKey(s0)];
    setMoves([]);
    lastOffer.current = -99;
    botMoves.current = 0;
    setSel(null);
    setPremove(null);
    setPromo(null);
    setLast(null);
    setTaken({ w: [], b: [] });
    tcRef.current = tc;
    line.current = [];
    setClock([tc.base, tc.base]);
    setDone(null);
    setWhy("");
    setStarted(true);
    markActive(route, label, tc.base * 1000);
  };

  // Game review: each of your moves against the engine's best from the same position, a move at a time so the
  // screen stays responsive. Accuracy is the average of the per-move accuracies (winning-chances curve).
  const reviewRun = useRef(0);
  const startReview = () => {
    const run = ++reviewRun.current;
    const moves = line.current;
    const out: Review["marks"] = [];
    const accs: number[] = [];
    const counts = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 } as Record<MoveClass, number>;
    setReview({ done: false, acc: null, marks: [], counts });
    let i = 0;
    const step = () => {
      if (run !== reviewRun.current) return;
      if (i >= moves.length) {
        setReview({ done: true, acc: accs.length ? Math.round((accs.reduce((a, b) => a + b, 0) / accs.length) * 10) / 10 : null, marks: [...out], counts: { ...counts } });
        return;
      }
      const { pos: before, move, san: note } = moves[i];
      i++;
      const best = analyse(before, 160);
      const st = chessStatus(makeMove(before, move));
      const afterScore = st === "checkmate" ? 100000 : best.scoreOf(move) ?? best.score;
      const wasBest = !!best.move && best.move.from.join() === move.from.join() && best.move.to.join() === move.to.join() && best.move.promo === move.promo;
      // The first few moves are opening theory: anything sensible counts as best.
      const book = i <= 4 && best.score - afterScore <= 60;
      const { cls, accuracy } = classify(best.score, afterScore, wasBest || book);
      out.push({ san: note, cls });
      accs.push(accuracy);
      counts[cls] += 1;
      setReview({ done: false, acc: null, marks: [...out], counts: { ...counts } });
      window.setTimeout(step, 0);
    };
    window.setTimeout(step, 50);
  };

  const firstIn = useAutoNext(!started && !lowBal, 3, start);
  const nextIn = useAutoNext(done !== null, NEXT_GAME_SECS, start);
  const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
  const check = live && inCheck(pos);
  const [kr, kc] = kingSquare(pos.board, pos.turn);
  const edge = (me === "w" ? 1 : -1) * materialEdge(pos.board); // + = you ahead
  const Taken = ({ list, plus }: { list: string[]; plus: number }) => (
    <div className="h-5 flex items-center gap-[1px] text-[15px] leading-none text-white/80 px-1">
      {[...list].sort((a, b) => "qrbnp".indexOf(a.toLowerCase()) - "qrbnp".indexOf(b.toLowerCase())).map((p, i) => <span key={i} className="w-[15px] h-[15px] -mr-[3px] inline-block"><ChessPiece p={p} /></span>)}
      {plus > 0 && <span className="ml-1.5 text-[12px] font-semibold text-white/60">+{plus}</span>}
    </div>
  );
  const dragging = drag?.moved ? drag : null;
  const sqSize = boardRef.current ? boardRef.current.getBoundingClientRect().width / 8 : 44;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Chess" sub={`Table #${table} • ${started ? `You play ${me === "w" ? "White" : "Black"} • ` : ""}${tcRef.current.kind} ${tcRef.current.label} • Entry 🪙 ${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />
      <div className="px-3">
        <PlayerBar name={`${opp.name} (${botRating(opp.name)})`} bot emoji={opp.emoji} time={fmt(clock[1])} active={live && !white} low={clock[1] <= 30} />
        <Taken list={me === "w" ? taken.b : taken.w} plus={-edge} />
        <div
          ref={boardRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)}
          className="relative grid grid-cols-8 rounded-[4px] overflow-hidden shadow-2xl touch-none select-none"
        >
          {pos.board.map((row, dr) =>
            row.map((_, dc) => {
              const r = flip ? 7 - dr : dr, c = flip ? 7 - dc : dc; // the board square drawn at this spot
              const p = pos.board[r][c];
              const dark = (r + c) % 2 === 1;
              const isSel = sameSq(sel, r, c);
              const isLast = last && (sameSq(last.from, r, c) || sameSq(last.to, r, c));
              const isPre = premove && (sameSq(premove.from, r, c) || sameSq(premove.to, r, c));
              const tgt = targets.find((m) => m.to[0] === r && m.to[1] === c);
              const inChk = check && r === kr && c === kc;
              const hidden = dragging && sameSq(dragging.from, r, c);
              return (
                <div
                  key={`${r}${c}`}
                  className="relative aspect-square grid place-items-center"
                  style={{
                    backgroundColor: isPre ? (dark ? "#c0504d" : "#e8836f") : isSel ? "#f6e05e" : isLast ? (dark ? "#b9ca43" : "#f5f682") : dark ? "#779556" : "#ebecd0",
                    backgroundImage: inChk ? "radial-gradient(circle, rgba(255,0,0,.9) 0%, rgba(231,0,0,.55) 35%, rgba(169,0,0,0) 72%)" : undefined,
                  }}
                >
                  {dc === 0 && <span className={`absolute left-[3px] top-[1px] text-[10px] font-bold ${dark ? "text-[#ebecd0]" : "text-[#779556]"}`}>{8 - r}</span>}
                  {dr === 7 && <span className={`absolute right-[3px] bottom-0 text-[10px] font-bold ${dark ? "text-[#ebecd0]" : "text-[#779556]"}`}>{"abcdefgh"[c]}</span>}
                  {p !== "." && !hidden && (
                    <span key={`${p}${last?.to.join() ?? ""}`} className={`w-[92%] h-[92%] ${isLast && last && sameSq(last.to, r, c) ? "pop" : ""}`}>
                      <ChessPiece p={p} />
                    </span>
                  )}
                  {tgt && (tgt.captured !== "." || tgt.ep ? (
                    <span className="absolute inset-[6%] rounded-full border-[4px] border-black/25 pointer-events-none" />
                  ) : (
                    <span className="absolute w-[28%] h-[28%] rounded-full bg-black/25 pointer-events-none" />
                  ))}
                </div>
              );
            }),
          )}
          {!started && (
            <div className="absolute inset-0 bg-black/55 grid place-items-center">
              <Waiting lowBal={lowBal} left={firstIn} onRetry={start} onAddCash={() => nav.push({ name: "addcash" })} />
            </div>
          )}
          {promo && (
            <div className="absolute inset-0 bg-black/55 grid place-items-center z-20" onPointerDown={(e) => e.stopPropagation()}>
              <div className="rounded-2xl bg-[#0d1230] border border-white/15 p-3 pop">
                <div className="text-center text-xs text-white/60 mb-2">Promote to</div>
                <div className="flex gap-2">
                  {["Q", "R", "B", "N"].map(myPromo).map((k) => {
                    const m = promo.find((x) => x.promo === k);
                    return m ? (
                      <button key={k} onClick={() => { setPromo(null); play(pos, m); }} className="w-14 h-14 rounded-xl bg-[#ebecd0] grid place-items-center p-1 active:scale-95"><ChessPiece p={k} /></button>
                    ) : null;
                  })}
                </div>
                <button onClick={() => setPromo(null)} className="w-full mt-2 text-[11px] text-white/50">Cancel</button>
              </div>
            </div>
          )}
        </div>
        {dragging && (
          <span className="fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-1/2" style={{ left: dragging.x, top: dragging.y, width: sqSize * 1.1, height: sqSize * 1.1 }}>
            <ChessPiece p={pos.board[dragging.from[0]][dragging.from[1]]} />
          </span>
        )}
        <Taken list={me === "w" ? taken.w : taken.b} plus={edge} />
        <PlayerBar name={`You (${rating})`} emoji="👨🏽" time={fmt(clock[0])} active={live && white} low={clock[0] <= 30} />
        <div className={`text-center text-[12px] mt-3 ${check ? "text-rose-400 font-semibold" : "text-white/45"}`}>
          {done !== null ? why : check ? (white ? "Check! Protect your king" : `You gave check!`) : started ? (white ? "Your move — tap or drag a piece" : premove ? "Premove set — it plays as soon as it's your turn" : `${opp.name} is thinking… you can premove`) : ""}
        </div>
        {live && (
          <div className="flex justify-center gap-2 mt-4">
            <button onClick={offerDraw} className="pill px-4 py-2 text-xs font-semibold bg-white/10 text-white/80">½ Offer draw</button>
            <button onClick={() => setAskExit(true)} className="pill px-4 py-2 text-xs font-semibold bg-white/10 text-white/80 inline-flex items-center gap-1.5">
              <LogOut size={14} /> Resign
            </button>
          </div>
        )}
        {live && <div className="text-center text-[10px] text-white/35 mt-2">Tap ← to leave for a while — rejoin from Home, your clock keeps running.</div>}

        {/* Game review of the last game: accuracy, how many moves of each kind, and each move marked */}
        {review && (
          <div className="card mt-4 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Game Review{live ? " — last game" : ""}</div>
              {review.done ? (
                <div className="text-right">
                  <div className="text-[10px] text-white/50">Accuracy</div>
                  <div className="text-lg font-bold text-[#81b64c] leading-none">{review.acc ?? "—"}</div>
                </div>
              ) : <div className="text-[11px] text-white/50 animate-pulse">Reviewing {review.marks.length}/{line.current.length || review.marks.length}…</div>}
            </div>
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              {(Object.keys(CLS_STYLE) as MoveClass[]).map((k) => (
                <div key={k} className="rounded-lg bg-white/5 px-2 py-1 flex items-center justify-between text-[11px]">
                  <span style={{ color: CLS_STYLE[k].color }}>{CLS_STYLE[k].mark} {CLS_STYLE[k].label}</span>
                  <b>{review.counts[k]}</b>
                </div>
              ))}
            </div>
            {review.marks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 text-[11px] font-mono">
                {review.marks.map((m, i) => (
                  <span key={i} className="rounded px-1.5 py-0.5 bg-white/5">
                    <span className="text-white/35">{i + 1}.</span> {m.san}<span style={{ color: CLS_STYLE[m.cls].color }}> {CLS_STYLE[m.cls].mark}</span>
                  </span>
                ))}
              </div>
            )}
            {delta !== null && review.done && <div className="mt-2 text-[11px] text-white/60">Rating {rating} ({delta >= 0 ? "+" : ""}{delta}) vs {opp.name} ({botRating(opp.name)})</div>}
          </div>
        )}
      </div>

      {askExit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6" onClick={() => setAskExit(false)}>
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-6 text-center pop" onClick={(e) => e.stopPropagation()}>
            <div className="text-xl font-semibold">Resign this game?</div>
            <div className="text-sm text-white/60 mt-1">You will lose this game and the entry of {inr(buyIn)} is not returned.</div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setAskExit(false)} className="py-3 rounded-2xl bg-white/10 font-semibold">Keep playing</button>
              <button onClick={exitGame} className="py-3 rounded-2xl bg-rose-500 font-semibold">Resign</button>
            </div>
          </div>
        </div>
      )}
      <ResultSheet
        open={done !== null}
        won={done === "win"}
        title={done === "win" ? `${why} — you won ${inr(Math.floor(buyIn * 2 * keep))}!` : done === "draw" ? `${why} — draw, entry refunded` : `${why} — ${opp.name} wins`}
        sub={delta !== null ? `Rating ${rating} (${delta >= 0 ? "+" : ""}${delta}) • Game Review below` : undefined}
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

function PlayerBar({ name, emoji, time, active, bot, low }: { name: string; emoji: string; time: string; active: boolean; bot?: boolean; low?: boolean }) {
  return (
    <div className="flex items-center gap-3 card px-3 py-2">
      <Avatar emoji={emoji} size={34} />
      <div className="flex-1 text-sm font-medium leading-tight">
        {name}{bot && <BotTag />}
        {bot && active && <div className="text-[11px] font-normal text-white/50">thinking<span className="inline-block w-4 text-left animate-pulse">…</span></div>}
      </div>
      <div className={`font-mono text-sm px-2.5 py-1 rounded-lg ${active ? (low ? "bg-rose-500 text-white animate-pulse" : "bg-white text-slate-900") : low ? "bg-rose-500/30 text-rose-200" : "bg-white/10 text-white/60"}`}>{time}</div>
    </div>
  );
}
