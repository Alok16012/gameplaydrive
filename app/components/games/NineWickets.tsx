"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, ListOrdered, RefreshCw, X } from "lucide-react";
import { apiFetch } from "../../lib/supabase";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import type { NineBet } from "../../lib/server/jili";
import type { Nav } from "../nav";

// 9Wickets — the live cricket / sports exchange from iGaming SoftAPI (migration 121): a transfer wallet. Coins move
// into the player's 9Wickets wallet at launch, the player bets inside the sportsbook, and what is left comes back at
// cash out.
//
// The play link SoftAPI returns works ONCE and must be opened in a full browser tab (the sportsbook moves to its own
// domain and keeps its login there — inside our iframe a phone browser blocks that and the screen stays black). So the
// sportsbook replaces this page; its "back to lobby" returns to khelobaazi.in, where the coins come back on their own
// (NineReturn, below, run by the app on start-up).

const FLAG = "kb-9w-open"; // set while the player is away in 9Wickets

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Something went wrong");
  return j as T;
}

const STEPS = ["Connecting to 9Wickets", "Validating your account", "Initialising your wallet", "Creating your game session", "Opening the live exchange"];

export function NineWickets({ nav }: { nav: Nav }) {
  const { total, refresh } = useStore();
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [bets, setBets] = useState<NineBet[] | null>(null);
  const [showBets, setShowBets] = useState(false);

  const launch = useCallback(async () => {
    setErr("");
    setStep(1);
    const tick = window.setInterval(() => setStep((s) => Math.min(s + 1, 3)), 700);
    try {
      const r = await api<{ url: string; coins: number }>("/api/nine/launch", { method: "POST", body: JSON.stringify({}) });
      window.clearInterval(tick);
      setStep(4);
      try { sessionStorage.setItem(FLAG, String(Date.now())); localStorage.setItem(FLAG, String(Date.now())); } catch { /* private mode */ }
      // Once, in this tab: the link can't be opened a second time.
      window.location.assign(r.url);
    } catch (e) {
      window.clearInterval(tick);
      setErr((e as Error).message);
      refresh();
    }
  }, [refresh]);

  useEffect(() => { launch(); }, [launch]);

  const loadBets = async () => {
    setShowBets((v) => !v);
    if (bets) return;
    try { setBets((await api<{ bets: NineBet[] }>("/api/nine/bets")).bets); } catch { setBets([]); }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <div className="h-11 shrink-0 flex items-center gap-2 px-2 bg-[#0b1f16] border-b border-white/10">
        <button onClick={nav.back} aria-label="Back" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95"><ChevronLeft size={18} /></button>
        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold truncate">9Wickets</div>
          <div className="text-[10px] text-emerald-400 truncate">Live cricket &amp; sports exchange</div>
        </div>
        <button onClick={loadBets} type="button" className="ml-auto text-[11px] text-white/70 flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5"><ListOrdered size={13} /> My bets</button>
      </div>

      <div className="relative flex-1 min-h-0 overflow-y-auto px-6 py-8" style={{ background: "radial-gradient(120% 60% at 50% 0%, #0a3d2a 0%, #061a12 55%, #05080a 100%)" }}>
        <div className="w-full max-w-[340px] mx-auto">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="https://igamingapis.com/wp-content/uploads/2026/06/1774284124-9wicketslogo_1__nHSY_O0YU.png" alt="9Wickets" className="h-12 mx-auto object-contain" />
          <div className="text-center text-xs text-white/55 mt-2">Your coins (🪙 {Math.floor(total).toLocaleString("en-IN")}) move into 9Wickets while you play and come back when you return here.</div>

          <div className="mt-6 space-y-2.5">
            {STEPS.map((label, i) => {
              const done = !err && step > i;
              const now = !err && step === i;
              const failed = !!err && step === i;
              return (
                <div key={label} className={`flex items-center gap-3 text-sm ${done || now ? "text-white" : "text-white/35"}`}>
                  <span className={`w-6 h-6 rounded-full grid place-items-center shrink-0 ${failed ? "bg-rose-500/20 text-rose-300" : done ? "bg-emerald-500/20 text-emerald-300" : "bg-white/5"}`}>
                    {failed ? <X size={13} /> : done ? <Check size={13} /> : now ? <span className="w-3 h-3 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" /> : <span className="w-1.5 h-1.5 rounded-full bg-white/30" />}
                  </span>
                  {label}
                </div>
              );
            })}
          </div>

          {err && (
            <div className="mt-6 card p-4 border border-rose-500/30 bg-rose-950/20 text-center">
              <div className="text-sm text-rose-300 font-medium">{err}</div>
              <div className="text-[11px] text-white/45 mt-1">No coins were taken — your balance is as before.</div>
              <div className="flex gap-2 justify-center mt-4">
                <button onClick={launch} className="btn-green rounded-xl px-4 py-2 text-sm font-semibold flex items-center gap-1.5"><RefreshCw size={14} /> Retry</button>
                <button onClick={nav.back} className="btn-ghost rounded-xl px-4 py-2 text-sm">Back</button>
              </div>
            </div>
          )}

          {showBets && (
            <div className="mt-5 space-y-2">
              {bets === null && <div className="text-center text-xs text-white/50 py-4">Loading…</div>}
              {bets && bets.length === 0 && <div className="text-center text-xs text-white/50 py-4">No bets in the last 7 days.</div>}
              {bets?.map((b, i) => (
                <div key={b.bet_id ?? i} className="card p-3 text-xs">
                  <div className="font-semibold truncate">{b.event ?? b.sport ?? "Bet"}</div>
                  <div className="text-white/60 truncate">{[b.market, b.selection, b.side].filter(Boolean).join(" • ")}{b.odds ? ` @ ${b.odds}` : ""}</div>
                  <div className="flex justify-between mt-1"><span className="text-white/50">Stake {inr(Number(b.stake ?? 0))}</span>
                    <span className={b.status !== "settled" ? "text-amber-300" : Number(b.profit_loss) >= 0 ? "text-emerald-400" : "text-rose-400"}>{b.status !== "settled" ? "Open" : `${Number(b.profit_loss) >= 0 ? "+" : "−"}${inr(Math.abs(Number(b.profit_loss ?? 0)))}`}</span></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Run once when the app starts: a player coming back from 9Wickets (or opening the app with a 9Wickets session still
 * open) gets the coins left in their 9Wickets wallet back — the provider's cash-out (a debit of what is left). Bets
 * still running inside 9Wickets stay there and come back with the next cash out.
 */
export function useNineReturn(signedIn: boolean, onDone: (coins: number) => void) {
  useEffect(() => {
    if (!signedIn) return;
    let away = false;
    try { away = !!(localStorage.getItem(FLAG) || sessionStorage.getItem(FLAG)); } catch { /* ignore */ }
    let alive = true;
    (async () => {
      try {
        const st = away ? null : await api<{ open: unknown }>("/api/nine/state").catch(() => null);
        if (!away && !st?.open) return;
        const r = await api<{ coins: number }>("/api/nine/cashout", { method: "POST" });
        try { localStorage.removeItem(FLAG); sessionStorage.removeItem(FLAG); } catch { /* ignore */ }
        if (alive) onDone(r.coins);
      } catch { /* the next start tries again */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);
}
