"use client";

import { sfx, vibrate } from "../../lib/sound";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, ChevronLeft, Info, Repeat, TrendingUp, Undo2, Users } from "lucide-react";
import { gameById, inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Avatar } from "../ui";
import { LandscapeStage } from "./LandscapeStage";
import type { Nav } from "../nav";

// European roulette (single zero), laid out like casino roulette apps: a landscape green table, the wheel
// peeking in from the left, timed rounds that run on their own (25 s to bet, then the wheel slides in and spins).
// The database spins and pays every bet (supabase/migrations/012_roulette_blackjack_plinko.sql); a round you
// didn't bet on is spun on the device just for show.

const BET_SECS = 25;
const SPIN_MS = 5200;
const RESULT_MS = 3800;
const MAX_STAKE = 100000;
const CHIPS: { v: number; c: string }[] = [
  { v: 10, c: "#16a34a" },
  { v: 50, c: "#0d9488" },
  { v: 100, c: "#2563eb" },
  { v: 1000, c: "#ca8a04" },
  { v: 5000, c: "#ea580c" },
  { v: 10000, c: "#dc2626" },
];
const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RED = "#c9454d";
const BLACK = "#1b3a33";
const GREEN = "#2f9d4e";
const color = (n: number) => (n === 0 ? GREEN : REDS.has(n) ? RED : BLACK);
const short = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}K` : String(v));
const norm = (d: number) => ((d % 360) + 360) % 360;

/** Does a bet win on number n? (Display only — the server settles every bet.) */
function wins(side: string, n: number) {
  if (side.startsWith("n_")) return Number(side.slice(2)) === n;
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
  const { total, player, showToast, applyBalance } = useStore();
  const [phase, setPhase] = useState<Phase>("betting");
  const [endsAt, setEndsAt] = useState(() => Date.now() + BET_SECS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [chip, setChip] = useState(10);
  const [bets, setBets] = useState<Bet[]>([]);
  const [lastBets, setLastBets] = useState<Bet[]>([]);
  const [crowd, setCrowd] = useState<{ side: string; v: number; dx: number; dy: number }[]>([]);
  const [hist, setHist] = useState<number[]>([]);
  const [result, setResult] = useState<{ n: number; payout: number; stake: number } | null>(null);
  const [wheelRot, setWheelRot] = useState(0);
  const [ballRot, setBallRot] = useState(0);
  const [ballIn, setBallIn] = useState(false);
  const [round, setRound] = useState(() => 40000 + Math.floor(Math.random() * 900));
  const betsRef = useRef(bets);
  betsRef.current = bets;
  const busy = useRef(false);

  useEffect(() => {
    supabase().rpc("rl_history").then(({ data }) => Array.isArray(data) && data.length && setHist(data as number[]));
  }, []);
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
    const idx = ORDER.indexOf(n);
    setBallIn(false);
    setWheelRot((cur) => cur - norm(cur) + 360 * 4 + norm(-(idx * 360) / ORDER.length));
    setBallRot((cur) => cur - norm(cur) - 360 * 7);
    sfx.wheel(SPIN_MS);
    window.setTimeout(() => setBallIn(true), SPIN_MS * 0.72);
  }, []);

  // Round clock: betting → spin (server settles your bets) → result → next round.
  useEffect(() => {
    if (now < endsAt || busy.current) return;
    if (phase === "betting") {
      const placed = betsRef.current;
      busy.current = true;
      setPhase("spinning");
      setEndsAt(Number.MAX_SAFE_INTEGER);
      const go = (n: number, payout: number, stake: number, balance: number | null) => {
        spinTo(n);
        window.setTimeout(() => {
          setResult({ n, payout, stake });
          if (payout > 0) { sfx.win(); vibrate(50); } else if (stake > 0) sfx.lose();
          setHist((h) => [n, ...h].slice(0, 20));
          if (balance !== null) applyBalance(balance);
          setPhase("result");
          setEndsAt(Date.now() + RESULT_MS);
          busy.current = false;
        }, SPIN_MS + 300);
      };
      if (placed.length) {
        setLastBets(placed);
        supabase().rpc("roulette_spin", { p_bets: placed }).then(({ data, error }) => {
          if (error) {
            showToast(errText(error));
            setBets([]);
            return go(Math.floor(Math.random() * 37), 0, 0, null);
          }
          const r = data as { number: number; payout: number; stake: number; balance: number };
          applyBalance(r.balance - r.payout); // stake leaves now, winnings arrive when the ball stops
          go(r.number, r.payout, r.stake, r.balance);
        });
      } else go(Math.floor(Math.random() * 37), 0, 0, null);
    } else if (phase === "result") {
      setBets([]);
      setCrowd([]);
      setResult(null);
      setBallIn(false);
      setRound((r) => r + 1);
      setPhase("betting");
      setEndsAt(Date.now() + BET_SECS * 1000);
    }
  }, [now, endsAt, phase, spinTo, showToast, applyBalance]);

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

  const spinning = phase === "spinning" || phase === "result";
  const NUM = "font-serif text-[19px] leading-none";

  return (
    <LandscapeStage className="roulette-room">
      <div className="absolute inset-0 flex flex-col select-none overflow-hidden">
        {/* Top: back, last numbers, balance */}
        <div className="h-[13%] min-h-[44px] flex items-center gap-2 px-3 relative z-30">
          <button onClick={nav.back} className="w-9 h-9 rounded-full bg-black/35 border border-white/20 grid place-items-center shrink-0" aria-label="Back"><ChevronLeft size={20} /></button>
          <button onClick={() => showToast("Bet before the timer runs out. Number 36x • Row / Dozen 3x • Red, Black, Even, Odd, 1-18, 19-36 2x")} className="w-9 h-9 rounded-full bg-black/35 border border-white/20 grid place-items-center shrink-0" aria-label="Rules"><Info size={18} /></button>
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
            <Wheel rot={wheelRot} ball={ballRot} ballIn={ballIn} visible={spinning} />
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
            {Math.floor(game.online / 60)}
          </div>
          <div className="flex items-center gap-2 shrink-0 rounded-xl bg-black/35 pl-1 pr-3 py-1">
            <Avatar size={34} />
            <div className="leading-tight">
              <div className="text-[12px] font-medium max-w-[90px] truncate">{player?.first ?? "You"}</div>
              <div className="text-[12px] text-gold-300 font-semibold">🪙 {(total - (phase === "betting" ? pending : 0)).toLocaleString("en-IN")}</div>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center gap-2.5 min-w-0">
            {CHIPS.map((c) => (
              <button key={c.v} onClick={() => setChip(c.v)} className={`transition-transform ${chip === c.v ? "-translate-y-1.5 drop-shadow-[0_0_10px_#fde047]" : ""}`} aria-label={`Chip ${c.v}`}>
                <MiniChip v={c.v} size={44} ring={chip === c.v} />
              </button>
            ))}
          </div>
          <button onClick={() => setBets((b) => b.slice(0, -1))} disabled={phase !== "betting" || !bets.length} className="w-10 h-10 rounded-full bg-black/40 border border-white/20 grid place-items-center disabled:opacity-35 shrink-0" aria-label="Undo"><Undo2 size={18} /></button>
          <button onClick={rebet} disabled={phase !== "betting" || !!bets.length || !lastBets.length} className="w-10 h-10 rounded-full bg-black/40 border border-white/20 grid place-items-center disabled:opacity-35 shrink-0" aria-label="Rebet"><Repeat size={18} /></button>
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
const Wheel = memo(function Wheel({ rot, ball, ballIn, visible }: { rot: number; ball: number; ballIn: boolean; visible: boolean }) {
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
      <div
        className="absolute inset-0"
        style={{ transform: `rotate(${rot}deg)`, transition: visible ? `transform ${SPIN_MS}ms cubic-bezier(.15,.55,.2,1)` : "none", willChange: "transform", backfaceVisibility: "hidden" }}
      >
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
      {/* Ball */}
      {visible && (
        <div className="absolute inset-0" style={{ transform: `rotate(${ball}deg)`, transition: `transform ${SPIN_MS}ms cubic-bezier(.2,.65,.25,1)`, willChange: "transform" }}>
          <div
            className="absolute left-1/2 rounded-full"
            style={{
              width: "5%",
              height: "5%",
              top: "3%",
              transform: `translate(-50%, ${ballIn ? 274 : 0}%)`,
              transition: "transform .9s cubic-bezier(.5,0,.4,1.4)",
              background: "radial-gradient(circle at 35% 35%, #fff, #e5e7eb 60%, #9ca3af)",
              boxShadow: "0 1px 3px rgba(0,0,0,.6)",
            }}
          />
        </div>
      )}
    </div>
  );
});
