"use client";

import { useEffect, useRef, useState } from "react";
import { Repeat, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Chip, Header, Money } from "../ui";
import type { Nav } from "../nav";

// European roulette (single zero). The database spins and pays every bet (supabase/migrations/012_roulette_blackjack_plinko.sql);
// this screen lays out the board, sends the chips and turns the wheel to the number the server drew.

const CHIPS: { v: number; c: string }[] = [
  { v: 10, c: "#2563eb" },
  { v: 50, c: "#16a34a" },
  { v: 100, c: "#e11d48" },
  { v: 500, c: "#7c3aed" },
  { v: 1000, c: "#d97706" },
];
const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const color = (n: number) => (n === 0 ? "#15803d" : REDS.has(n) ? "#dc2626" : "#111827");
const SPIN_MS = 4200;

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

export function Roulette({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance } = useStore();
  const [chip, setChip] = useState(100);
  const [bets, setBets] = useState<Bet[]>([]);
  const [lastBets, setLastBets] = useState<Bet[]>([]);
  const [spinning, setSpinning] = useState(false);
  const [rot, setRot] = useState(0);
  const [result, setResult] = useState<{ n: number; payout: number; stake: number } | null>(null);
  const [hist, setHist] = useState<number[]>([]);
  const pendingHist = useRef<number[] | null>(null);

  useEffect(() => {
    supabase().rpc("rl_history").then(({ data }) => Array.isArray(data) && setHist(data as number[]));
  }, []);

  const pending = bets.reduce((a, b) => a + b.v, 0);
  const mine = (side: string) => bets.filter((b) => b.side === side).reduce((a, b) => a + b.v, 0);
  const shown = result && !spinning ? result.n : null;

  const place = (side: string) => {
    if (spinning) return;
    if (result) { setResult(null); setBets([]); }
    const base = result ? 0 : pending;
    if (base + chip > total) return showToast("Not enough coins — ask your agent");
    if (base + chip > 100000) return showToast("Max 100,000 coins per spin");
    setBets((b) => [...(result ? [] : b), { side, v: chip }]);
  };

  const spin = async () => {
    if (spinning || !bets.length) return;
    setSpinning(true);
    setResult(null);
    const { data, error } = await supabase().rpc("roulette_spin", { p_bets: bets });
    if (error) { showToast(errText(error)); setSpinning(false); return; }
    const r = data as { number: number; payout: number; stake: number; balance: number; history: number[] };
    setLastBets(bets);
    applyBalance(r.balance - r.payout); // show the stake leaving now, the winnings when the ball stops
    pendingHist.current = r.history;
    // Land the pocket under the pointer at the top: a few full turns plus the pocket's offset.
    const idx = ORDER.indexOf(r.number);
    setRot((cur) => {
      const target = -(idx * 360) / ORDER.length;
      const base = cur - (((cur % 360) + 360) % 360);
      return base - 360 * 5 + ((target % 360) + 360) % 360 - 360;
    });
    window.setTimeout(() => {
      setSpinning(false);
      setResult({ n: r.number, payout: r.payout, stake: r.stake });
      applyBalance(r.balance);
      if (pendingHist.current) setHist(pendingHist.current);
    }, SPIN_MS);
  };

  const Cell = ({ side, label, className = "", style }: { side: string; label: React.ReactNode; className?: string; style?: React.CSSProperties }) => {
    const my = mine(side);
    const win = shown !== null && wins(side, shown);
    return (
      <button
        onClick={() => place(side)}
        disabled={spinning}
        className={`relative grid place-items-center font-semibold text-[13px] border border-white/25 transition-all active:scale-95 ${win ? "ring-2 ring-gold-300 z-10 shadow-[0_0_14px_rgba(253,224,71,.6)]" : ""} ${className}`}
        style={style}
      >
        {label}
        {my > 0 && (
          <span className="absolute -top-1.5 -right-1 pop pill px-1 text-[9px] font-bold bg-gold-400 text-slate-900 shadow z-20">{my >= 1000 ? `${Math.round(my / 100) / 10}K` : my}</span>
        )}
      </button>
    );
  };

  const seg = 360 / ORDER.length;
  return (
    <div className="pb-6 fadein min-h-dvh flex flex-col">
      <Header
        title="Roulette"
        sub="European • Min 🪙 10 • Max 🪙 100,000 per spin"
        onBack={nav.back}
        right={<div className="text-right"><div className="text-[10px] text-white/50">Balance</div><Money n={total - (spinning || result ? 0 : pending)} className="text-sm font-semibold text-neon-400" /></div>}
      />

      <div className="px-4">
        <div className="flex gap-1 overflow-x-auto no-scrollbar min-h-6">
          {hist.map((n, i) => (
            <span key={i} className={`min-w-6 h-6 px-1 rounded-full grid place-items-center text-[11px] font-bold shrink-0 ${i === 0 ? "ring-2 ring-white/70" : ""}`} style={{ background: color(n) }}>{n}</span>
          ))}
          {!hist.length && <span className="text-[12px] text-white/40">Your last spins show here</span>}
        </div>

        {/* Wheel */}
        <div className="relative mx-auto mt-4" style={{ width: 230, height: 230 }}>
          <div className="absolute left-1/2 -top-1 -translate-x-1/2 z-10 w-0 h-0" style={{ borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "16px solid #fbbf24", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.6))" }} />
          <svg
            viewBox="-110 -110 220 220"
            className="w-full h-full rounded-full"
            style={{ transform: `rotate(${rot}deg)`, transition: spinning ? `transform ${SPIN_MS}ms cubic-bezier(.15,.65,.2,1)` : "none", filter: "drop-shadow(0 8px 18px rgba(0,0,0,.55))" }}
          >
            <circle r="108" fill="#78350f" stroke="#a16207" strokeWidth="4" />
            {ORDER.map((n, i) => {
              const a0 = ((i - 0.5) * seg - 90) * (Math.PI / 180), a1 = ((i + 0.5) * seg - 90) * (Math.PI / 180);
              const R = 100, r = 66;
              const p = (rad: number, a: number) => `${(rad * Math.cos(a)).toFixed(2)},${(rad * Math.sin(a)).toFixed(2)}`;
              const mid = (i * seg - 90) * (Math.PI / 180);
              return (
                <g key={n}>
                  <path d={`M${p(r, a0)} L${p(R, a0)} A${R},${R} 0 0 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 0 0 ${p(r, a0)} Z`} fill={color(n)} stroke="#fcd34d" strokeWidth=".6" />
                  <text x={88 * Math.cos(mid)} y={88 * Math.sin(mid)} fill="#fff" fontSize="8.5" fontWeight="700" textAnchor="middle" dominantBaseline="central" transform={`rotate(${i * seg} ${88 * Math.cos(mid)} ${88 * Math.sin(mid)})`}>{n}</text>
                </g>
              );
            })}
            <circle r="66" fill="#3f1d0b" stroke="#a16207" strokeWidth="2" />
            <circle r="30" fill="#a16207" />
            <circle r="12" fill="#fcd34d" />
          </svg>
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            {shown !== null ? (
              <div className="pop w-16 h-16 rounded-full grid place-items-center text-2xl font-extrabold border-2 border-gold-300" style={{ background: color(shown) }}>{shown}</div>
            ) : spinning ? (
              <div className="w-3.5 h-3.5 rounded-full bg-white shadow-[0_0_10px_#fff]" />
            ) : null}
          </div>
        </div>

        <div className="mt-3 text-center text-sm h-6">
          {spinning && <span className="text-white/70">No more bets…</span>}
          {result && !spinning && (
            <span className={`pop inline-block font-semibold ${result.payout > 0 ? "text-neon-400" : "text-rose-400"}`}>
              {result.payout > 0 ? `🎉 ${result.n} • You won ${inr(result.payout)}!` : `${result.n} • Better luck next spin`}
            </span>
          )}
          {!spinning && !result && pending > 0 && <span className="text-white/70">Your bet: <b className="text-white">{inr(pending)}</b></span>}
        </div>

        {/* Board: 0 on top, numbers in 12 rows of 3, column bets underneath */}
        <div className="mt-2 rounded-2xl felt p-2">
          <Cell side="n_0" label="0" className="w-full h-9 rounded-t-xl" style={{ background: color(0) }} />
          <div className="grid grid-cols-3">
            {Array.from({ length: 36 }, (_, i) => i + 1).map((n) => (
              <Cell key={n} side={`n_${n}`} label={n} className="h-9" style={{ background: color(n) }} />
            ))}
            {["c1", "c2", "c3"].map((c) => <Cell key={c} side={c} label="2:1" className="h-9 bg-white/5 text-[11px]" />)}
          </div>
          <div className="grid grid-cols-3 mt-1.5">
            {[["d1", "1st 12"], ["d2", "2nd 12"], ["d3", "3rd 12"]].map(([s, l]) => <Cell key={s} side={s} label={l} className="h-9 bg-white/5 text-[12px]" />)}
          </div>
          <div className="grid grid-cols-6">
            {[["low", "1-18"], ["even", "Even"], ["red", <span key="r" className="w-4 h-4 rotate-45 bg-red-600 inline-block" />], ["black", <span key="b" className="w-4 h-4 rotate-45 bg-gray-900 border border-white/40 inline-block" />], ["odd", "Odd"], ["high", "19-36"]].map(([s, l]) => (
              <Cell key={s as string} side={s as string} label={l} className="h-10 bg-white/5 text-[11px] rounded-b-md" />
            ))}
          </div>
          <div className="text-center text-[10px] text-white/45 mt-1.5">Number ×36 • Dozen / Column ×3 • Red, Black, Even, Odd, 1-18, 19-36 ×2</div>
        </div>

        {/* Chips */}
        <div className="flex justify-between items-center mt-4 px-1">
          {CHIPS.map((c) => <Chip key={c.v} value={c.v >= 1000 ? "1K" : c.v} color={c.c} size={50} active={chip === c.v} onClick={() => setChip(c.v)} />)}
        </div>

        <div className="grid grid-cols-4 gap-2 mt-4">
          <button disabled={spinning || !bets.length || !!result} onClick={() => setBets((b) => b.slice(0, -1))} className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"><Undo2 size={14} /> Undo</button>
          <button disabled={spinning || !bets.length} onClick={() => { setBets([]); setResult(null); }} className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"><Trash2 size={14} /> Clear</button>
          <button
            disabled={spinning || !lastBets.length}
            onClick={() => {
              const sum = lastBets.reduce((a, b) => a + b.v, 0);
              if (sum > total) return showToast("Not enough balance to rebet");
              setResult(null);
              setBets(lastBets);
            }}
            className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"
          >
            <Repeat size={14} /> Rebet
          </button>
          <button
            disabled={spinning || !bets.length || !!result}
            onClick={() => {
              if (pending * 2 > total) return showToast("Not enough balance to double");
              if (pending * 2 > 100000) return showToast("Max 100,000 coins per spin");
              setBets((b) => [...b, ...b]);
            }}
            className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"
          >
            <RotateCcw size={14} /> Double
          </button>
        </div>

        <button disabled={spinning || !bets.length || !!result} onClick={spin} className="w-full btn-green rounded-2xl py-3.5 mt-3 font-bold text-lg disabled:opacity-50">
          {spinning ? "Spinning…" : result ? "Place new bets" : bets.length ? `SPIN • ${inr(pending)}` : "Tap the board to bet"}
        </button>
        <div className="text-center text-[12px] text-white/35 mt-3">The server draws every number and pays every bet.</div>
      </div>
    </div>
  );
}
