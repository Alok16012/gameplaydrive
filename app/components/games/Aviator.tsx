"use client";

import { engine, sfx, vibrate } from "../../lib/sound";
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

const histColor = (m: number) => (m >= 10 ? "text-fuchsia-400" : m >= 2 ? "text-violet-400" : "text-sky-400");

/** Red propeller plane (drawn for this app), nose to the right; the propeller spins while it flies. */
export function Plane({ width = 84, spinning = true }: { width?: number; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 120 64" width={width} height={(width * 64) / 120} className="drop-shadow-[0_6px_10px_rgba(225,29,72,.45)]">
      <g fill="#e50914">
        {/* tail fin + tailplane */}
        <path d="M6 14 L20 14 L30 32 L12 34 Z" />
        <path d="M4 36 L34 33 L36 39 L8 42 Z" />
        {/* fuselage */}
        <path d="M14 34 C30 30 52 26 78 25 C92 24.5 100 27 103 31 C100 38 90 42 76 43 C52 45 30 44 14 40 Z" />
        {/* cockpit canopy */}
        <path d="M62 25 C66 15 78 13 86 18 L88 25 Z" fill="#b8070f" />
        <path d="M68 23 C70 18 77 17 82 20 L83 23 Z" fill="#ffd6d9" opacity=".9" />
        {/* wing */}
        <path d="M44 38 L80 37 L70 56 L52 57 Z" fill="#c4060f" />
        {/* wheel strut */}
        <path d="M74 43 L77 52 L74 52 L71 44 Z" fill="#9f0712" />
        <circle cx="76" cy="54" r="3.4" fill="#2b0306" />
        {/* nose + spinner */}
        <path d="M100 27 L108 29 L108 35 L100 37 Z" fill="#b8070f" />
        <circle cx="110" cy="32" r="3" fill="#ffd1d4" />
      </g>
      {/* propeller */}
      <g style={{ transformOrigin: "110px 32px", animation: spinning ? "prop .12s linear infinite" : undefined }}>
        <ellipse cx="110" cy="32" rx="3.2" ry="24" fill="#e50914" opacity=".85" />
      </g>
    </svg>
  );
}

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

  // Engine hum while the plane climbs (pitch follows the multiplier), a whoosh on take-off, a crash when it goes.
  const eng = useRef<ReturnType<typeof engine> | null>(null);
  const roundSeen = useRef<{ id: number; flew: boolean; crashed: boolean } | null>(null);
  useEffect(() => {
    if (!v) return;
    const r = roundSeen.current?.id === v.id ? roundSeen.current : (roundSeen.current = { id: v.id, flew: false, crashed: false });
    if (flying && !r.flew) { r.flew = true; sfx.takeoff(); eng.current?.stop(); eng.current = engine(); }
    if (crashed && !r.crashed) {
      r.crashed = true;
      eng.current?.stop(); eng.current = null;
      if (r.flew) sfx.crash();
    }
  }, [v, flying, crashed]);
  useEffect(() => { if (flying) eng.current?.set(m); }, [flying, m]);
  useEffect(() => () => eng.current?.stop(), []);
  const secsToStart = Math.max(0, (startsAt - serverNow) / 1000);

  const act = async (fn: "av_bet" | "av_cancel" | "av_cashout", slot: number, args: Record<string, unknown> = {}) => {
    setBusy(slot);
    const { data, error } = await supabase().rpc(fn, { p_slot: slot, ...args });
    setBusy(null);
    if (error) { showToast(errText(error)); pull(); return; }
    take(data as View);
    if (fn === "av_cashout") {
      const b = (data as View).mine.find((x) => x.slot === slot);
      if (b?.cash_mult) { sfx.win(); vibrate(50); showToast(`Cashed out at ${b.cash_mult.toFixed(2)}x • +${inr(b.payout)}`); }
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
      <div className="min-h-dvh flex flex-col fadein bg-[#101010]">
        <Header title="Aviator" onBack={nav.back} />
        <div className="flex-1 grid place-items-center px-6 text-center text-sm text-white/80">{err}</div>
      </div>
    );
  }

  const others = [...(v?.bets ?? []).map((b) => ({ name: b.name, amount: b.amount, at: b.cash_mult })), ...crowd.map((c) => ({
    name: c.name,
    amount: c.amount,
    at: (flying || crashed) && m >= c.target && !(crashed && (v?.crash ?? 0) < c.target) ? c.target : null,
  }))];
  const totalWin = others.reduce((a, r) => a + (r.at ? Math.floor(r.amount * r.at) : 0), 0);

  return (
    <div className="min-h-dvh flex flex-col pb-6 fadein bg-[#101010]">
      <Header
        title="Aviator"
        sub={v ? `Round #${v.id}` : "Connecting…"}
        onBack={nav.back}
        right={<Money n={total} className="text-base font-bold text-[#28a909]" />}
      />

      <div className="px-2">
        <div className="flex gap-3 overflow-x-auto no-scrollbar px-1 py-1">
          {(v?.history ?? []).map((h, i) => (
            <span key={i} className={`text-[13px] font-semibold shrink-0 tabular-nums ${histColor(h)}`}>{Number(h).toFixed(2)}x</span>
          ))}
        </div>

        {/* Flight area */}
        <div className="relative mt-1.5 rounded-2xl overflow-hidden border border-white/10 bg-black" style={{ height: 240 }}>
          <div className={`absolute -inset-[60%] origin-bottom-left ${flying ? "av-rays" : ""}`} style={{ background: "repeating-conic-gradient(from 0deg at 0% 100%, #1c1c1c 0deg 7deg, #000 7deg 14deg)", left: 0, bottom: 0 }} />
          <div className="absolute left-3 right-3 bottom-4" style={{ height: H }}>
            <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="avfill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#e50914" stopOpacity=".55" />
                  <stop offset="1" stopColor="#e50914" stopOpacity=".12" />
                </linearGradient>
              </defs>
              {(flying || crashed) && t > 0 && (
                <>
                  <path d={`${line} L${px.toFixed(1)},${H} L0,${H} Z`} fill="url(#avfill)" />
                  <path d={line} fill="none" stroke="#e50914" strokeWidth="3.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </>
              )}
            </svg>
            {(flying || crashed) ? (
              <div
                className="absolute z-10"
                style={{
                  left: `${(px / W) * 100}%`,
                  top: `${(py / H) * 100}%`,
                  transform: crashed ? "translate(120px,-160px) rotate(-18deg)" : "translate(-20%,-78%) rotate(-10deg)",
                  opacity: crashed ? 0 : 1,
                  transition: crashed ? "transform .9s ease-in, opacity .9s ease-in" : "none",
                }}
              >
                <Plane width={84} />
              </div>
            ) : v ? (
              <div className="absolute left-0 bottom-0 z-10"><Plane width={84} spinning={false} /></div>
            ) : null}
          </div>

          <div className={`absolute inset-x-0 top-0 flex flex-col items-center text-center pointer-events-none ${flying || crashed ? "pt-8" : "bottom-0 justify-center"}`}>
            {!v ? (
              <div className="text-sm text-white/60">Connecting…</div>
            ) : crashed ? (
              <>
                <div className="text-lg font-semibold text-white tracking-wide">FLEW AWAY!</div>
                <div className="text-6xl font-extrabold text-[#e50914] tabular-nums">{Number(v.crash).toFixed(2)}x</div>
              </>
            ) : flying ? (
              <div className="text-6xl font-extrabold text-white tabular-nums drop-shadow-[0_4px_12px_rgba(0,0,0,.8)]">{m.toFixed(2)}x</div>
            ) : (
              <div className="w-52">
                <div className="text-sm text-white/80 font-semibold tracking-wide">WAITING FOR NEXT ROUND</div>
                <div className="mt-3 h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full rounded-full bg-[#e50914]" style={{ width: `${Math.min(100, (secsToStart / 7) * 100)}%` }} />
                </div>
                <div className="text-[12px] text-white/50 mt-2 tabular-nums">{secsToStart.toFixed(1)}s • place your bets</div>
              </div>
            )}
          </div>
        </div>

        {/* Two bet panels */}
        <div className="mt-2 space-y-2">
          {[0, 1].map((slot) => {
            const b = v?.mine.find((x) => x.slot === slot);
            const autoHit = !!b && b.auto !== null && b.cash_mult === null && m >= b.auto && !(crashed && (v?.crash ?? 0) < b.auto);
            const set = <T,>(arr: T[], val: T) => arr.map((x, i) => (i === slot ? val : x));
            const amt = amount[slot];
            const betting = !!v && !crashed && !flying;
            const big = "w-full h-full min-h-[86px] rounded-2xl font-semibold leading-tight border-2 active:scale-[.98] disabled:opacity-60";
            let button: React.ReactNode;
            if (b && b.cash_mult !== null) {
              button = <div className={`${big} grid place-items-center bg-[#1d3b14] border-[#28a909] text-[#5fe03a]`}><span>Cashed out<br /><b className="text-xl">{Number(b.cash_mult).toFixed(2)}x</b><br />+{inr(b.payout)}</span></div>;
            } else if (b && autoHit) {
              button = <div className={`${big} grid place-items-center bg-[#1d3b14] border-[#28a909] text-[#5fe03a]`}><span>Auto cash-out<br /><b className="text-xl">{Number(b.auto).toFixed(2)}x</b><br />+{inr(Math.floor(b.amount * (b.auto ?? 1)))}</span></div>;
            } else if (b && crashed) {
              button = <div className={`${big} grid place-items-center bg-[#2a1012] border-[#7f1d1d] text-rose-300`}><span>Lost<br /><b className="text-xl">{inr(b.amount)}</b></span></div>;
            } else if (b && flying) {
              button = (
                <button disabled={busy === slot} onClick={() => act("av_cashout", slot)} className={`${big} bg-[#d07206] border-[#ffbd71] text-white`}>
                  <span className="text-xl">Cash Out</span><br /><span className="text-2xl font-bold tabular-nums">{inr(Math.floor(b.amount * m))}</span>
                </button>
              );
            } else if (b) {
              button = (
                <button disabled={busy === slot} onClick={() => act("av_cancel", slot)} className={`${big} bg-[#cb011a] border-[#ff7d8b] text-white`}>
                  <span className="text-xl">Cancel</span><br /><span className="text-sm text-white/80">Waiting for round</span>
                </button>
              );
            } else {
              button = (
                <button
                  disabled={!betting || busy === slot}
                  onClick={() => act("av_bet", slot, { p_amount: amt, p_auto: autoOn[slot] ? Number(autoAt[slot]) : null })}
                  className={`${big} bg-[#28a909] border-[#b2f2a3] text-white`}
                >
                  <span className="text-2xl">Bet</span><br /><span className="text-xl tabular-nums">{inr(amt)}</span>
                </button>
              );
            }
            return (
              <div key={slot} className="rounded-2xl bg-[#1b1c1d] p-3">
                <div className="flex justify-center mb-2.5">
                  <div className="flex rounded-full bg-[#141516] p-0.5 text-[13px]">
                    <button onClick={() => !b && setAutoOn(set(autoOn, false))} className={`px-6 py-1 rounded-full ${!autoOn[slot] ? "bg-[#2c2d30] text-white" : "text-white/50"}`}>Bet</button>
                    <button onClick={() => !b && setAutoOn(set(autoOn, true))} className={`px-6 py-1 rounded-full ${autoOn[slot] ? "bg-[#2c2d30] text-white" : "text-white/50"}`}>Auto</button>
                  </div>
                </div>
                <div className="grid gap-3 items-stretch" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)" }}>
                  <div>
                    <div className="flex items-center rounded-full bg-[#141516] px-1 py-1">
                      <button onClick={() => setAmount(set(amount, Math.max(10, amt - 10)))} disabled={!!b} className="w-7 h-7 rounded-full border border-white/20 grid place-items-center text-white/70 disabled:opacity-40"><Minus size={14} /></button>
                      <input
                        value={amt}
                        disabled={!!b}
                        inputMode="numeric"
                        onChange={(e) => setAmount(set(amount, Math.min(10000, Number(e.target.value.replace(/\D/g, "")) || 0)))}
                        onBlur={() => setAmount(set(amount, Math.max(10, amt)))}
                        className="flex-1 min-w-0 bg-transparent text-center text-lg font-bold outline-none disabled:opacity-60"
                      />
                      <button onClick={() => setAmount(set(amount, Math.min(10000, amt + 10)))} disabled={!!b} className="w-7 h-7 rounded-full border border-white/20 grid place-items-center text-white/70 disabled:opacity-40"><Plus size={14} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                      {QUICK.map((q) => (
                        <button key={q} disabled={!!b} onClick={() => setAmount(set(amount, q))} className={`rounded-full py-1 text-[13px] text-white/70 ${amt === q ? "bg-[#2c2d30]" : "bg-[#141516]"} disabled:opacity-40`}>{q}</button>
                      ))}
                    </div>
                  </div>
                  {button}
                </div>
                {autoOn[slot] && (
                  <div className="flex items-center justify-between mt-2.5 pt-2.5 border-t border-white/5 text-[13px]">
                    <div className="flex items-center gap-2 text-white/70"><Toggle on={autoOn[slot]} onChange={(on) => !b && setAutoOn(set(autoOn, on))} />Auto cash-out</div>
                    <div className="flex items-center gap-1 rounded-full bg-[#141516] px-3 py-1">
                      <input
                        value={autoAt[slot]}
                        disabled={!!b}
                        inputMode="decimal"
                        onChange={(e) => setAutoAt(set(autoAt, e.target.value.replace(/[^0-9.]/g, "")))}
                        onBlur={() => setAutoAt(set(autoAt, Math.min(500, Math.max(1.01, Number(autoAt[slot]) || 2)).toFixed(2)))}
                        className="w-14 bg-transparent text-center font-semibold outline-none"
                      />
                      <span className="text-white/60">x</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* All bets */}
        <div className="mt-2 rounded-2xl bg-[#1b1c1d] p-3">
          <div className="flex items-center justify-between rounded-xl bg-[#141516] px-3 py-2.5">
            <div className="text-[13px] text-white/80"><b className="text-white">{others.length}</b> Bets</div>
            <div className="text-right"><div className="font-bold tabular-nums">{inr(totalWin)}</div><div className="text-[11px] text-white/50">Total win</div></div>
          </div>
          <div className="grid grid-cols-[1.3fr_1fr_.7fr_1fr] text-[12px] text-white/45 px-2 pt-3 pb-1.5">
            <span>Player</span><span>Bet</span><span className="text-center">X</span><span className="text-right">Win</span>
          </div>
          <div className="space-y-1">
            {others.map((r, i) => (
              <div key={i} className={`grid grid-cols-[1.3fr_1fr_.7fr_1fr] items-center rounded-full px-2 py-1.5 text-[13px] ${r.at ? "bg-[#123405] border border-[#427f00]" : "bg-[#101111]"}`}>
                <span className="flex items-center gap-2 truncate"><span className="w-6 h-6 rounded-full shrink-0 grid place-items-center text-[11px] bg-white/10">{r.name[0]?.toUpperCase()}</span><span className="truncate text-white/80">{r.name}</span></span>
                <span className="tabular-nums">{inr(r.amount)}</span>
                <span className={`text-center tabular-nums ${r.at ? histColor(r.at) + " font-semibold" : "text-white/30"}`}>{r.at ? `${Number(r.at).toFixed(2)}x` : ""}</span>
                <span className="text-right tabular-nums">{r.at ? inr(Math.floor(r.amount * r.at)) : ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="text-center text-[11px] text-white/30 mt-3">Every round is decided by the server before take-off; cash-outs are checked against its clock.</div>
      </div>
    </div>
  );
}
