"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ListOrdered, Maximize, Minimize, RefreshCw, X } from "lucide-react";
import { apiFetch } from "../../lib/supabase";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import type { NineBet } from "../../lib/server/jili";
import type { Nav } from "../nav";

// 9Wickets — a live cricket / sports exchange from iGaming SoftAPI (migration 121).
// Seamless flow: opens directly with the player's wallet coins (auto-cashout on exit / re-entry).

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Something went wrong");
  return j as T;
}

export function NineWickets({ nav }: { nav: Nav }) {
  const { refresh, showToast } = useStore();
  const [url, setUrl] = useState<string | null>(null);
  const [capInfo, setCapInfo] = useState<{ coinsIn: number; walletCoins: number } | null>(null);
  const [busy, setBusy] = useState<"launch" | "cashout" | null>("launch");
  const [err, setErr] = useState("");
  const [bets, setBets] = useState<NineBet[] | null>(null);
  const [showBets, setShowBets] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fullscreen event listener (native device fullscreen)
  useEffect(() => {
    const onFsChange = () => {
      const doc = document as unknown as { fullscreenElement?: Element; webkitFullscreenElement?: Element };
      setFullscreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const doc = document as unknown as { fullscreenElement?: Element; webkitFullscreenElement?: Element; exitFullscreen?: () => Promise<void>; webkitExitFullscreen?: () => void };
    const el = containerRef.current as unknown as { requestFullscreen?: () => Promise<void>; webkitRequestFullscreen?: () => void };
    if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
      if (el?.requestFullscreen) el.requestFullscreen().catch(() => setFullscreen((v) => !v));
      else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else setFullscreen((v) => !v);
    } else {
      if (doc.exitFullscreen) doc.exitFullscreen().catch(() => {});
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      setFullscreen(false);
    }
  };

  // Launch directly with wallet coins on mount
  const launch = useCallback(async () => {
    setBusy("launch");
    setErr("");
    try {
      const r = await api<{ url: string; coins: number; walletCoins: number }>("/api/nine/launch", { method: "POST", body: JSON.stringify({}) });
      setUrl(r.url);
      if (r.walletCoins != null && r.coins != null && r.coins < r.walletCoins) {
        setCapInfo({ coinsIn: r.coins, walletCoins: r.walletCoins });
      } else {
        setCapInfo(null);
      }
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  }, [refresh]);

  useEffect(() => {
    launch();
  }, [launch]);

  // Cash out and return to home
  const cashoutAndBack = async () => {
    setBusy("cashout");
    try {
      const r = await api<{ coins: number }>("/api/nine/cashout", { method: "POST" });
      await refresh();
      if (r.coins > 0) {
        showToast(`${inr(r.coins)} came back to your coins`);
      }
    } catch {
      // ignore error on exit, wallet is safe
    }
    setBusy(null);
    nav.back();
  };

  const loadBets = async () => {
    setShowBets(true);
    if (bets) return;
    try {
      setBets((await api<{ bets: NineBet[] }>("/api/nine/bets")).bets);
    } catch {
      setBets([]);
    }
  };

  return (
    <div ref={containerRef} className="fixed inset-0 z-40 flex flex-col bg-black">
      {/* Top Header */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-2 bg-[#0b1f16] border-b border-white/10">
        <button
          onClick={cashoutAndBack}
          disabled={busy === "cashout"}
          aria-label="Back"
          className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95 disabled:opacity-50"
        >
          {busy === "cashout" ? <RefreshCw size={14} className="animate-spin text-white" /> : <ChevronLeft size={18} />}
        </button>

        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold truncate">9Wickets</div>
          <div className="text-[10px] text-emerald-400 truncate">
            {busy === "launch" ? "Connecting…" : busy === "cashout" ? "Cashing out to wallet…" : "Live cricket & sports exchange"}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {url && (
            <button
              onClick={toggleFullscreen}
              type="button"
              className="text-[11px] text-white/70 hover:text-white flex items-center gap-1 px-1.5 py-1 rounded-lg bg-white/5 active:scale-95 transition"
            >
              {fullscreen ? <Minimize size={13} /> : <Maximize size={13} />}
              <span>{fullscreen ? "Exit full screen" : "Full screen"}</span>
            </button>
          )}

          <button
            onClick={loadBets}
            type="button"
            className="text-[11px] text-white/70 hover:text-white flex items-center gap-1 px-1.5 py-1 rounded-lg bg-white/5 active:scale-95 transition"
          >
            <ListOrdered size={13} />
            <span className="hidden sm:inline">My bets</span>
          </button>
        </div>
      </div>

      {/* Launch cap banner if applicable */}
      {capInfo && url && (
        <div className="shrink-0 bg-emerald-500/15 border-b border-emerald-400/30 text-emerald-100 text-[11px] px-3 py-1.5">
          9Wickets me abhi ek baar me {inr(capInfo.coinsIn)} tak — baaki {inr(capInfo.walletCoins - capInfo.coinsIn)} aapke wallet me safe hain.
        </div>
      )}

      {/* Main Container */}
      <div className="relative flex-1 min-h-0">
        {url ? (
          <iframe
            src={url}
            title="9Wickets"
            className="absolute inset-0 w-full h-full border-0"
            allow="autoplay; fullscreen"
            allowFullScreen
          />
        ) : (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center px-6"
            style={{ background: "radial-gradient(120% 60% at 50% 0%, #0a3d2a 0%, #061a12 55%, #05080a 100%)" }}
          >
            <div className="w-full max-w-[340px] text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://igamingapis.com/wp-content/uploads/2026/06/1774284124-9wicketslogo_1__nHSY_O0YU.png"
                alt="9Wickets"
                className="h-12 mx-auto object-contain"
              />

              {busy === "launch" && (
                <div className="mt-6 flex flex-col items-center gap-3">
                  <div className="w-8 h-8 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
                  <div className="text-sm font-medium text-emerald-100">Opening 9Wickets with your coins…</div>
                  <div className="text-xs text-white/50">Your coins move securely into the sportsbook</div>
                </div>
              )}

              {err && (
                <div className="mt-6 card p-4 border border-rose-500/30 bg-rose-950/20">
                  <div className="text-sm text-rose-300 font-medium">{err}</div>
                  <div className="flex gap-2 justify-center mt-4">
                    <button onClick={launch} className="btn-green rounded-xl px-4 py-2 text-sm font-semibold">
                      Try again
                    </button>
                    <button onClick={nav.back} className="btn-ghost rounded-xl px-4 py-2 text-sm">
                      Back
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bets Modal / Sheet */}
      {showBets && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[80vh] flex flex-col bg-[#0b1f16] border border-white/10 rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/20">
              <div className="text-sm font-semibold flex items-center gap-2 text-white">
                <ListOrdered size={16} className="text-emerald-400" /> My bets (last 7 days)
              </div>
              <button onClick={() => setShowBets(false)} className="w-7 h-7 grid place-items-center rounded-full bg-white/10 active:scale-95 text-white/70">
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {bets === null && <div className="text-center text-xs text-white/50 py-8">Loading your bets…</div>}
              {bets && bets.length === 0 && <div className="text-center text-xs text-white/50 py-8">No bets in the last 7 days.</div>}
              {bets?.map((b, i) => (
                <div key={b.bet_id ?? i} className="card p-3 text-xs bg-white/5 border border-white/10 rounded-xl">
                  <div className="font-semibold text-white truncate">{b.event ?? b.sport ?? "Bet"}</div>
                  <div className="text-white/60 truncate mt-0.5">
                    {[b.market, b.selection, b.side].filter(Boolean).join(" • ")}
                    {b.odds ? ` @ ${b.odds}` : ""}
                  </div>
                  <div className="flex justify-between items-center mt-2 pt-2 border-t border-white/5">
                    <span className="text-white/50">Stake: {inr(Number(b.stake ?? 0))}</span>
                    <span
                      className={`font-semibold ${
                        b.status !== "settled"
                          ? "text-amber-300"
                          : Number(b.profit_loss) >= 0
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {b.status !== "settled" ? "Open" : `${Number(b.profit_loss) >= 0 ? "+" : "−"}${inr(Math.abs(Number(b.profit_loss ?? 0)))}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
