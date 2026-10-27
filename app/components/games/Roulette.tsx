"use client";

import { sfx } from "../../lib/sound";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, ChevronLeft, Info, Repeat, TrendingUp, Undo2, Users } from "lucide-react";
import { useLiveCount } from "../../lib/liveCount";
import { gameById, inr } from "../../lib/data";
import { rouletteSide } from "../../lib/roundText";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Avatar, HomeButton } from "../ui";
import { LandscapeStage } from "./LandscapeStage";
import type { Nav } from "../nav";

// European roulette (single zero), laid out like casino roulette apps: a landscape green table, the wheel
// peeking in from the left, timed rounds that run on their own (25 s to bet, then the wheel slides in and spins).
// The database spins and pays every bet (supabase/migrations/012_roulette_blackjack_plinko.sql); a round you
// didn't bet on is spun on the device just for show.

const BET_SECS = 25;
const SPIN_MS = 9000;
const RESULT_MS = 3800;
const MAX_STAKE = 100000;
/** One whole round, betting to next betting. */
const ROUND_MS = BET_SECS * 1000 + SPIN_MS + 300 + RESULT_MS;
const ROOM_KEY = "rl_room";
/** A spin nobody bet on: 0 about once in forty, like the server's wheel. */
const wheelNumber = () => (Math.random() < 1 / 40 ? 0 : 1 + Math.floor(Math.random() * 36));
/** The room as it was when this screen was last open: the last numbers, the round number, and when. The wheel keeps
 *  turning while nobody is watching, so on return the rounds missed in between are filled in — the history strip
 *  never shows the same old numbers after a refresh. */
function loadRoom(): { hist: number[]; round: number } | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as { hist: number[]; round: number; at: number };
    if (!Array.isArray(r.hist) || typeof r.round !== "number" || typeof r.at !== "number") return null;
    const missed = Math.min(40, Math.max(0, Math.floor((Date.now() - r.at) / ROUND_MS)));
    const hist = [...Array.from({ length: missed }, wheelNumber), ...r.hist].slice(0, 20);
    return { hist, round: r.round + missed };
  } catch { return null; }
}
function saveRoom(hist: number[], round: number) {
  try { localStorage.setItem(ROOM_KEY, JSON.stringify({ hist: hist.slice(0, 20), round, at: Date.now() })); } catch { /* private mode etc. */ }
}
const CHIPS: { v: number; c: string }[] = [
  { v: 20, c: "#16a34a" },
  { v: 50, c: "#0d9488" },
  { v: 100, c: "#2563eb" },
  { v: 200, c: "#7c3aed" },
  { v: 500, c: "#db2777" },
  { v: 1000, c: "#ca8a04" },
  { v: 2000, c: "#ea580c" },
  { v: 5000, c: "#dc2626" },
];
const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RED = "#c9454d";
const BLACK = "#1b3a33";
const GREEN = "#2f9d4e";
const color = (n: number) => (n === 0 ? GREEN : REDS.has(n) ? RED : BLACK);
const short = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}K` : String(v));
const norm = (d: number) => ((d % 360) + 360) % 360;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
// Ball, in the wheel's SVG units (viewBox 224 across), like a live wheel: it rolls round the wooden rim against the
// wheel (BALL_ROLL_MS, BALL_TURNS turns), spirals down over the numbers (BALL_DROP_MS), then — slowed right down —
// hops back and forth across the pockets (BALL_HOPS hops) before it settles in the winning one.
const BALL_UNITS = 10;
const BALL_RIM_R = 102;
const BALL_POCKET_R = 69;
const BALL_ROLL_MS = 4300;
const BALL_DROP_MS = 1000;
const BALL_TURNS = 10;
const BALL_HOPS = 5;

/** A spot at the far end of the grid that places a bet also offered elsewhere ("st_34@end" is Street 34-36 tapped
 *  on the end edge, "st_34@c3" on its outer corner by 34): the chip stays where it was put, the server gets the plain
 *  bet. */
const plain = (side: string) => side.replace(/@.*$/, "");

/** Does a bet win on number n? (Display only — the server settles every bet.) */
function wins(spot: string, n: number) {
  const side = plain(spot);
  if (side.startsWith("n_")) return Number(side.slice(2)) === n;
  if (side.startsWith("s_") || side.startsWith("q_") || side.startsWith("t_")) return side.slice(2).split("_").map(Number).includes(n); // split / corner / trio
  if (side.startsWith("st_")) { const a = Number(side.slice(3)); return n >= a && n <= a + 2; } // street
  if (side.startsWith("sl_")) { const a = Number(side.slice(3)); return n >= a && n <= a + 5; } // six line
  if (side === "ff") return n <= 3; // first four 0-1-2-3
  if (n === 0) return false;
  switch (side) {
    case "red": return REDS.has(n);
    case "black": return !REDS.has(n);
    case "even": return n % 2 === 0;
    case "odd": return n % 2 === 1;
    case "low": return n <= 18;
    case "high": return n >= 19;
    case "d1": return n <= 12;
    case "d2": return n >= 13 && n <= 24;
    case "d3": return n >= 25;
    case "c1": return n % 3 === 1;
    case "c2": return n % 3 === 2;
    case "c3": return n % 3 === 0;
  }
  return false;
}

type Bet = { side: string; v: number };
type Phase = "betting" | "spinning" | "result";
const OUTSIDE = ["low", "even", "red", "black", "odd", "high", "d1", "d2", "d3", "c1", "c2", "c3"];

export function Roulette({ nav }: { nav: Nav }) {
  const game = gameById("roulette");
  const online = useLiveCount(Math.floor(game.online / 60));
  const { total, player, showToast, applyBalance, holdWinnings } = useStore();
  const [phase, setPhase] = useState<Phase>("betting");
  const [endsAt, setEndsAt] = useState(() => Date.now() + BET_SECS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [chip, setChip] = useState(20);
  const [bets, setBets] = useState<Bet[]>([]);
  const [lastBets, setLastBets] = useState<Bet[]>([]);
  const [crowd, setCrowd] = useState<{ side: string; v: number; dx: number; dy: number }[]>([]);
  const [hist, setHist] = useState<number[]>([]);
  const [result, setResult] = useState<{ n: number; payout: number; stake: number } | null>(null);
  // The wheel and ball are moved frame by frame (refs, not React state) so the ball can roll over the numbers,
  // drop into the winning pocket and then ride round with the wheel.
  const wheelEl = useRef<HTMLDivElement>(null);
  const ballEl = useRef<HTMLDivElement>(null);
  const wheelAt = useRef(0);
  const anim = useRef(0);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);
  const [round, setRound] = useState(() => 40000 + Math.floor(Math.random() * 900));
  const roomLoaded = useRef(false);
  const betsRef = useRef(bets);
  betsRef.current = bets;
  const busy = useRef(false);

  // The last numbers: the room as it was left (with the rounds missed since filled in); for a first visit, the
  // player's own spins from the server.
  useEffect(() => {
    const room = loadRoom();
    if (room) { setHist(room.hist); setRound(room.round); roomLoaded.current = true; return; }
    supabase().rpc("rl_history").then(({ data }) => { if (!roomLoaded.current && Array.isArray(data) && data.length) setHist(data as number[]); });
  }, []);
  useEffect(() => { if (hist.length) saveRoom(hist, round); }, [hist, round]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  // Other players' chips land on the table while bets are open.
  useEffect(() => {
    if (phase !== "betting") return;
    const t = setInterval(() => {
      const side = Math.random() < 0.55 ? `n_${Math.floor(Math.random() * 37)}` : OUTSIDE[Math.floor(Math.random() * OUTSIDE.length)];
      const v = CHIPS[Math.floor(Math.pow(Math.random(), 2.2) * 5)].v;
      setCrowd((c) => [...c, { side, v, dx: Math.random() * 40 - 20, dy: Math.random() * 30 - 15 }].slice(-70));
    }, 380);
    return () => clearInterval(t);
  }, [phase]);

  const spinTo = useCallback((n: number) => {
    const pocket = ORDER.indexOf(n) * (360 / ORDER.length); // the pocket's angle on the wheel
    const w0 = wheelAt.current;
    const w1 = w0 - norm(w0) + 360 * 5 + norm(-pocket); // winning pocket ends at the top
    const t0 = performance.now();
    const T1 = BALL_ROLL_MS + BALL_DROP_MS;
    const BOUNCE_MS = SPIN_MS - T1;
    const swing = (2.6 + Math.random() * 1.6) * (360 / ORDER.length); // how far past the pocket the ball first lands
    let hits = 0;
    sfx.wheel(T1);
    cancelAnimationFrame(anim.current);
    const frame = (now: number) => {
      const ms = now - t0;
      const t = Math.min(1, ms / SPIN_MS);
      const w = w0 + (w1 - w0) * easeOutCubic(t);
      wheelAt.current = w;
      if (wheelEl.current) wheelEl.current.style.transform = `rotate(${w}deg)`;
      // Ball, measured against the wheel (it ends up riding round with it in the winning pocket).
      let rel: number, r: number;
      if (ms < T1) {
        const u = ms / T1;
        rel = pocket + swing + 360 * BALL_TURNS * (1 - (1 - u) * (1 - u) * 0.85 - (1 - u) * 0.15);
        const d = Math.max(0, (ms - BALL_ROLL_MS) / BALL_DROP_MS); // 0 on the rim → 1 in the pockets
        r = BALL_RIM_R + (BALL_POCKET_R - BALL_RIM_R) * d * d + 3 * Math.sin(Math.PI * 3 * d) * (1 - d);
      } else {
        // Slow motion: damped swings back and forth over the pockets, a hop each time it clips a fret.
        const s = Math.min(1, (ms - T1) / BOUNCE_MS);
        rel = pocket + swing * Math.exp(-2.6 * s) * Math.cos(2 * Math.PI * 1.75 * s);
        r = BALL_POCKET_R + 10 * Math.exp(-3 * s) * Math.abs(Math.sin(Math.PI * BALL_HOPS * s));
        const hit = Math.floor(s * BALL_HOPS + 1e-6);
        if (hit >= hits && hit < BALL_HOPS) { sfx.ballHit(1 - hit / BALL_HOPS); hits = hit + 1; }
      }
      if (ballEl.current) ballEl.current.style.transform = `translate(-50%, -50%) rotate(${w + rel}deg) translateY(${(-r / BALL_UNITS) * 100}%)`;
      if (t < 1) anim.current = requestAnimationFrame(frame);
    };
    anim.current = requestAnimationFrame(frame);
  }, []);

  // Round clock: betting → spin (server settles your bets) → result → next round.
  useEffect(() => {
    if (now < endsAt || busy.current) return;
    if (phase === "betting") {
      const placed = betsRef.current;
      busy.current = true;
      setPhase("spinning");
      setEndsAt(Number.MAX_SAFE_INTEGER);
      const go = (n: number, payout: number, stake: number, release: () => void) => {
        spinTo(n);
        window.setTimeout(() => {
          setResult({ n, payout, stake });
          if (payout > 0) sfx.win(); else if (stake > 0) sfx.lose();
          setHist((h) => [n, ...h].slice(0, 20));
          release(); // winnings appear only now that the ball has stopped
          setPhase("result");
          setEndsAt(Date.now() + RESULT_MS);
          busy.current = false;
        }, SPIN_MS + 300);
      };
      if (placed.length) {
        setLastBets(placed);
        supabase().rpc("roulette_spin", { p_bets: placed.map((b) => ({ ...b, side: plain(b.side) })), p_round: String(round) }).then(({ data, error }) => {
          if (error) {
            showToast(errText(error));
            setBets([]);
            return go(Math.floor(Math.random() * 37), 0, 0, () => {});
          }
          const r = data as { number: number; payout: number; stake: number; balance: number };
          const release = holdWinnings(r.payout); // stake leaves now, winnings arrive when the ball stops
          applyBalance(r.balance);
          go(r.number, r.payout, r.stake, release);
        });
      } else go(wheelNumber(), 0, 0, () => {});
    } else if (phase === "result") {
      setBets([]);
      setCrowd([]);
      setResult(null);
      setRound((r) => r + 1);
      setPhase("betting");
      setEndsAt(Date.now() + BET_SECS * 1000);
    }
  }, [now, endsAt, phase, round, spinTo, showToast, applyBalance, holdWinnings]);

  const pending = bets.reduce((a, b) => a + b.v, 0);
  const crowdTotal = crowd.reduce((a, b) => a + b.v, 0);
  const mine = (side: string) => bets.filter((b) => b.side === side).reduce((a, b) => a + b.v, 0);
  const secs = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const lastTick = useRef(-1);
  useEffect(() => {
    if (phase !== "betting" || secs === lastTick.current) return;
    lastTick.current = secs;
    if (secs <= 5 && secs > 0) sfx.tickUrgent();
  }, [secs, phase]);
  const shown = phase === "result" && result ? result.n : null;

  const place = (side: string) => {
    if (phase !== "betting") return showToast("Wait for the next round");
    if (pending + chip > total) return showToast("Not enough coins — ask your agent");
    if (pending + chip > MAX_STAKE) return showToast("Max 1,00,000 coins per round");
    sfx.chip();
    setBets((b) => [...b, { side, v: chip }]);
  };
  const rebet = () => {
    if (phase !== "betting" || bets.length || !lastBets.length) return;
    const sum = lastBets.reduce((a, b) => a + b.v, 0);
    if (sum > total) return showToast("Not enough balance to rebet");
    sfx.chip();
    setBets(lastBets);
  };
  // Double every chip on the table (or last round's bets, if the table is empty).
  const double = () => {
    const base = bets.length ? bets : lastBets;
    if (phase !== "betting" || !base.length) return;
    const next = 2 * base.reduce((a, b) => a + b.v, 0);
    if (next > total) return showToast("Not enough coins to double");
    if (next > MAX_STAKE) return showToast("Max 1,00,000 coins per round");
    sfx.chip();
    setBets(base.map((b) => ({ ...b, v: b.v * 2 })));
  };

  const spinning = phase === "spinning" || phase === "result";
  const NUM = "font-serif text-[19px] leading-none";

  return (
    <LandscapeStage className="roulette-room">
      <div className="absolute inset-0 flex flex-col select-none overflow-hidden">
        {/* Top: back, last numbers, balance */}
        <div className="h-[13%] min-h-[44px] flex items-center gap-2 px-3 relative z-30">
          <button onClick={nav.back} className="w-9 h-9 rounded-full bg-black/35 border border-white/20 grid place-items-center shrink-0" aria-label="Back"><ChevronLeft size={20} /></button>
          <HomeButton className="w-9 h-9 rounded-full bg-black/35 border border-white/20 grid place-items-center shrink-0" />
          <button onClick={() => showToast("Bet before the timer runs out. Number 36x • Split (line between 2 numbers) 18x • Street (edge of a line of 3) 12x • Trio (0 with 2 numbers) 12x • Corner (4 numbers) 9x • First four (0-1-2-3) 9x • Six line (edge between 2 lines) 6x • Row / Dozen 3x • Red, Black, Even, Odd, 1-18, 19-36 2x")} className="w-9 h-9 rounded-full bg-black/35 border border-white/20 grid place-items-center shrink-0" aria-label="Rules"><Info size={18} /></button>
          <div className="flex-1 flex justify-center min-w-0">
            <div className="flex items-center gap-1 rounded-b-xl bg-[#1b2a22]/90 border border-[#c9a24a]/50 px-2 py-1 overflow-hidden max-w-full">
              <span className="w-7 h-6 rounded bg-[#14532d] grid place-items-center shrink-0"><TrendingUp size={15} className="text-gold-300" /></span>
              {(hist.length ? hist : []).slice(0, 12).map((n, i) => (
                <span key={`${hist.length}-${i}`} className={`min-w-[26px] h-6 px-1 rounded grid place-items-center text-[13px] font-bold shrink-0 ${i === 0 ? "ring-2 ring-gold-300 pop" : ""}`} style={{ background: color(n) }}>{n}</span>
              ))}
              {!hist.length && <span className="text-[11px] text-white/60 px-2">Last numbers show here</span>}
            </div>
          </div>
          <div className="shrink-0 rounded-full bg-gradient-to-b from-amber-300 to-amber-500 text-slate-900 font-bold text-sm px-3 py-1.5 shadow-[0_2px_0_#92400e]">
            🪙 {(total - (phase === "betting" ? pending : 0)).toLocaleString("en-IN")}
          </div>
        </div>

        {/* Middle: wheel + board */}
        <div className="flex-1 min-h-0 relative">
          {/* bet totals + timer */}
          <div className="absolute left-[22%] right-[2%] top-0 h-[16%] flex items-center justify-center gap-3 z-20">
            <div className="rounded-full bg-[#0f3d22]/80 border border-white/15 px-4 py-0.5 text-[13px] min-w-[120px] text-center">Your bet <b className="text-gold-300">{pending.toLocaleString("en-IN")}</b></div>
            <div className={`relative w-10 h-10 grid place-items-center ${phase === "betting" && secs <= 5 ? "animate-pulse" : ""}`}>
              <AlarmClock size={40} className="absolute inset-0 text-amber-300 drop-shadow" strokeWidth={1.6} />
              <span className="relative mt-1 w-[26px] h-[26px] rounded-full bg-white grid place-items-center text-[13px] font-extrabold text-slate-900">{phase === "betting" ? secs : "–"}</span>
            </div>
            <div className="rounded-full bg-[#0f3d22]/80 border border-white/15 px-4 py-0.5 text-[13px] min-w-[120px] text-center">Total bet <b className="text-gold-300">{(pending + crowdTotal).toLocaleString("en-IN")}</b></div>
          </div>

          {/* Board */}
          <div className="absolute left-[22%] right-[2%] top-[17%] bottom-[3%]">
            <div className="w-full h-full grid" style={{ gridTemplateColumns: "1.15fr repeat(12, 1fr) 1.35fr", gridTemplateRows: "repeat(3, 1fr) .72fr .72fr" }}>
              <Spot bets={bets} shown={shown} onPlace={place} side="n_0" className="rounded-l-xl flex-col" style={{ gridColumn: 1, gridRow: "1 / 4", background: GREEN }}>
                <span className={`${NUM} text-[24px]`}>0</span><span className="text-[10px] text-white/80 mt-1">36x</span>
              </Spot>
              {[3, 2, 1].map((rowTop, r) =>
                Array.from({ length: 12 }, (_, c) => {
                  const n = rowTop + c * 3;
                  return (
                    <Spot bets={bets} shown={shown} onPlace={place} key={n} side={`n_${n}`} style={{ gridColumn: c + 2, gridRow: r + 1, background: color(n) }}>
                      <span className={NUM}>{n}</span>
                    </Spot>
                  );
                }),
              )}
              {/* Split and corner bets: tap the line between two numbers, or the corner where four meet */}
              <div className="relative pointer-events-none z-[15]" style={{ gridColumn: "2 / 14", gridRow: "1 / 4" }}>
                {[0, 1, 2].map((r) =>
                  Array.from({ length: 12 }, (_, c) => {
                    const n = 3 - r + c * 3; // number in this cell (top row 3, 6, 9 …)
                    const zones: { side: string; x: number; y: number; w: number; h: number }[] = [];
                    if (c < 11) zones.push({ side: `s_${n}_${n + 3}`, x: c + 1, y: r + 0.5, w: 0.36, h: 0.55 }); // with the cell to the right
                    if (r < 2) zones.push({ side: `s_${n - 1}_${n}`, x: c + 0.5, y: r + 1, w: 0.55, h: 0.36 }); // with the cell below
                    if (c < 11 && r < 2) zones.push({ side: `q_${n - 1}_${n}_${n + 2}_${n + 3}`, x: c + 1, y: r + 1, w: 0.4, h: 0.4 }); // corner
                    // On the outer edge (below the 1, 4, 7 … row): a street on each line, a six line between two lines.
                    if (r === 2) zones.push({ side: `st_${n}`, x: c + 0.5, y: 3, w: 0.55, h: 0.36 });
                    if (r === 2 && c < 11) zones.push({ side: `sl_${n}`, x: c + 1, y: 3, w: 0.4, h: 0.4 });
                    // Along the zero: a split with 3 / 2 / 1, trios 0-2-3 and 0-1-2 on the corners, first four at the foot.
                    if (c === 0) zones.push({ side: `s_0_${n}`, x: 0, y: r + 0.5, w: 0.36, h: 0.55 });
                    if (c === 0 && r < 2) zones.push({ side: `t_0_${n - 1}_${n}`, x: 0, y: r + 1, w: 0.4, h: 0.4 });
                    if (c === 0 && r === 2) zones.push({ side: "ff", x: 0, y: 3, w: 0.4, h: 0.4 });
                    // The far end (34-35-36 against the row boxes): the whole edge is Street 34-36, its two corners the
                    // splits 34/35 and 35/36.
                    if (c === 11 && r === 1) zones.push({ side: "st_34@end", x: 12, y: 1.5, w: 0.36, h: 3 });
                    if (c === 11 && r < 2) zones.push({ side: `s_${n - 1}_${n}@end`, x: 12, y: r + 1, w: 0.4, h: 0.4 });
                    // …and its two outer corners (by 36 at the top, by 34 against the dozens) are Street 34-36 too.
                    // (each sits a little inside its corner so the chip stays on the numbers, not over the rim / dozens)
                    if (c === 11 && r === 0) zones.push({ side: "st_34@c0", x: 12, y: 0.25, w: 0.45, h: 0.5 });
                    if (c === 11 && r === 2) zones.push({ side: "st_34@c3", x: 12, y: 2.75, w: 0.45, h: 0.5 });
                    return zones.map((z) => <BetZone key={z.side} {...z} bets={bets} shown={shown} onPlace={place} />);
                  }),
                )}
              </div>
              {[["c3", "1st row"], ["c2", "2nd row"], ["c1", "3rd row"]].map(([s, l], r) => (
                <Spot bets={bets} shown={shown} onPlace={place} key={s} side={s} className={`flex-col text-[10px] leading-tight bg-[#1f6b3a] ${r === 0 ? "rounded-tr-xl" : r === 2 ? "rounded-br-xl" : ""}`} style={{ gridColumn: 14, gridRow: r + 1 }}>
                  <span>{l}</span><span>3x</span>
                </Spot>
              ))}
              {[["d1", "1st 12 (3x)"], ["d2", "2nd 12 (3x)"], ["d3", "3rd 12 (3x)"]].map(([s, l], i) => (
                <Spot bets={bets} shown={shown} onPlace={place} key={s} side={s} className="font-serif text-[14px] bg-[#257a42]" style={{ gridColumn: `${2 + i * 4} / span 4`, gridRow: 4 }}>{l}</Spot>
              ))}
              {[
                ["low", "1-18 (2x)"],
                ["even", "Even (2x)"],
                ["red", "2x"],
                ["black", "2x"],
                ["odd", "Odd (2x)"],
                ["high", "19-36 (2x)"],
              ].map(([s, l], i) => (
                <Spot
                  bets={bets}
                  shown={shown}
                  onPlace={place}
                  key={s}
                  side={s}
                  className={`font-serif text-[14px] ${i === 0 ? "rounded-bl-xl" : ""} ${i === 5 ? "rounded-br-xl" : ""}`}
                  style={{ gridColumn: `${2 + i * 2} / span 2`, gridRow: 5, background: s === "red" ? RED : s === "black" ? BLACK : "#257a42" }}
                >
                  {l}
                </Spot>
              ))}
            </div>
          </div>

          {/* Dim the board while the wheel is in front */}
          <div className={`absolute inset-0 z-20 bg-black/35 transition-opacity duration-500 pointer-events-none ${spinning ? "opacity-100" : "opacity-0"}`} />

          {/* Wheel: peeks in from the left while betting, slides in to spin */}
          <div
            className="absolute top-1/2 z-30 aspect-square pointer-events-none"
            style={{
              height: "112%",
              left: 0,
              transform: `translate(${spinning ? "6%" : "-58%"}, -50%)`,
              transition: "transform .7s cubic-bezier(.3,.8,.3,1)",
              willChange: "transform",
            }}
          >
            <Wheel wheelRef={wheelEl} ballRef={ballEl} visible={spinning} />
            {shown !== null && (
              <div className="absolute top-1/2 -translate-y-1/2 left-[104%] pop">
                <div className="w-[86px] h-[86px] rounded-xl bg-[#14532d] border-2 border-[#9fd8a9]/60 grid place-items-center shadow-2xl">
                  <div className="w-[62px] h-[62px] rounded-full grid place-items-center font-serif text-[30px] font-bold border-2 border-white/60" style={{ background: color(shown) }}>{shown}</div>
                </div>
              </div>
            )}
          </div>

          {/* Your result */}
          {phase === "result" && result && result.stake > 0 && (
            <div className="absolute left-1/2 bottom-[8%] -translate-x-1/2 z-40 pop">
              <div className={`rounded-full px-5 py-2 font-bold text-[15px] shadow-xl ${result.payout > 0 ? "bg-gradient-to-b from-amber-300 to-amber-500 text-slate-900" : "bg-black/70 text-white"}`}>
                {result.payout > 0 ? `🎉 You won ${inr(result.payout)}` : `${result.n} • Better luck next round`}
              </div>
            </div>
          )}
          {phase === "spinning" && (
            <div className="absolute left-[60%] top-[45%] -translate-x-1/2 z-40 text-[15px] font-semibold text-white/90 drop-shadow">No more bets</div>
          )}
        </div>

        {/* Bottom bar: player, chips, rebet */}
        <div className="h-[17%] min-h-[54px] relative z-30 flex items-center gap-3 px-3 bg-gradient-to-t from-black/55 to-black/20 border-t border-[#c9a24a]/40">
          <div className="flex flex-col items-center text-[10px] text-white/80 shrink-0">
            <Users size={18} />
            {online}
          </div>
          <div className="flex items-center gap-2 shrink-0 rounded-xl bg-black/35 pl-1 pr-3 py-1">
            <Avatar size={34} />
            <div className="leading-tight">
              <div className="text-[12px] font-medium max-w-[90px] truncate">{player?.first ?? "You"}</div>
              <div className="text-[12px] text-gold-300 font-semibold">🪙 {(total - (phase === "betting" ? pending : 0)).toLocaleString("en-IN")}</div>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0">
            {CHIPS.map((c) => (
              <button key={c.v} onClick={() => setChip(c.v)} className={`transition-transform ${chip === c.v ? "-translate-y-1.5 drop-shadow-[0_0_10px_#fde047]" : ""}`} aria-label={`Chip ${c.v}`}>
                <MiniChip v={c.v} size={38} ring={chip === c.v} />
              </button>
            ))}
          </div>
          <button onClick={() => setBets((b) => b.slice(0, -1))} disabled={phase !== "betting" || !bets.length} className="w-10 h-10 rounded-full bg-black/40 border border-white/20 grid place-items-center disabled:opacity-35 shrink-0" aria-label="Undo"><Undo2 size={18} /></button>
          <button onClick={rebet} disabled={phase !== "betting" || !!bets.length || !lastBets.length} className="w-10 h-10 rounded-full bg-black/40 border border-white/20 grid place-items-center disabled:opacity-35 shrink-0" aria-label="Rebet"><Repeat size={18} /></button>
          <button onClick={double} disabled={phase !== "betting" || (!bets.length && !lastBets.length)} className="w-10 h-10 rounded-full bg-black/40 border border-white/20 grid place-items-center disabled:opacity-35 shrink-0 text-[13px] font-extrabold text-gold-300" aria-label="Double">x2</button>
        </div>
        <div className="absolute right-3 bottom-[18%] text-[10px] text-white/45 z-10">Round #{round}</div>
      </div>
    </LandscapeStage>
  );
}

/** Casino chip in one of the table colours (by value). */
/**
 * One betting spot: your stack and the win glow. Defined outside Roulette so React keeps the same element across
 * the round clock's re-renders (a component created inside render is torn down and rebuilt every tick, which
 * made the chips flicker and could swallow a tap).
 */
function Spot({ side, bets, shown, onPlace, children, className = "", style }: {
  side: string; bets: Bet[]; shown: number | null; onPlace: (side: string) => void; children: React.ReactNode; className?: string; style?: React.CSSProperties;
}) {
  const my = bets.reduce((a, b) => (b.side === side ? a + b.v : a), 0);
  const win = shown !== null && wins(side, shown);
  return (
    <button
      data-sfx="off"
      onClick={() => onPlace(side)}
      className={`relative grid place-items-center border border-[#9fd8a9]/45 text-white transition-[filter,box-shadow] active:brightness-125 ${win ? "z-10 shadow-[inset_0_0_0_3px_#fde047,0_0_16px_#fde047]" : ""} ${className}`}
      style={style}
    >
      {children}
      {my > 0 && (
        <span className="absolute pointer-events-none z-10" style={{ left: "50%", top: "50%", transform: "translate(-50%,-50%)" }}>
          <span className="absolute left-0 top-[3px] opacity-80"><MiniChip v={my} size={30} /></span>
          <span className="relative block"><MiniChip v={my} size={30} ring /></span>
        </span>
      )}
    </button>
  );
}

/** A split / corner / street / six line / trio hot spot on a line or corner of the number grid (x, y, w, h in cells:
 *  12 columns × 3 rows). */
function BetZone({ side, x, y, w, h, bets, shown, onPlace }: {
  side: string; x: number; y: number; w: number; h: number; bets: Bet[]; shown: number | null; onPlace: (side: string) => void;
}) {
  const my = bets.reduce((a, b) => (b.side === side ? a + b.v : a), 0);
  const win = shown !== null && my > 0 && wins(side, shown);
  return (
    <button
      data-sfx="off"
      onClick={() => onPlace(side)}
      aria-label={rouletteSide(plain(side))}
      className={`absolute pointer-events-auto grid place-items-center ${/^(q_|t_|sl_|ff)/.test(side) || /^s_.*@end$/.test(side) || /@c\d$/.test(side) ? "z-[2]" : "z-[1]"}`}
      style={{ left: `${((x - w / 2) / 12) * 100}%`, top: `${((y - h / 2) / 3) * 100}%`, width: `${(w / 12) * 100}%`, height: `${(h / 3) * 100}%` }}
    >
      {my > 0 && (
        // A chip on the grid's outer edge (streets, six lines, first four, the far end) is drawn just inside the
        // numbers rather than over the line, so it never hangs over the dozens, the row boxes or the rim.
        <span className={`pointer-events-none rounded-full ${win ? "shadow-[0_0_14px_4px_#fde047]" : ""}`} style={{ transform: `translate(${x >= 12 ? -55 : 0}%, ${y >= 3 ? -55 : 0}%)` }}><MiniChip v={my} size={24} ring /></span>
      )}
    </button>
  );
}

function MiniChip({ v, size, faded, ring }: { v: number; size: number; faded?: boolean; ring?: boolean }) {
  const c = [...CHIPS].reverse().find((x) => v >= x.v)?.c ?? CHIPS[0].c;
  return (
    <span
      className={`rounded-full grid place-items-center font-bold text-white shrink-0 ${ring ? "ring-2 ring-gold-300" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size * (short(v).length > 3 ? 0.24 : 0.3),
        opacity: faded ? 0.85 : 1,
        background: `radial-gradient(circle, ${c} 50%, transparent 51%), repeating-conic-gradient(#f8fafc 0 14deg, ${c} 14deg 30deg)`,
        boxShadow: "0 2px 4px rgba(0,0,0,.55)",
      }}
    >
      <span className="rounded-full grid place-items-center" style={{ width: size * 0.64, height: size * 0.64, border: "1px dashed rgba(255,255,255,.75)" }}>
        {faded ? "" : short(v)}
      </span>
    </span>
  );
}

/** Wooden wheel: numbers on the outer ring, pockets inside, gold turret; the ball drops into the pocket on top. */
// The rotating parts are HTML layers turned with CSS transforms (will-change), so the browser spins them on the
// GPU; the wheel is memoised so the round clock re-rendering the table doesn't touch it mid-spin.
const Wheel = memo(function Wheel({ wheelRef, ballRef, visible }: { wheelRef: React.RefObject<HTMLDivElement | null>; ballRef: React.RefObject<HTMLDivElement | null>; visible: boolean }) {
  const seg = 360 / ORDER.length;
  const p = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
  const ring = (r0: number, r1: number, i: number) => {
    const a0 = ((i - 0.5) * seg - 90) * (Math.PI / 180), a1 = ((i + 0.5) * seg - 90) * (Math.PI / 180);
    return `M${p(r0, a0)} L${p(r1, a0)} A${r1},${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 0 0 ${p(r0, a0)} Z`;
  };
  return (
    <div className="relative w-full h-full">
      <svg viewBox="-112 -112 224 224" className="absolute inset-0 w-full h-full" style={{ filter: "drop-shadow(6px 10px 18px rgba(0,0,0,.55))" }}>
        <defs>
          <radialGradient id="rl-wood" cx=".45" cy=".4">
            <stop offset="0" stopColor="#8a5530" />
            <stop offset=".7" stopColor="#5e3518" />
            <stop offset="1" stopColor="#3a1f0d" />
          </radialGradient>
        </defs>
        <circle r="111" fill="url(#rl-wood)" stroke="#2a1608" strokeWidth="2" />
        <circle r="97" fill="#2a1608" />
      </svg>
      <div ref={wheelRef} className="absolute inset-0" style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        <svg viewBox="-112 -112 224 224" className="absolute inset-0 w-full h-full">
          <defs>
            <radialGradient id="rl-cone" cx=".45" cy=".4">
              <stop offset="0" stopColor="#7a4a26" />
              <stop offset="1" stopColor="#3f220f" />
            </radialGradient>
            <radialGradient id="rl-gold" cx=".4" cy=".35">
              <stop offset="0" stopColor="#fff3c4" />
              <stop offset=".5" stopColor="#d4a640" />
              <stop offset="1" stopColor="#7c5a12" />
            </radialGradient>
          </defs>
          {ORDER.map((n, i) => {
            const mid = (i * seg - 90) * (Math.PI / 180);
            const tx = 86 * Math.cos(mid), ty = 86 * Math.sin(mid);
            return (
              <g key={n}>
                <path d={ring(76, 95, i)} fill={color(n)} stroke="#d4a640" strokeWidth=".5" />
                <path d={ring(62, 76, i)} fill={color(n)} stroke="#d4a640" strokeWidth=".5" opacity=".85" />
                <text x={tx} y={ty} fill="#fff" fontSize="9" fontWeight="700" fontFamily="serif" textAnchor="middle" dominantBaseline="central" transform={`rotate(${i * seg} ${tx} ${ty})`}>{n}</text>
              </g>
            );
          })}
          <circle r="62" fill="url(#rl-cone)" stroke="#d4a640" strokeWidth="1.2" />
          {[0, 90, 180, 270].map((a) => (
            <g key={a} transform={`rotate(${a})`}>
              <rect x="-2" y="-44" width="4" height="36" rx="2" fill="url(#rl-gold)" />
              <circle cy="-46" r="3.6" fill="url(#rl-gold)" />
            </g>
          ))}
          <circle r="13" fill="url(#rl-gold)" stroke="#7c5a12" />
          <circle r="5" fill="#fff3c4" />
        </svg>
      </div>
      {/* Ball (placed by spinTo) */}
      {visible && (
        <div
          ref={ballRef}
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: `${(BALL_UNITS / 224) * 100}%`,
            height: `${(BALL_UNITS / 224) * 100}%`,
            transform: `translate(-50%, -50%) translateY(${(-BALL_RIM_R / BALL_UNITS) * 100}%)`,
            willChange: "transform",
            background: "radial-gradient(circle at 35% 35%, #fff, #e5e7eb 60%, #9ca3af)",
            boxShadow: "0 1px 3px rgba(0,0,0,.6)",
          }}
        />
      )}
    </div>
  );
});
