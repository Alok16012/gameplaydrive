"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, ChevronLeft, Coffee, LogOut, Play, Trophy, X } from "lucide-react";
import { inr } from "../../lib/data";
import { supabase } from "../../lib/supabase";

// The side menu of the card tables (Teen Patti, Poker, Rummy / 21 Card Rummy), opened from Leave / Exit: leave the
// game, sit out (keep the seat, skip the next hands), switch to another table at the same stakes, or see today's
// leaderboard for the game (game_leaderboard, migration 108).

interface Board { top: { rank: number; name: string; net: number; me: boolean }[]; me: { rank: number; net: number } | null; players: number }

export function TableMenu({ open, onClose, game, sittingOut, sitOutNote, onLeave, onSitOut, onSwitch, busy }: {
  open: boolean;
  onClose: () => void;
  /** Ledger name of the game for the leaderboard: "Teen Patti", "Poker" or "Rummy". */
  game: "Teen Patti" | "Poker" | "Rummy";
  sittingOut: boolean;
  /** When sitting out takes effect, e.g. "from the next hand". */
  sitOutNote: string;
  onLeave: () => void;
  onSitOut: (on: boolean) => void;
  /** Switch table (public tables only). */
  onSwitch?: () => void;
  busy?: boolean;
}) {
  const [view, setView] = useState<"menu" | "board">("menu");
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => { if (!open) setView("menu"); }, [open]);
  useEffect(() => {
    if (!open || view !== "board") return;
    let alive = true;
    setErr("");
    supabase().rpc("game_leaderboard", { p_game: game }).then(({ data, error }) => {
      if (!alive) return;
      if (error) setErr("Could not load the leaderboard");
      else setBoard(data as Board);
    });
    return () => { alive = false; };
  }, [open, view, game]);

  const winners = (board?.top ?? []).filter((r) => r.net > 0); // the board shows who is up today

  const item = (icon: React.ReactNode, label: string, sub: string, onClick: () => void, tone = "") => (
    <button onClick={onClick} disabled={busy} className={`w-full flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left bg-white/[0.06] hover:bg-white/10 active:scale-[.98] transition disabled:opacity-50 ${tone}`}>
      <span className="w-9 h-9 rounded-full bg-white/10 grid place-items-center shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold">{label}</span>
        <span className="block text-[11px] text-white/55">{sub}</span>
      </span>
    </button>
  );

  return (
    <div className={`fixed inset-0 z-[60] ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div onClick={onClose} className={`absolute inset-0 bg-black/55 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <aside className={`absolute right-0 top-0 bottom-0 w-[82%] max-w-[320px] bg-[#0d1230] border-l border-white/10 shadow-2xl flex flex-col transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center gap-2 px-4 h-14 border-b border-white/10 shrink-0">
          {view === "board" && <button onClick={() => setView("menu")} aria-label="Back" className="-ml-1 w-8 h-8 grid place-items-center rounded-full hover:bg-white/10"><ChevronLeft size={20} /></button>}
          <div className="flex-1 text-[15px] font-semibold">{view === "board" ? `${game} • Today` : "Table menu"}</div>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 grid place-items-center rounded-full hover:bg-white/10"><X size={18} /></button>
        </div>

        {view === "menu" ? (
          <div className="p-3 space-y-2 overflow-y-auto">
            {sittingOut
              ? item(<Play size={17} className="text-neon-400" />, "I'm back", "Deal me in again", () => onSitOut(false), "ring-1 ring-neon-400/40")
              : item(<Coffee size={17} className="text-amber-300" />, "Sit out", `Keep your seat — not dealt in ${sitOutNote}`, () => onSitOut(true))}
            {onSwitch && item(<ArrowLeftRight size={17} className="text-sky-300" />, "Switch table", "Move to another table at the same stakes", onSwitch)}
            {item(<Trophy size={17} className="text-gold-300" />, "Leaderboard", "Today's biggest winners", () => setView("board"))}
            {item(<LogOut size={17} className="text-rose-300" />, "Leave game", "Give up your seat and go back", onLeave, "text-rose-100")}
          </div>
        ) : (
          <div className="p-3 overflow-y-auto">
            {err && <div className="text-xs text-rose-300 px-1 py-2">{err}</div>}
            {!board && !err && <div className="text-xs text-white/50 px-1 py-6 text-center animate-pulse">Loading…</div>}
            {board && winners.length === 0 && <div className="text-xs text-white/50 px-1 py-6 text-center">No winners yet today — be the first on the board.</div>}
            {winners.length > 0 && (
              <div className="space-y-1.5">
                {winners.map((r) => (
                  <div key={`${r.rank}-${r.name}`} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${r.me ? "bg-neon-400/15 ring-1 ring-neon-400/40" : "bg-white/[0.05]"}`}>
                    <span className={`w-7 text-center font-extrabold ${r.rank === 1 ? "text-gold-300" : r.rank <= 3 ? "text-white" : "text-white/50"}`}>{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : `#${r.rank}`}</span>
                    <span className="flex-1 text-[13px] font-medium truncate">{r.me ? "You" : r.name}</span>
                    <span className={`text-[13px] font-semibold tabular-nums ${r.net > 0 ? "text-neon-400" : r.net < 0 ? "text-rose-300" : "text-white/60"}`}>{r.net > 0 ? "+" : r.net < 0 ? "−" : ""}{inr(Math.abs(r.net))}</span>
                  </div>
                ))}
              </div>
            )}
            {board?.me && !winners.some((r) => r.me) && (
              <div className="mt-3 rounded-xl bg-white/[0.05] px-3 py-2 text-[12px] text-white/70">Your rank today: <b>#{board.me.rank}</b> of {board.players} • {board.me.net >= 0 ? "+" : "−"}{inr(Math.abs(board.me.net))}</div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
