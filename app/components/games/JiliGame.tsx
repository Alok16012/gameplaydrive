"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ExternalLink, Search } from "lucide-react";
import { apiFetch } from "../../lib/supabase";
import type { JiliGameInfo } from "../../lib/server/jili";
import type { Nav } from "../nav";

// JILI games from the iGaming SoftAPI, played inside the app. For now in free play (demo): JILI's own games with
// practice credits — no coins are used. Real-coin play comes once the SoftAPI launch and bet callbacks are set up.

const CATS = ["All", "Slots", "Fishing", "Crash", "Mines", "Table & Casino", "Mini games"] as const;
const POPULAR = ["Super Ace", "Fortune Gems", "Golden Empire", "Money Coming", "Boxing King", "Crazy777", "Fortune Gems 2", "Super Ace Deluxe", "Mines", "Plinko"];

/** The JILI lobby: every game on our account, searchable, by category, popular ones first. */
export function JiliLobby({ nav }: { nav: Nav }) {
  const [games, setGames] = useState<JiliGameInfo[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<(typeof CATS)[number]>("All");

  useEffect(() => {
    let alive = true;
    apiFetch("/api/jili/games")
      .then((r) => r.json())
      .then((j: { games?: JiliGameInfo[]; error?: string }) => {
        if (!alive) return;
        if (j.games) setGames(j.games);
        else setErr(j.error ?? "Could not load the games");
      })
      .catch(() => alive && setErr("Could not load the games — check your connection"));
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank = (g: JiliGameInfo) => { const i = POPULAR.indexOf(g.name); return i < 0 ? (g.logo ? 100 : 200) : i; };
    return (games ?? [])
      .filter((g) => (cat === "All" || g.category === cat) && (!needle || g.name.toLowerCase().includes(needle)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [games, q, cat]);
  const counts = useMemo(() => Object.fromEntries(CATS.map((c) => [c, c === "All" ? games?.length ?? 0 : (games ?? []).filter((g) => g.category === c).length])), [games]);

  return (
    <div className="min-h-dvh flex flex-col fadein" style={{ background: "radial-gradient(120% 60% at 50% 0%, #3b2306 0%, #120c05 55%, #07060a 100%)" }}>
      <div className="sticky top-0 z-10 bg-black/40 backdrop-blur px-3 pt-2 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={nav.back} aria-label="Back" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95"><ChevronLeft size={18} /></button>
          <div className="leading-tight">
            <div className="text-base font-bold text-amber-300">JILI Games</div>
            <div className="text-[10px] text-white/55">{games ? `${games.length} games` : "Loading…"} • Free play — no coins used</div>
          </div>
        </div>
        <label className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
          <Search size={15} className="text-white/50" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search games" className="flex-1 bg-transparent outline-none text-sm" />
        </label>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
          {CATS.filter((c) => c === "All" || counts[c] > 0).map((c) => (
            <button key={c} onClick={() => setCat(c)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold border transition ${cat === c ? "bg-amber-400 text-black border-amber-300" : "border-white/15 text-white/70"}`}>
              {c} {games ? <span className="opacity-60">{counts[c]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 pb-8 pt-2">
        {err && <div className="text-sm text-white/70 text-center py-10">{err}</div>}
        {!games && !err && <div className="text-sm text-white/50 text-center py-10 animate-pulse">Loading JILI games…</div>}
        {games && shown.length === 0 && <div className="text-sm text-white/50 text-center py-10">No game matches “{q}”.</div>}
        <div className="grid grid-cols-3 gap-2.5">
          {shown.map((g) => (
            <button key={g.uid} onClick={() => nav.push({ name: "jiliplay", uid: g.uid, title: g.name })} className="text-left active:scale-95 transition">
              <div className="aspect-square rounded-xl overflow-hidden border border-amber-300/20 shadow-lg bg-gradient-to-br from-amber-700 to-[#2a1405] grid place-items-center">
                {g.logo
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={g.logo} alt={g.name} loading="lazy" className="w-full h-full object-cover" />
                  : <span className="px-2 text-center text-[12px] font-bold text-amber-100 leading-tight">{g.name}</span>}
              </div>
              <div className="mt-1 text-[11px] font-medium truncate">{g.name}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One JILI game, full screen inside the app. */
export function JiliGame({ nav, uid, title }: { nav: Nav; uid: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/jili/demo?uid=${encodeURIComponent(uid)}`)
      .then((r) => r.json())
      .then((j: { url?: string; error?: string }) => {
        if (!alive) return;
        if (j.url) setUrl(j.url);
        else setErr(j.error ?? "The game could not be opened");
      })
      .catch(() => alive && setErr("The game could not be opened — check your connection"));
    return () => { alive = false; };
  }, [uid]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <div className="h-11 shrink-0 flex items-center gap-2 px-2 bg-[#0b0f24] border-b border-white/10">
        <button onClick={nav.back} aria-label="Back" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95"><ChevronLeft size={18} /></button>
        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold truncate">{title}</div>
          <div className="text-[10px] text-amber-300">JILI • Free play — practice credits, no coins used</div>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto text-[11px] text-white/60 flex items-center gap-1 pr-1">
            <ExternalLink size={13} /> Full screen
          </a>
        )}
      </div>
      <div className="relative flex-1 min-h-0">
        {url ? (
          <iframe src={url} title={title} className="absolute inset-0 w-full h-full border-0" allow="autoplay; fullscreen" allowFullScreen />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-center px-6">
            {err ? (
              <div>
                <div className="text-sm text-white/80">{err}</div>
                <button onClick={nav.back} className="btn-ghost rounded-xl px-5 py-2.5 mt-4 text-sm">Back to JILI games</button>
              </div>
            ) : (
              <div className="text-sm text-white/60 animate-pulse">Loading {title}…</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
