"use client";

import { Lock, Unlock } from "lucide-react";
import { LOBBY_GAMES } from "../lib/data";
import { errText, supabase } from "../lib/supabase";

// Game access per account (migrations 115, 122): the games switched off for an admin, agent or player. What is off for
// an account is off for everyone under it, so a game switched off above shows here as off and can't be switched on.
// Used while creating an ID (Admin / Agent / Player form) and later from the details card → Games.

export const ACCESS_GAMES = LOBBY_GAMES.map((g) => ({ id: g.id, name: g.id === "rummy" ? "Rummy 13 Cards" : g.name }));

/** An account's own switched-off games and those switched off above it. Before migration 122: own only. */
export async function loadGameAccess(id: string): Promise<{ own: string[]; inherited: string[] }> {
  const { data, error } = await supabase().rpc("game_access_of", { p_uid: id });
  if (!error && data) {
    const d = data as { own?: string[]; inherited?: string[] };
    return { own: d.own ?? [], inherited: d.inherited ?? [] };
  }
  const r = await supabase().from("profiles").select("locked_games").eq("id", id).maybeSingle();
  if (r.error) throw new Error(/locked_games/.test(errText(r.error)) ? "Run migration 115 first" : errText(r.error));
  return { own: (r.data?.locked_games ?? []) as string[], inherited: [] };
}

/** Save the games switched off for an account; returns what was saved. */
export async function saveGameAccess(id: string, locked: Iterable<string>): Promise<string[]> {
  const { data, error } = await supabase().rpc("set_player_games", { target: id, p_locked: [...locked] });
  if (error) throw new Error(errText(error));
  return (data ?? []) as string[];
}

/** A switch per game. `inherited`: off above this account — shown off and locked. */
export function GameAccessPicker({ locked, inherited, onChange, compact = false }: { locked: Set<string>; inherited: Set<string>; onChange: (next: Set<string>) => void; compact?: boolean }) {
  const flip = (id: string) => { const n = new Set(locked); if (n.has(id)) n.delete(id); else n.add(id); onChange(n); };
  const allowed = ACCESS_GAMES.filter((g) => !inherited.has(g.id));
  const on = allowed.filter((g) => !locked.has(g.id)).length;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] text-white/50 flex-1">{on} of {ACCESS_GAMES.length} games on</span>
        <button type="button" onClick={() => onChange(new Set())} className="rounded-lg px-2.5 py-1 text-[11px] bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">All on</button>
        <button type="button" onClick={() => onChange(new Set(allowed.map((g) => g.id)))} className="rounded-lg px-2.5 py-1 text-[11px] bg-rose-500/15 border border-rose-500/30 text-rose-300">All off</button>
      </div>
      <div className={compact ? "grid grid-cols-2 gap-x-3" : ""}>
        {ACCESS_GAMES.map((g) => {
          const fixed = inherited.has(g.id);
          const isOn = !fixed && !locked.has(g.id);
          return (
            <button key={g.id} type="button" disabled={fixed} onClick={() => flip(g.id)} title={fixed ? "Switched off above this account" : undefined}
              className={`w-full flex items-center gap-2.5 py-2 px-1 border-b border-white/5 text-left ${fixed ? "opacity-45" : ""}`}>
              <span className={`p-1 rounded-md ${isOn ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>{isOn ? <Unlock size={12} /> : <Lock size={12} />}</span>
              <span className="flex-1 min-w-0 text-[13px] text-white truncate">{g.name}{fixed && <span className="block text-[10px] text-white/45">Off for the upline</span>}</span>
              <span className={`w-9 h-5 shrink-0 rounded-full p-0.5 transition-colors ${isOn ? "bg-emerald-500" : "bg-white/15"}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${isOn ? "translate-x-4" : ""}`} /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
