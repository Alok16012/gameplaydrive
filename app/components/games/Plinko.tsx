"use client";

import { sfx } from "../../lib/sound";
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Header, Money } from "../ui";
import type { Nav } from "../nav";

// Plinko. The database decides every bounce and pays the slot (supabase/migrations/012_roulette_blackjack_plinko.sql);
// this screen only replays the path it was given. Several balls can be in the air at once.

type Risk = "low" | "medium" | "high";
const ROWS = [8, 12, 16] as const;
type Rows = (typeof ROWS)[number];
// Same tables as public.plinko_table() — display only.
const MULTS: Record<Rows, Record<Risk, number[]>> = {
  8: { low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6], medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13], high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29] },
  12: { low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10], medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33], high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170] },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};
const QUICK = [10, 50, 100, 500];
const ROW_MS = 150;
const MAX_BALLS = 12;

interface Ball { id: number; path: number[]; start: number; slot: number; mult: number; payout: number; amount: number }

/** Slot colour: gold in the middle, hot pink-red at the edges. */
function slotColor(k: number, n: number) {
  const d = Math.abs(k - (n - 1) / 2) / ((n - 1) / 2);
  const hue = 48 - d * 50;
  return `hsl(${hue < 0 ? 360 + hue : hue} 90% ${55 - d * 8}%)`;
}

export function Plinko({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance } = useStore();
  const [rows, setRows] = useState<Rows>(12);
  const [risk, setRisk] = useState<Risk>("medium");
  const [amount, setAmount] = useState(100);
  const [balls, setBalls] = useState<Ball[]>([]);
  const [hits, setHits] = useState<Record<number, number>>({}); // slot → time it was last hit (for the bounce)
  const [recent, setRecent] = useState<{ mult: number; key: number }[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);
  const latest = useRef({ seq: 0, bal: 0 });
  const unlanded = useRef(0); // payouts already in the server balance whose ball hasn't landed yet

  // Animation clock.
  useEffect(() => {
    let raf = 0;
    const loop = () => { setNow(Date.now()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A tink for every peg a ball passes.
  const rowSeen = useRef<Record<number, number>>({});
  useEffect(() => {
    for (const b of balls) {
      const r = Math.floor((now - b.start) / ROW_MS);
      if (r >= 0 && r < b.path.length && rowSeen.current[b.id] !== r) { rowSeen.current[b.id] = r; sfx.peg(); }
    }
  }, [now, balls]);

  // Balls that reached the bottom: light up the slot and add their winnings to the balance shown.
  useEffect(() => {
    const landed = balls.filter((b) => now >= b.start + (b.path.length + 1) * ROW_MS);
    if (!landed.length) return;
    for (const b of landed) { unlanded.current -= b.payout; delete rowSeen.current[b.id]; }
    if (landed.some((b) => b.mult >= 2)) sfx.win(); else sfx.slot();
    applyBalance(latest.current.bal - unlanded.current);
    setHits((h) => ({ ...h, ...Object.fromEntries(landed.map((b) => [b.slot, now])) }));
    setRecent((r) => [...landed.map((b) => ({ mult: b.mult, key: b.id })), ...r].slice(0, 12));
    setBalls((bs) => bs.filter((b) => !landed.includes(b)));
  }, [now, balls, applyBalance]);

  const drop = async () => {
    if (balls.length >= MAX_BALLS) return;
    if (amount < 10 || amount > 10000) return showToast("Bet between 🪙 10 and 🪙 10,000");
    if (amount > total) return showToast("Not enough coins — ask your agent");
    const my = ++seq.current;
    const { data, error } = await supabase().rpc("plinko_drop", { p_amount: amount, p_rows: rows, p_risk: risk });
    if (error) return showToast(errText(error));
    const r = data as { path: number[]; slot: number; mult: number; payout: number; balance: number };
    unlanded.current += r.payout;
    if (my > latest.current.seq) latest.current = { seq: my, bal: r.balance };
    applyBalance(latest.current.bal - unlanded.current);
    setBalls((bs) => [...bs, { id: my, path: r.path, start: Date.now(), slot: r.slot, mult: Number(r.mult), payout: r.payout, amount }]);
  };

  // Board geometry (viewBox W×H). Row r has r+3 pegs; the ball moves half a peg gap left or right at each row.
  const W = 320;
  const gap = W / (rows + 2);
  const top = 22;
  const dy = gap * 0.86;
  const H = top + rows * dy + 4;
  const cx = W / 2;
  const mults = MULTS[rows][risk];

  const ballPos = (b: Ball): [number, number] => {
    const t = (now - b.start) / ROW_MS;
    const k = Math.min(Math.floor(t), b.path.length);
    const f = Math.min(1, t - k);
    const xAt = (i: number) => cx + (b.path.slice(0, i).reduce((a, s) => a + (s ? 0.5 : -0.5), 0)) * gap;
    const yAt = (i: number) => (i === 0 ? 2 : top + (i - 1) * dy - 7);
    if (k >= b.path.length) return [xAt(b.path.length), Math.min(H + 10, yAt(b.path.length) + f * (dy + 10))];
    const x0 = xAt(k), x1 = xAt(k + 1);
    const y0 = yAt(k), y1 = yAt(k + 1);
    // Small hop off each peg, then fall: y eases in, x moves linearly.
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f * f - Math.sin(f * Math.PI) * (k ? 6 : 0)];
  };

  const flying = balls.length > 0;
  return (
    <div className="pb-6 fadein min-h-dvh flex flex-col">
      <Header
        title="Plinko"
        sub={`${rows} rows • ${risk[0].toUpperCase() + risk.slice(1)} risk • Min 🪙 10 • Max 🪙 10,000`}
        onBack={nav.back}
        right={<div className="text-right"><div className="text-[10px] text-white/50">Balance</div><Money n={total} className="text-sm font-semibold text-neon-400" /></div>}
      />

      <div className="px-3">
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar min-h-7">
          {recent.map((r) => (
            <span key={r.key} className="pill pop px-2.5 py-1 text-[12px] font-bold shrink-0 text-slate-900" style={{ background: r.mult >= 1 ? "#fbbf24" : "#fb7185" }}>{r.mult}x</span>
          ))}
          {!recent.length && <span className="text-[12px] text-white/40 py-1">Drop a ball to start</span>}
        </div>

        <div className="mt-2 rounded-2xl border border-white/10 overflow-hidden px-2 pt-2 pb-3" style={{ background: "radial-gradient(120% 80% at 50% 0%, #3b0a2a 0%, #0b0f24 70%)" }}>
          <svg viewBox={`0 0 ${W} ${H + 8}`} className="w-full">
            {Array.from({ length: rows }, (_, r) =>
              Array.from({ length: r + 3 }, (_, j) => (
                <circle key={`${r}-${j}`} cx={cx + (j - (r + 2) / 2) * gap} cy={top + r * dy} r={Math.max(1.8, gap * 0.11)} fill="#fff" opacity=".85" />
              )),
            )}
            {balls.map((b) => {
              const [x, y] = ballPos(b);
              return <circle key={b.id} cx={x} cy={y} r={Math.max(4, gap * 0.26)} fill="url(#plball)" style={{ filter: "drop-shadow(0 0 4px #f472b6)" }} />;
            })}
            <defs>
              <radialGradient id="plball" cx=".35" cy=".35">
                <stop offset="0" stopColor="#fff" />
                <stop offset=".55" stopColor="#f472b6" />
                <stop offset="1" stopColor="#9d174d" />
              </radialGradient>
            </defs>
          </svg>
          {/* Slots */}
          <div className="flex gap-[2px] -mt-1" style={{ paddingInline: `${(gap / W) * 100 * 0.55}%` }}>
            {mults.map((m, k) => {
              const hit = hits[k] && now - hits[k] < 350;
              return (
                <div
                  key={k}
                  className="flex-1 min-w-0 rounded-[5px] text-center font-bold text-slate-900 py-1 transition-transform"
                  style={{ background: slotColor(k, mults.length), fontSize: rows === 16 ? 8 : rows === 12 ? 10 : 12, transform: hit ? "translateY(5px)" : "none", boxShadow: "0 3px 0 rgba(0,0,0,.35)" }}
                >
                  {m >= 100 ? m : `${m}`}{rows === 16 ? "" : "x"}
                </div>
              );
            })}
          </div>
        </div>

        {/* Controls */}
        <div className="card p-3 mt-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setAmount(Math.max(10, Math.floor(amount / 2)))} className="w-10 h-9 rounded-full btn-ghost text-[12px] font-semibold">½</button>
            <button onClick={() => setAmount(Math.max(10, amount - 10))} className="w-9 h-9 rounded-full btn-ghost grid place-items-center"><Minus size={16} /></button>
            <input
              value={amount}
              inputMode="numeric"
              onChange={(e) => setAmount(Math.min(10000, Number(e.target.value.replace(/\D/g, "")) || 0))}
              onBlur={() => setAmount(Math.max(10, amount))}
              className="flex-1 min-w-0 bg-black/30 rounded-xl text-center text-lg font-semibold py-1.5 outline-none"
            />
            <button onClick={() => setAmount(Math.min(10000, amount + 10))} className="w-9 h-9 rounded-full btn-ghost grid place-items-center"><Plus size={16} /></button>
            <button onClick={() => setAmount(Math.min(10000, amount * 2))} className="w-10 h-9 rounded-full btn-ghost text-[12px] font-semibold">2×</button>
          </div>
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {QUICK.map((q) => (
              <button key={q} onClick={() => setAmount(q)} className={`rounded-lg py-1.5 text-[13px] ${amount === q ? "bg-white/20" : "bg-white/5"}`}>{q}</button>
            ))}
          </div>

          <div className="mt-3 text-[12px] text-white/55">Risk</div>
          <div className="grid grid-cols-3 gap-1.5 mt-1">
            {(["low", "medium", "high"] as Risk[]).map((r) => (
              <button key={r} disabled={flying} onClick={() => setRisk(r)} className={`rounded-lg py-1.5 text-[13px] capitalize disabled:opacity-50 ${risk === r ? "bg-pink-500/80 font-semibold" : "bg-white/5"}`}>{r}</button>
            ))}
          </div>
          <div className="mt-2.5 text-[12px] text-white/55">Rows</div>
          <div className="grid grid-cols-3 gap-1.5 mt-1">
            {ROWS.map((r) => (
              <button key={r} disabled={flying} onClick={() => setRows(r)} className={`rounded-lg py-1.5 text-[13px] disabled:opacity-50 ${rows === r ? "bg-pink-500/80 font-semibold" : "bg-white/5"}`}>{r}</button>
            ))}
          </div>

          <button onClick={drop} disabled={balls.length >= MAX_BALLS} className="w-full btn-green rounded-2xl py-3.5 mt-3 font-bold text-lg disabled:opacity-50">
            DROP BALL • {inr(amount)}
          </button>
          <div className="text-center text-[11px] text-white/40 mt-2">Best slot pays {Math.max(...mults)}x • change risk or rows once every ball has landed</div>
        </div>
        <div className="text-center text-[12px] text-white/35 mt-3">The server decides every bounce. Each board returns about 99% of coins staked over time.</div>
      </div>
    </div>
  );
}
