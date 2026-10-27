"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { gameById, type GameId } from "../../lib/data";
import { apiFetch } from "../../lib/supabase";
import type { Nav } from "../nav";

// A JILI game from the iGaming SoftAPI, played inside the app. For now in free play (demo): JILI's own game with
// practice credits — no coins are used. Real-coin play comes once the SoftAPI launch and bet callbacks are set up.

export function JiliGame({ nav, game }: { nav: Nav; game: GameId }) {
  const g = gameById(game);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/jili/demo?game=${encodeURIComponent(game)}`)
      .then((r) => r.json())
      .then((j: { url?: string; error?: string }) => {
        if (!alive) return;
        if (j.url) setUrl(j.url);
        else setErr(j.error ?? "The game could not be opened");
      })
      .catch(() => alive && setErr("The game could not be opened — check your connection"));
    return () => { alive = false; };
  }, [game]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <div className="h-11 shrink-0 flex items-center gap-2 px-2 bg-[#0b0f24] border-b border-white/10">
        <button onClick={nav.back} aria-label="Back" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95"><ChevronLeft size={18} /></button>
        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold truncate">{g?.name ?? "JILI"}</div>
          <div className="text-[10px] text-amber-300">Free play • practice credits, no coins used</div>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto text-[11px] text-white/60 flex items-center gap-1 pr-1">
            <ExternalLink size={13} /> Full screen
          </a>
        )}
      </div>
      <div className="relative flex-1 min-h-0">
        {url ? (
          <iframe src={url} title={g?.name ?? "JILI game"} className="absolute inset-0 w-full h-full border-0" allow="autoplay; fullscreen" allowFullScreen />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-center px-6">
            {err ? (
              <div>
                <div className="text-sm text-white/80">{err}</div>
                <button onClick={nav.back} className="btn-ghost rounded-xl px-5 py-2.5 mt-4 text-sm">Back</button>
              </div>
            ) : (
              <div className="text-sm text-white/60 animate-pulse">Loading {g?.name ?? "game"}…</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
