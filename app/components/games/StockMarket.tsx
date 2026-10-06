"use client";

import { sfx, vibrate } from "../../lib/sound";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { inr } from "../../lib/data";
import { pickBots } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Header, Money } from "../ui";
import type { Nav } from "../nav";

// Stock Market (Up / Down) — one shared round for everyone, run by the database (supabase/migrations/023_stock_market.sql).
// The server draws the whole price path when the round opens and only ever sends the ticks up to its own clock;
// cash-outs are priced at the server's current tick. This screen draws the line a beat behind the server so it
// moves smoothly between polls.
//   UP is worth stake × P, DOWN is worth stake × (2 − P), where P starts at 1.00 (0%). The fee comes off every payout.

const TICKS = 80;
const BET_SECS = 7; // betting window (supabase/migrations/027_stock_market_pace.sql)
const LAG_TICKS = 1.5; // draw this far behind the server so there is always a known next tick to glide to
const CHIPS = [10, 50, 100, 500, 1000, 5000];

type Side = "up" | "down";
interface MyBet { side: Side; amount: number; cash_tick: number | null; payout: number }
interface View {
  id: number; starts_at: string; ends_at: string; phase: "betting" | "live" | "closed"; path: number[]; server_now: string;
  balance: number; fee: number; history: number[]; mine: MyBet[];
  crowd: { up: number; down: number; up_n: number; down_n: number };
  cashed?: { tick: number; payout: number };
}

const value = (side: Side, amount: number, p: number) => (side === "up" ? amount * p : amount * (2 - p));
const pctOf = (p: number) => Math.round((p - 1) * 100);
const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");

/** Small seeded generator so every phone shows the same crowd for a round. */
function seeded(seed: number) {
  let s = seed * 9301 + 49297;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

export function StockMarket({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState(100);
  const [result, setResult] = useState<{ round: number; text: string; won: boolean } | null>(null);
  const [help, setHelp] = useState(false);
  const offset = useRef(0);
  const lastPath = useRef<{ id: number; path: number[] } | null>(null);
  const lastStake = useRef<{ up: number; down: number }>({ up: 0, down: 0 });

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    setV((old) => {
      // Keep the finished round's line to show (faded) while the next round takes bets.
      if (old && old.id !== view.id && old.path.length) lastPath.current = { id: old.id, path: old.path };
      // A poll can come back with fewer ticks than we already hold for the same round: keep the longer one.
      if (old && old.id === view.id && old.path.length > view.path.length) return { ...view, path: old.path };
      return view;
    });
    applyBalance(view.balance);
  }, [applyBalance]);

  const pull = useCallback(async () => {
    const { data, error } = await supabase().rpc("sm_state");
    if (error) setErr(errText(error));
    else { setErr(""); take(data as View); }
  }, [take]);

  // The table fills exactly one screen and the page itself never scrolls, so tapping UP / DOWN quickly (or a tap
  // that turns into a tiny swipe) can't drag the page or make the browser bar slide in and out.
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const old = [html.style.overflow, body.style.overflow, body.style.overscrollBehavior];
    html.style.overflow = "hidden"; body.style.overflow = "hidden"; body.style.overscrollBehavior = "none";
    window.scrollTo(0, 0);
    return () => { [html.style.overflow, body.style.overflow, body.style.overscrollBehavior] = old; };
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => { setNow(Date.now()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const serverNow = now + offset.current;
  const startsAt = v ? new Date(v.starts_at).getTime() : 0;
  const endsAt = v ? new Date(v.ends_at).getTime() : 0;
  // One tick's length, taken from the round itself (the server sets the pace).
  const TICK_MS = v ? Math.max(50, (endsAt - startsAt) / TICKS) : 180;
  const phase: View["phase"] | null = !v ? null : serverNow < startsAt ? "betting" : serverNow < endsAt ? "live" : "closed";
  const live = phase === "live";

  useEffect(() => {
    pull();
    const t = setInterval(pull, live ? 300 : 800);
    return () => clearInterval(t);
  }, [pull, live]);

  // Where the line is drawn up to (in ticks, fractional), never past what the server has sent.
  const known = v?.path.length ?? 0;
  const drawTick = !v || phase === "betting" ? 0
    : phase === "closed" ? known - 1
    : Math.max(0, Math.min(known - 1, (serverNow - startsAt) / TICK_MS - LAG_TICKS));
  const priceAt = (t: number) => {
    const path = v?.path ?? [];
    if (!path.length) return 1;
    const i = Math.floor(t), f = t - i;
    const a = path[Math.min(i, path.length - 1)], b = path[Math.min(i + 1, path.length - 1)];
    return a + (b - a) * f;
  };
  const price = priceAt(drawTick);
  const pct = pctOf(price);

  const fee = v?.fee ?? 0.01;
  const mine = v?.mine ?? [];
  const stake = { up: mine.find((b) => b.side === "up")?.amount ?? 0, down: mine.find((b) => b.side === "down")?.amount ?? 0 };
  const open = mine.filter((b) => b.cash_tick === null);
  const cashed = mine.length > 0 && open.length === 0;
  const totalBet = stake.up + stake.down;
  const portfolio = cashed
    ? mine.reduce((a, b) => a + b.payout, 0)
    : phase === "betting" ? totalBet * (1 - fee)
    : open.reduce((a, b) => a + value(b.side, b.amount, price), 0) * (1 - fee);
  if (totalBet) lastStake.current = stake;

  // Sounds: a bell when the market opens and when it closes; ticks in the last seconds of betting.
  const seen = useRef<{ id: number; opened: boolean; closed: boolean; lastSec: number } | null>(null);
  useEffect(() => {
    if (!v || !phase) return;
    const r = seen.current?.id === v.id ? seen.current : (seen.current = { id: v.id, opened: phase !== "betting", closed: phase === "closed", lastSec: 99 });
    if (phase === "live" && !r.opened) { r.opened = true; sfx.bell(); }
    if (phase === "closed" && !r.closed) { r.closed = true; sfx.bell(); }
    if (phase === "betting") {
      const sec = Math.ceil((startsAt - serverNow) / 1000);
      if (sec !== r.lastSec) { r.lastSec = sec; if (sec <= 3 && sec > 0) sfx.tick(); }
    }
  }, [v, phase, startsAt, serverNow]);

  // Positions held to the close are paid by the server; tell the player once the round shows as settled.
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!v || told.current === v.id) return;
    const held = v.mine.filter((b) => b.cash_tick === TICKS);
    if (!held.length || v.mine.some((b) => b.cash_tick === null)) return;
    told.current = v.id;
    const paid = v.mine.reduce((a, b) => a + b.payout, 0);
    const staked = v.mine.reduce((a, b) => a + b.amount, 0);
    const won = paid > staked;
    setResult({ round: v.id, won, text: `Market closed ${pctOf(v.path[v.path.length - 1] ?? 1) >= 0 ? "▲" : "▼"} ${Math.abs(pctOf(v.path[v.path.length - 1] ?? 1))}% • ${paid > 0 ? `you got ${inr(paid)}` : "you lost your stake"}` });
    if (won) { sfx.win(); vibrate(50); } else sfx.lose();
  }, [v]);
  useEffect(() => { if (result && v && v.id !== result.round && phase === "live") setResult(null); }, [result, v, phase]);

  const call = async (fn: "sm_bet" | "sm_clear" | "sm_cashout", args: Record<string, unknown> = {}) => {
    setBusy(true);
    const { data, error } = await supabase().rpc(fn, args);
    setBusy(false);
    if (error) { showToast(errText(error)); pull(); return null; }
    take(data as View);
    return data as View;
  };

  const bet = async (side: Side) => {
    if (phase !== "betting") return showToast("Bets are closed — wait for the next round");
    if (total < chip) return showToast("Not enough coins");
    sfx.chip();
    await call("sm_bet", { p_side: side, p_amount: chip });
  };
  const double = async () => {
    const s = totalBet ? stake : lastStake.current;
    if (!s.up && !s.down) return;
    if (total < s.up + s.down) return showToast("Not enough coins");
    sfx.chip();
    if (s.up) await call("sm_bet", { p_side: "up", p_amount: s.up });
    if (s.down) await call("sm_bet", { p_side: "down", p_amount: s.down });
  };
  const cashOut = async () => {
    const r = await call("sm_cashout");
    if (r?.cashed) {
      const p = r.path[r.cashed.tick] ?? 1;
      sfx.win(); vibrate(50);
      showToast(`Cashed out at ${pctOf(p) >= 0 ? "▲" : "▼"} ${Math.abs(pctOf(p))}% • ${inr(r.cashed.payout)}`);
    }
  };

  // The crowd: real players' totals from the server plus regulars, so the split bar and the cash-out list look alive.
  const crowd = useMemo(() => {
    if (!v) return null;
    const rnd = seeded(v.id);
    const bots = pickBots(14);
    const upN = 18 + Math.floor(rnd() * 40), downN = 18 + Math.floor(rnd() * 40);
    const upAmt = Math.round(4000 + rnd() * 22000), downAmt = Math.round(4000 + rnd() * 22000);
    const cashers = bots.map((b, i) => ({
      name: b.name,
      side: (rnd() < upAmt / (upAmt + downAmt) ? "up" : "down") as Side,
      amount: [20, 50, 100, 100, 200, 500, 1000, 2000][Math.floor(rnd() * 8)],
      want: 0.06 + rnd() * 0.5, // cash out once the position is up this much
      i,
    }));
    return { upN, downN, upAmt, downAmt, cashers };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.id]);

  const fill = phase === "betting" ? Math.min(1, 1 - (startsAt - serverNow) / (BET_SECS * 1000)) : 1;
  const upAmt = (crowd ? crowd.upAmt * fill : 0) + (v?.crowd.up ?? 0) + stake.up;
  const downAmt = (crowd ? crowd.downAmt * fill : 0) + (v?.crowd.down ?? 0) + stake.down;
  const upN = Math.round((crowd?.upN ?? 0) * fill) + (v?.crowd.up_n ?? 0) + (stake.up ? 1 : 0);
  const downN = Math.round((crowd?.downN ?? 0) * fill) + (v?.crowd.down_n ?? 0) + (stake.down ? 1 : 0);
  const upShare = upAmt + downAmt > 0 ? Math.round((upAmt / (upAmt + downAmt)) * 100) : 50;

  // Regulars who have cashed out so far this round (first price where their position was up enough).
  const cashedList = useMemo(() => {
    if (!crowd || !v || phase === "betting") return [];
    const upto = Math.floor(drawTick);
    const out: { name: string; pct: number; win: number }[] = [];
    for (const c of crowd.cashers) {
      for (let t = 1; t <= upto; t++) {
        const p = v.path[t];
        const gain = c.side === "up" ? p - 1 : 1 - p;
        if (gain >= c.want) { out.push({ name: c.name, pct: Math.round(gain * 100), win: Math.floor(value(c.side, c.amount, p) * (1 - fee)) }); break; }
      }
    }
    return out.slice(-3).reverse();
  }, [crowd, v, phase, drawTick, fee]);

  // Chart geometry (viewBox W×H). The y-range always shows ±25% and grows to fit the line.
  const W = 320, H = 200;
  const shown = phase === "betting" ? lastPath.current?.path ?? [] : (v?.path ?? []).slice(0, Math.floor(drawTick) + 1).concat(drawTick % 1 ? [price] : []);
  const head = phase === "betting" ? shown.length - 1 : drawTick;
  const lo = Math.min(0.75, ...shown) - 0.04, hi = Math.max(1.25, ...shown) + 0.04;
  const X = (t: number) => (t / TICKS) * (W - 46) + 4;
  const Y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const xs = shown.map((_, i) => (i === shown.length - 1 && phase !== "betting" ? X(head) : X(i)));
  const line = shown.map((p, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)},${Y(p).toFixed(1)}`).join(" ");
  const lastP = shown[shown.length - 1] ?? 1;
  const upNow = lastP >= 1;
  const col = upNow ? "#2ee6a6" : "#ff4f8b";
  const hx = xs[xs.length - 1] ?? X(0), hy = Y(lastP);
  const grid = [-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map((g) => 1 + g).filter((p) => p > lo && p < hi);

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein bg-[#070b1f]">
        <Header title="Stock Market" onBack={nav.back} />
        <div className="flex-1 grid place-items-center px-6 text-center text-sm text-white/80">{err}</div>
      </div>
    );
  }

  const secsToStart = Math.max(0, Math.ceil((startsAt - serverNow) / 1000));
  const secsToEnd = Math.max(0, Math.ceil((endsAt - serverNow) / 1000));
  const status = !v ? "CONNECTING…" : phase === "betting" ? `PLACE YOUR BETS ${secsToStart}` : phase === "live" ? `MARKET OPEN • ${secsToEnd}s` : "NEXT GAME SOON";
  const canBet = phase === "betting" && !busy;

  return (
    <div className="h-dvh flex flex-col overflow-hidden overscroll-none select-none fadein bg-[#070b1f]" style={{ touchAction: "manipulation" }}>
      <Header
        title="Stock Market"
        sub={v ? `Round #${v.id} • Up or Down` : "Connecting…"}
        onBack={nav.back}
        right={<Money n={total} className="text-base font-bold text-[#2ee6a6]" />}
      />

      <div className="flex-1 min-h-0 flex flex-col px-2 pb-[max(8px,env(safe-area-inset-bottom))]">
        {/* Last results (fixed height, so the screen doesn't shift when they arrive) */}
        <div className="shrink-0 h-[38px] flex items-center gap-1 overflow-x-auto no-scrollbar" style={{ touchAction: "pan-x" }}>
          {(v?.history ?? []).map((h, i) => (
            <span key={i} className={`shrink-0 rounded-md px-1.5 py-1 text-[11px] font-bold tabular-nums flex flex-col items-center leading-none min-w-[38px] ${h >= 0 ? "bg-[#0f3b2e] text-[#2ee6a6]" : "bg-[#3b0f22] text-[#ff4f8b]"} ${i === 0 ? "ring-1 ring-white/40" : ""}`}>
              <span className="text-[9px]">{h >= 0 ? "▲" : "▼"}</span>{Math.abs(h)}%
            </span>
          ))}
        </div>

        {/* Market */}
        <div className="relative flex-1 min-h-[170px] max-h-[300px] mt-1 rounded-2xl overflow-hidden border border-white/10" style={{ background: "radial-gradient(120% 90% at 50% 10%, #13235a 0%, #0a1233 55%, #060a1c 100%)" }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-x-0 top-6 bottom-7 w-full h-[calc(100%-52px)]" preserveAspectRatio="none">
            <defs>
              <linearGradient id="smfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={col} stopOpacity=".35" />
                <stop offset="1" stopColor={col} stopOpacity=".02" />
              </linearGradient>
            </defs>
            {grid.map((g) => (
              <g key={g}>
                <line x1="0" x2={W} y1={Y(g)} y2={Y(g)} stroke={g === 1 ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.07)"} strokeDasharray={g === 1 ? "4 4" : undefined} vectorEffect="non-scaling-stroke" />
                <text x={W - 2} y={Y(g) - 2} textAnchor="end" fontSize="8" fill="rgba(255,255,255,.35)">{pctOf(g) > 0 ? "+" : ""}{pctOf(g)}%</text>
              </g>
            ))}
            {shown.length > 1 && (
              <g opacity={phase === "betting" ? 0.3 : 1}>
                <path d={`${line} L${hx.toFixed(1)},${Y(1).toFixed(1)} L${xs[0].toFixed(1)},${Y(1).toFixed(1)} Z`} fill="url(#smfill)" />
                <path d={line} fill="none" stroke={col} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </g>
            )}
          </svg>

          {/* Head of the line with the move so far */}
          {shown.length > 0 && phase !== "betting" && (
            <div className="absolute z-20 pointer-events-none" style={{ left: `${(hx / W) * 100}%`, top: `calc(24px + (100% - 52px) * ${(hy / H).toFixed(4)})`, transform: "translate(-50%,-50%)" }}>
              <div className="w-3 h-3 rounded-full border-2 border-white" style={{ background: col, boxShadow: `0 0 12px ${col}` }} />
              <div className="absolute left-1/2 -translate-x-1/2 -top-7 rounded-md px-1.5 py-0.5 text-[12px] font-extrabold text-white whitespace-nowrap tabular-nums" style={{ background: col }}>
                {pct >= 0 ? "▲" : "▼"} {Math.abs(pct)}%
              </div>
            </div>
          )}

          {/* Cashed out list */}
          {cashedList.length > 0 && (
            <div className="absolute left-2 bottom-9 z-10 w-[56%] rounded-lg bg-black/55 backdrop-blur-sm p-1.5 text-[10px] pointer-events-none">
              <div className="text-center text-[#ffd166] font-bold tracking-wide mb-0.5">CASHED OUT</div>
              {cashedList.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 px-1 py-[1px] tabular-nums">
                  <span className="truncate text-white/80">{c.name}</span>
                  <span className="text-[#ffd166]">+{c.pct}%</span>
                  <span className="text-white/90">🪙{fmt(c.win)}</span>
                </div>
              ))}
            </div>
          )}

          {result && phase !== "closed" && (
            <div className={`absolute inset-x-2 top-2 z-30 rounded-lg px-2 py-1.5 text-center text-[12px] font-semibold pointer-events-none ${result.won ? "bg-[#0f3b2e]/95 text-[#2ee6a6]" : "bg-[#3b0f22]/95 text-[#ff8fb0]"}`}>{result.text}</div>
          )}

          {phase === "closed" && v && (
            <div className="absolute inset-x-0 top-1/3 text-center pointer-events-none">
              <div className="text-sm font-semibold text-white/80 tracking-wide">MARKET CLOSED</div>
              <div className={`text-5xl font-extrabold tabular-nums ${pct >= 0 ? "text-[#2ee6a6]" : "text-[#ff4f8b]"}`}>{pct >= 0 ? "▲" : "▼"} {Math.abs(pct)}%</div>
            </div>
          )}

          {/* Status bar */}
          <div className="absolute inset-x-0 bottom-0 h-7 bg-black/50 overflow-hidden">
            {phase === "betting" && (
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.max(0, Math.min(100, ((startsAt - serverNow) / (BET_SECS * 1000)) * 100))}%`, background: secsToStart <= 3 ? "#d6b11a" : "#22c55e" }} />
            )}
            <div className="relative h-full grid place-items-center text-[13px] font-bold tracking-wide text-white">{status}</div>
          </div>
        </div>

        {/* Up / down split */}
        <div className="shrink-0 mt-1.5 flex items-stretch rounded-xl overflow-hidden text-[12px] tabular-nums">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#0f3b2e]" style={{ width: `${upShare}%`, minWidth: "34%" }}>
            <b className="text-lg text-[#2ee6a6]">{upShare}%</b>
            <span className="leading-tight text-white/70">🪙 {fmt(upAmt)}<br />👤 {upN}</span>
          </div>
          <div className="flex-1 flex items-center justify-end gap-2 px-2.5 py-1.5 bg-[#3b0f22] text-right">
            <span className="leading-tight text-white/70">🪙 {fmt(downAmt)}<br />👤 {downN}</span>
            <b className="text-lg text-[#ff4f8b]">{100 - upShare}%</b>
          </div>
        </div>

        {/* Portfolio + cash out */}
        <div className="shrink-0 mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-[#121735] border border-white/10 px-3 py-2">
            <div className="flex justify-between text-[11px] text-white/50"><span>PORTFOLIO</span><span className="italic">{Math.round(fee * 1000) / 10}% FEE</span></div>
            <div className={`text-2xl font-extrabold tabular-nums ${cashed ? "text-[#ffd166]" : !totalBet || phase === "betting" ? "text-white" : portfolio >= totalBet ? "text-[#2ee6a6]" : "text-[#ff4f8b]"}`}>
              🪙 {fmt(Math.floor(portfolio))}
            </div>
          </div>
          <button
            data-sfx="off"
            disabled={!live || !open.length || busy}
            onClick={cashOut}
            className="rounded-xl font-extrabold text-lg tracking-wide border-2 transition active:scale-[.98] disabled:bg-[#1f2440] disabled:border-white/10 disabled:text-white/30 bg-[#e8a10c] border-[#ffd166] text-[#1b1200]"
          >
            {cashed ? "CASHED OUT" : "CASH OUT"}
          </button>
        </div>

        {/* Up / down buttons */}
        <div className="shrink-0 mt-2 grid grid-cols-2 gap-2">
          {(["up", "down"] as Side[]).map((side) => {
            const up = side === "up";
            const mineOn = up ? stake.up : stake.down;
            return (
              <button
                key={side}
                data-sfx="off"
                disabled={!canBet}
                onClick={() => bet(side)}
                className={`relative h-[84px] rounded-2xl border-2 font-extrabold text-2xl tracking-wider text-white active:scale-[.98] transition disabled:opacity-60 ${up ? "bg-gradient-to-b from-[#2fae78] to-[#16724c] border-[#5ff0b4]" : "bg-gradient-to-b from-[#c4415f] to-[#86203a] border-[#ff8fb0]"}`}
              >
                <div>{up ? "UP" : "DOWN"}</div>
                <div className="text-2xl leading-none">{up ? "▲" : "▼"}</div>
                {mineOn > 0 && (
                  <span className={`absolute ${up ? "left-2" : "right-2"} bottom-2 rounded-full px-2 py-0.5 text-[12px] font-bold bg-black/40 tabular-nums`}>🪙 {fmt(mineOn)}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Chips */}
        <div className="shrink-0 mt-2 flex items-center gap-1.5">
          <button
            disabled={!canBet || !totalBet}
            onClick={() => call("sm_clear")}
            className="shrink-0 w-10 h-10 rounded-full bg-[#121735] border border-white/10 grid place-items-center text-white/80 disabled:opacity-35"
            aria-label="Clear bets"
          >
            <RotateCcw size={18} />
          </button>
          <div className="flex-1 min-w-0 flex justify-between gap-0.5">
            {CHIPS.map((c) => (
              <button
                key={c}
                onClick={() => setChip(c)}
                className={`w-10 h-10 rounded-full text-[11px] font-extrabold border-[3px] border-dashed transition ${chip === c ? "scale-105 border-white text-[#1b1200] bg-[#ffd166]" : "border-white/30 text-white/80 bg-[#1b2148]"}`}
              >
                {c >= 1000 ? `${c / 1000}K` : c}
              </button>
            ))}
          </div>
          <button
            disabled={!canBet || (!totalBet && !lastStake.current.up && !lastStake.current.down)}
            onClick={double}
            className="shrink-0 w-10 h-10 rounded-full bg-[#121735] border border-white/10 grid place-items-center text-[13px] font-extrabold text-white/80 disabled:opacity-35"
            aria-label="Double"
          >
            ×2
          </button>
        </div>

        <div className="shrink-0 mt-2 flex items-center justify-between text-[12px] text-white/60 px-1 tabular-nums">
          <span>Total Bet <b className="text-white">🪙 {fmt(totalBet)}</b></span>
          {canBet && !totalBet && (lastStake.current.up > 0 || lastStake.current.down > 0) && (
            <button onClick={double} className="rounded-full bg-[#ffd166] text-[#1b1200] font-bold px-3 py-1 text-[12px]">
              Rebet 🪙 {fmt(lastStake.current.up + lastStake.current.down)}
            </button>
          )}
          <button onClick={() => setHelp(true)} className="rounded-full border border-white/15 px-2.5 py-0.5 text-white/70">How to play</button>
        </div>
      </div>

      {help && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/60" onClick={() => setHelp(false)}>
          <div className="w-full max-w-[430px] mx-auto rounded-t-2xl bg-[#0d1230] border-t border-white/10 p-4 pb-[max(16px,env(safe-area-inset-bottom))] text-[13px] text-white/70 leading-relaxed">
            <div className="text-base font-semibold text-white mb-2">How to play</div>
            Put chips on <b className="text-[#2ee6a6]">UP</b> or <b className="text-[#ff4f8b]">DOWN</b> while bets are open (🪙 10 – 1,00,000 per side). When the market opens your portfolio moves with the line —
            UP gains as it rises, DOWN gains as it falls (a +23% move turns 🪙100 on UP into 🪙123, and 🪙100 on DOWN into 🪙77).
            Hit <b className="text-[#ffd166]">CASH OUT</b> any time to lock in the value, or hold to the close. A {Math.round(fee * 1000) / 10}% fee comes off every payout.
            <div className="text-[11px] text-white/35 mt-2">Every market is drawn by the server before it opens; cash-outs are priced at the server&apos;s clock.</div>
            <button onClick={() => setHelp(false)} className="mt-3 w-full rounded-xl bg-white/10 py-2.5 font-semibold text-white">Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}
