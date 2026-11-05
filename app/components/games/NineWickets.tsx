"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ExternalLink, ListOrdered, LogOut } from "lucide-react";
import { apiFetch } from "../../lib/supabase";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import type { NineBet, NineSession } from "../../lib/server/jili";
import type { Nav } from "../nav";

// 9Wickets — a live cricket / sports exchange from iGaming SoftAPI (migration 121). It keeps its own wallet: the
// player moves coins in, bets inside the sportsbook, and takes what is left back out ("Cash out & leave"). One
// session at a time; a session left open is cashed out the next time the player comes here.

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Something went wrong");
  return j as T;
}

export function NineWickets({ nav }: { nav: Nav }) {
  const { total, refresh, showToast } = useStore();
  const [state, setState] = useState<{ ready: boolean; open: NineSession | null; cap: number } | null>(null);
  const [amount, setAmount] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"launch" | "cashout" | null>(null);
  const [err, setErr] = useState("");
  const [bets, setBets] = useState<NineBet[] | null>(null);
  const [showBets, setShowBets] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api<{ ready: boolean; open: NineSession | null; cap: number }>("/api/nine/state");
      setState(s);
      setAmount((a) => a || String(Math.max(10, Math.min(Math.floor(total), s.cap || 0))));
    } catch (e) { setErr((e as Error).message); }
  }, [total]);
  useEffect(() => { load(); }, [load]);

  const launch = async (coins: number) => {
    setBusy("launch");
    setErr("");
    try {
      const r = await api<{ url: string }>("/api/nine/launch", { method: "POST", body: JSON.stringify({ coins }) });
      setUrl(r.url);
      refresh();
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };
  const cashout = async (leave: boolean) => {
    setBusy("cashout");
    setErr("");
    try {
      const r = await api<{ coins: number }>("/api/nine/cashout", { method: "POST" });
      await refresh();
      showToast(r.coins > 0 ? `${inr(r.coins)} came back to your coins` : "Nothing left in 9Wickets to bring back");
      setUrl(null);
      if (leave) return nav.back();
      load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };
  const loadBets = async () => {
    setShowBets(true);
    if (bets) return;
    try { setBets((await api<{ bets: NineBet[] }>("/api/nine/bets")).bets); } catch { setBets([]); }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <div className="h-11 shrink-0 flex items-center gap-2 px-2 bg-[#0b1f16] border-b border-white/10">
        <button onClick={() => (url ? cashout(true) : nav.back())} disabled={busy === "cashout"} aria-label="Back" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95"><ChevronLeft size={18} /></button>
        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold">9Wickets</div>
          <div className="text-[10px] text-emerald-300">{url ? "Live exchange • your coins are in the 9Wickets wallet" : "Live cricket & sports exchange"}</div>
        </div>
        {url && (
          <div className="ml-auto flex items-center gap-2">
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-white/60 flex items-center gap-1"><ExternalLink size={13} /> Full screen</a>
            <button onClick={() => cashout(true)} disabled={busy === "cashout"} className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold bg-emerald-500 text-black flex items-center gap-1 disabled:opacity-50"><LogOut size={12} /> {busy === "cashout" ? "Cashing out…" : "Cash out & leave"}</button>
          </div>
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        {url ? (
          <iframe src={url} title="9Wickets" className="absolute inset-0 w-full h-full border-0" allow="autoplay; fullscreen" allowFullScreen />
        ) : (
          <div className="absolute inset-0 overflow-y-auto px-5 py-6" style={{ background: "radial-gradient(120% 60% at 50% 0%, #0a3d2a 0%, #061a12 55%, #05080a 100%)" }}>
            <div className="max-w-[380px] mx-auto">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="https://igamingapis.com/wp-content/uploads/2026/06/1774284124-9wicketslogo_1__nHSY_O0YU.png" alt="9Wickets" className="h-12 mx-auto object-contain" />
              <div className="text-center text-xs text-white/55 mt-2">Back & lay on live cricket, football, tennis and more. Your coins go into the 9Wickets wallet while you play and come back when you cash out.</div>

              {state === null && !err && <div className="text-center text-sm text-white/50 py-10 animate-pulse">Loading…</div>}
              {state && !state.ready && <div className="card p-4 mt-6 text-sm text-white/70 text-center">9Wickets is not available right now.</div>}

              {state?.ready && state.open && (
                <div className="card p-4 mt-6">
                  <div className="text-sm font-semibold">You have a session open</div>
                  <div className="text-xs text-white/55 mt-1">{inr(state.open.coins_in)} went into 9Wickets {new Date(state.open.launched_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}. Whatever is still in the wallet comes back when you cash out.</div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button onClick={() => cashout(false)} disabled={!!busy} className="btn-ghost rounded-xl py-2.5 text-sm">{busy === "cashout" ? "Cashing out…" : "Cash out"}</button>
                    <button onClick={() => launch(Math.max(10, Math.floor(Number(amount)) || 10))} disabled={!!busy} className="btn-green rounded-xl py-2.5 text-sm">{busy === "launch" ? "Opening…" : "Cash out & re-enter"}</button>
                  </div>
                </div>
              )}

              {state?.ready && !state.open && (
                <div className="card p-4 mt-6">
                  <div className="flex items-baseline justify-between"><span className="text-sm font-semibold">Coins to take in</span><span className="text-xs text-white/50">You have {inr(total)}</span></div>
                  <input type="number" inputMode="numeric" min={10} max={Math.min(Math.floor(total), state.cap)} value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="w-full mt-2 bg-white/5 border border-white/15 rounded-xl px-3 py-3 text-lg font-semibold outline-none focus:border-emerald-400" />
                  <div className="flex gap-1.5 mt-2">
                    {[500, 1000, 2000, 5000].filter((v) => v <= Math.min(total, state.cap)).map((v) => (
                      <button key={v} onClick={() => setAmount(String(v))} className="flex-1 rounded-lg py-1.5 text-xs bg-white/10">{v.toLocaleString("en-IN")}</button>
                    ))}
                    <button onClick={() => setAmount(String(Math.min(Math.floor(total), state.cap)))} className="flex-1 rounded-lg py-1.5 text-xs bg-white/10">Max</button>
                  </div>
                  {state.cap < total && <div className="text-[11px] text-amber-200/80 mt-2">Abhi ek baar me {inr(state.cap)} tak hi ja sakte hain.</div>}
                  <button onClick={() => launch(Math.floor(Number(amount)))} disabled={!!busy || !(Number(amount) >= 10)} className="btn-green w-full rounded-2xl py-3.5 mt-4 font-semibold disabled:opacity-50">
                    {busy === "launch" ? "Opening…" : `Enter 9Wickets with ${inr(Math.floor(Number(amount)) || 0)}`}
                  </button>
                  <div className="text-[11px] text-white/45 mt-2 text-center">Bets settle inside 9Wickets. Press &quot;Cash out &amp; leave&quot; when you are done to bring your coins back.</div>
                </div>
              )}

              {err && <div className="text-sm text-rose-300 text-center mt-4">{err}</div>}

              <button onClick={loadBets} className="btn-ghost w-full rounded-xl py-2.5 mt-5 text-sm flex items-center justify-center gap-1.5"><ListOrdered size={14} /> My bets (last 7 days)</button>
              {showBets && (
                <div className="mt-3 space-y-2">
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
        )}
      </div>
    </div>
  );
}
