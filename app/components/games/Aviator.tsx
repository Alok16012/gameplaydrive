"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { inr } from "../../lib/data";
import { pickBots } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Header, Money, Toggle } from "../ui";
import type { Nav } from "../nav";

// Aviator — one shared crash round for everyone, run by the database (supabase/migrations/010_aviator.sql).
// The server draws the crash point, keeps it secret until the plane flies away, and checks every cash-out
// against its own clock. This screen only animates m(t) = e^(0.1·t) from the server's take-off time.

const GROWTH = 0.1;
const QUICK = [10, 50, 100, 500];
const multAt = (secs: number) => Math.max(1, Math.floor(Math.exp(GROWTH * Math.max(0, secs)) * 100) / 100);

interface MyBet { slot: number; amount: number; auto: number | null; cash_mult: number | null; payout: number }
interface View {
  id: number; starts_at: string; phase: "betting" | "flying" | "crashed"; crash: number | null; server_now: string;
  balance: number; history: number[]; mine: MyBet[]; bets: { name: string; amount: number; cash_mult: number | null }[];
}

const pillColor = (m: number) => (m >= 10 ? "text-fuchsia-300 bg-fuchsia-500/15" : m >= 2 ? "text-violet-300 bg-violet-500/15" : "text-sky-300 bg-sky-500/15");

export function Aviator({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<number | null>(null);
  const [amount, setAmount] = useState([100, 50]);
  const [autoOn, setAutoOn] = useState([false, false]);
  const [autoAt, setAutoAt] = useState(["2.00", "1.50"]);
  const offset = useRef(0);

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    setV(view);
    applyBalance(view.balance);
  }, [applyBalance]);

  const pull = useCallback(async () => {
    const { data, error } = await supabase().rpc("av_state");
    if (error) setErr(errText(error));
    else { setErr(""); take(data as View); }
  }, [take]);

  // Smooth clock for the curve, plus a poll that speeds up while the plane is in the air.
  useEffect(() => {
    let raf = 0;
    const loop = () => { setNow(Date.now()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const serverNow = now + offset.current;
  const startsAt = v ? new Date(v.starts_at).getTime() : 0;
  const crashed = v?.phase === "crashed";
  const flying = !!v && !crashed && serverNow >= startsAt;
  useEffect(() => {
    pull();
    const t = setInterval(pull, flying ? 400 : 900);
    return () => clearInterval(t);
  }, [pull, flying]);

  const m = crashed ? v!.crash ?? 1 : flying ? multAt((serverNow - startsAt) / 1000) : 1;
  const secsToStart = Math.max(0, (startsAt - serverNow) / 1000);

  const act = async (fn: "av_bet" | "av_cancel" | "av_cashout", slot: number, args: Record<string, unknown> = {}) => {
    setBusy(slot);
    const { data, error } = await supabase().rpc(fn, { p_slot: slot, ...args });
    setBusy(null);
    if (error) { showToast(errText(error)); pull(); return; }
    take(data as View);
    if (fn === "av_cashout") {
      const b = (data as View).mine.find((x) => x.slot === slot);
      if (b?.cash_mult) showToast(`Cashed out at ${b.cash_mult.toFixed(2)}x • +${inr(b.payout)}`);
    }
  };

  // Other seats in the round: real players from the server, filled out with regulars so the list looks alive.
  const crowd = useMemo(() => {
    if (!v) return [];
    return pickBots(9).map((b, i) => ({
      name: b.name.slice(0, 2) + "***",
      amount: [10, 20, 50, 100, 100, 200, 500, 1000][(i * 7 + v.id) % 8],
      target: Math.round((1.1 + Math.pow(Math.random(), 2) * 6) * 100) / 100,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.id]);

  // Curve geometry (viewBox 300×170).
  const W = 300, H = 170;
  const t = flying || crashed ? Math.max(0, Math.log(m) / GROWTH) : 0;
  const tMax = Math.max(8, t * 1.15);
  const mMax = Math.max(2, m * 1.2);
  const pt = (ti: number): [number, number] => [(ti / tMax) * W, H - ((Math.exp(GROWTH * ti) - 1) / (mMax - 1)) * (H - 12)];
  const pts = Array.from({ length: 41 }, (_, i) => pt((t * i) / 40));
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [px, py] = pts[pts.length - 1];

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein">
        <Header title="Aviator" onBack={nav.back} />
        <div className="flex-1 grid place-items-center px-6 text-center text-sm text-white/80">{err}</div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col pb-6 fadein">
      <Header
        title="Aviator"
        sub={v ? `Round #${v.id} • Min 🪙 10 • Max 🪙 10,000` : "Connecting…"}
        onBack={nav.back}
        right={<div className="text-right"><div className="text-[11px] text-white/50">Balance</div><Money n={total} className="text-sm font-semibold text-neon-400" /></div>}
      />

      <div className="px-3">
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
          {(v?.history ?? []).map((h, i) => (
            <span key={i} className={`pill px-2.5 py-1 text-[12px] font-semibold shrink-0 ${pillColor(h)}`}>{Number(h).toFixed(2)}x</span>
          ))}
        </div>

        {/* Flight area */}
        <div className="relative mt-3 rounded-2xl overflow-hidden border border-white/10" style={{ height: 230, background: "radial-gradient(120% 90% at 0% 100%, #2a0b16 0%, #0b0f24 60%)" }}>
          <div className="absolute inset-0 opacity-30" style={{ background: "repeating-conic-gradient(from 0deg at 0% 100%, rgba(255,255,255,.06) 0deg 6deg, transparent 6deg 12deg)" }} />
          <div className="absolute left-3 right-3 bottom-3" style={{ height: H }}>
            <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="avfill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#e11d48" stopOpacity=".55" />
                  <stop offset="1" stopColor="#e11d48" stopOpacity=".05" />
                </linearGradient>
              </defs>
              {(flying || crashed) && t > 0 && (
                <>
                  <path d={`${line} L${px.toFixed(1)},${H} L0,${H} Z`} fill="url(#avfill)" />
                  <path d={line} fill="none" stroke="#f43f5e" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </>
              )}
            </svg>
            {(flying || crashed) && (
              <div
                className="absolute text-4xl z-10"
                style={{
                  left: `${(px / W) * 100}%`,
                  top: `${(py / H) * 100}%`,
                  transform: crashed ? "translate(60px,-90px) rotate(-20deg)" : "translate(-35%,-80%) rotate(-12deg)",
                  opacity: crashed ? 0 : 1,
                  transition: crashed ? "transform .8s ease-in, opacity .8s ease-in" : "none",
                }}
              >
                ✈️
              </div>
            )}
          </div>

          <div className={`absolute inset-x-0 top-0 flex flex-col items-center text-center pointer-events-none ${flying || crashed ? "pt-5" : "bottom-0 justify-center"}`}>
            {!v ? (
              <div className="text-sm text-white/60">Connecting…</div>
            ) : crashed ? (
              <>
                <div className="text-sm font-semibold text-rose-300 tracking-widest">FLEW AWAY!</div>
                <div className="text-5xl font-extrabold text-rose-400 tabular-nums">{Number(v.crash).toFixed(2)}x</div>
              </>
            ) : flying ? (
              <div className="text-5xl font-extrabold tabular-nums drop-shadow-[0_4px_12px_rgba(0,0,0,.6)]">{m.toFixed(2)}x</div>
            ) : (
              <div className="w-48">
                <div className="text-sm text-white/70">Next round in</div>
                <div className="text-3xl font-bold tabular-nums">{secsToStart.toFixed(1)}s</div>
                <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full bg-rose-500" style={{ width: `${Math.min(100, (secsToStart / 7) * 100)}%` }} />
                </div>
                <div className="text-[12px] text-white/50 mt-2">Place your bets</div>
              </div>
            )}
          </div>
        </div>

        {/* Two bet panels */}
        <div className="mt-3 space-y-3">
          {[0, 1].map((slot) => {
            const b = v?.mine.find((x) => x.slot === slot);
            const autoHit = !!b && b.auto !== null && b.cash_mult === null && m >= b.auto && !(crashed && (v?.crash ?? 0) < b.auto);
            const set = <T,>(arr: T[], val: T) => arr.map((x, i) => (i === slot ? val : x));
            const amt = amount[slot];
            const betting = !!v && !crashed && !flying;
            let button: React.ReactNode;
            if (b && b.cash_mult !== null) {
              button = <div className="rounded-2xl py-3 text-center bg-neon-400/15 text-neon-400 font-semibold">Cashed out {Number(b.cash_mult).toFixed(2)}x • +{inr(b.payout)}</div>;
            } else if (b && autoHit) {
              button = <div className="rounded-2xl py-3 text-center bg-neon-400/15 text-neon-400 font-semibold">Auto cash-out {Number(b.auto).toFixed(2)}x • +{inr(Math.floor(b.amount * (b.auto ?? 1)))}</div>;
            } else if (b && crashed) {
              button = <div className="rounded-2xl py-3 text-center bg-rose-500/15 text-rose-300 font-semibold">Lost {inr(b.amount)}</div>;
            } else if (b && flying) {
              button = (
                <button disabled={busy === slot} onClick={() => act("av_cashout", slot)} className="w-full rounded-2xl py-3 font-bold text-slate-900 bg-gradient-to-b from-amber-300 to-orange-500 active:scale-[.98]">
                  CASH OUT {inr(Math.floor(b.amount * m))}
                </button>
              );
            } else if (b) {
              button = <button disabled={busy === slot} onClick={() => act("av_cancel", slot)} className="w-full rounded-2xl py-3 font-bold bg-rose-600 active:scale-[.98]">CANCEL {inr(b.amount)}</button>;
            } else {
              button = (
                <button
                  disabled={!betting || busy === slot}
                  onClick={() => act("av_bet", slot, { p_amount: amt, p_auto: autoOn[slot] ? Number(autoAt[slot]) : null })}
                  className="w-full btn-green rounded-2xl py-3 font-bold disabled:opacity-50"
                >
                  {betting ? `BET ${inr(amt)}` : "Wait for next round"}
                </button>
              );
            }
            return (
              <div key={slot} className="card p-3">
                <div className="flex items-center gap-2">
                  <button onClick={() => setAmount(set(amount, Math.max(10, amt - 10)))} disabled={!!b} className="w-9 h-9 rounded-full btn-ghost grid place-items-center disabled:opacity-40"><Minus size={16} /></button>
                  <input
                    value={amt}
                    disabled={!!b}
                    inputMode="numeric"
                    onChange={(e) => setAmount(set(amount, Math.min(10000, Number(e.target.value.replace(/\D/g, "")) || 0)))}
                    onBlur={() => setAmount(set(amount, Math.max(10, amt)))}
                    className="flex-1 min-w-0 bg-black/30 rounded-xl text-center text-lg font-semibold py-1.5 outline-none disabled:opacity-60"
                  />
                  <button onClick={() => setAmount(set(amount, Math.min(10000, amt + 10)))} disabled={!!b} className="w-9 h-9 rounded-full btn-ghost grid place-items-center disabled:opacity-40"><Plus size={16} /></button>
                </div>
                <div className="grid grid-cols-4 gap-1.5 mt-2">
                  {QUICK.map((q) => (
                    <button key={q} disabled={!!b} onClick={() => setAmount(set(amount, q))} className={`rounded-lg py-1.5 text-[13px] ${amt === q ? "bg-white/20" : "bg-white/5"} disabled:opacity-40`}>{q}</button>
                  ))}
                </div>
                <div className="flex items-center justify-between mt-2.5 text-[13px]">
                  <div className="flex items-center gap-2 text-white/70"><Toggle on={autoOn[slot]} onChange={(on) => !b && setAutoOn(set(autoOn, on))} />Auto cash-out</div>
                  <div className={`flex items-center gap-1 ${autoOn[slot] ? "" : "opacity-40"}`}>
                    <input
                      value={autoAt[slot]}
                      disabled={!autoOn[slot] || !!b}
                      inputMode="decimal"
                      onChange={(e) => setAutoAt(set(autoAt, e.target.value.replace(/[^0-9.]/g, "")))}
                      onBlur={() => setAutoAt(set(autoAt, Math.min(500, Math.max(1.01, Number(autoAt[slot]) || 2)).toFixed(2)))}
                      className="w-16 bg-black/30 rounded-lg text-center py-1 outline-none"
                    />
                    x
                  </div>
                </div>
                <div className="mt-2.5">{button}</div>
              </div>
            );
          })}
        </div>

        {/* Live bets */}
        <div className="card mt-3 p-3">
          <div className="flex justify-between text-[12px] text-white/50 pb-2 border-b border-white/5">
            <span>Player</span><span>Bet</span><span>Cash out</span>
          </div>
          <div className="divide-y divide-white/5">
            {[...(v?.bets ?? []).map((b) => ({ name: b.name, amount: b.amount, at: b.cash_mult })), ...crowd.map((c) => ({
              name: c.name,
              amount: c.amount,
              at: (flying || crashed) && m >= c.target && !(crashed && (v?.crash ?? 0) < c.target) ? c.target : null,
            }))].map((r, i) => (
              <div key={i} className={`flex justify-between py-1.5 text-[13px] ${r.at ? "text-neon-400" : crashed ? "text-white/35" : ""}`}>
                <span className="w-24 truncate">{r.name}</span>
                <span className="tabular-nums">{inr(r.amount)}</span>
                <span className="w-24 text-right tabular-nums">{r.at ? `${Number(r.at).toFixed(2)}x • ${inr(Math.floor(r.amount * r.at))}` : "—"}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="text-center text-[12px] text-white/35 mt-3">The server decides every round before take-off and checks each cash-out against its own clock.</div>
      </div>
    </div>
  );
}
