"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { RoundBet, RoundResult } from "../api/round-lookup/route";

// Reports → Our / Live Casino Result: look one round up by its Round ID and see who bet what and what it paid.

const GAME_OPTIONS = [
  { id: "all", label: "All games" },
  { id: "andar-bahar", label: "Andar Bahar" },
  { id: "dragon-tiger", label: "Dragon Tiger" },
  { id: "lucky-7", label: "Lucky 7" },
  { id: "aviator", label: "Aviator" },
  { id: "stockmarket", label: "Stock Market" },
];

const SIDE: Record<string, string> = {
  andar: "Andar", bahar: "Bahar", dragon: "Dragon", tiger: "Tiger", tie: "Tie", pair: "Pair",
  below: "Below 7", seven: "Seven", above: "Above 7", low: "Low", high: "High", even: "Even", odd: "Odd", black: "Black", red: "Red",
  up: "Up", down: "Down",
};
const sideLabel = (s: string) =>
  SIDE[s] ??
  s.replace(/^d_/, "Dragon ").replace(/^t_/, "Tiger ").replace(/^g_/, "Group ").replace(/^c_/, "Card ").replace(/_/g, " ");

type CardJ = { r?: string; s?: string } | null | undefined;
const card = (c: CardJ) => (c ? `${c.r ?? ""}${c.s ?? ""}` : "—");
const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

function outcome(r: RoundResult) {
  const i = r.info as Record<string, unknown>;
  if (r.game === "Aviator") return `Crashed at ${Number(i.crash).toFixed(2)}x${i.settled ? "" : " • still running"}`;
  if (r.game === "Stock Market") return i.close === null ? "Not closed yet" : `Closed ${i.result} (${Number(i.close).toFixed(4)})`;
  if (r.legacy) return "Played before round details were saved — stake and payout only";
  const c = i.cards as Record<string, unknown> | null;
  const w = i.winner ? `Winner: ${sideLabel(String(i.winner))}` : "";
  if (!c) return w;
  if ("joker" in c) return `${w} • Joker ${card(c.joker as CardJ)} • Andar ${(c.andar as CardJ[]).map(card).join(" ")} • Bahar ${(c.bahar as CardJ[]).map(card).join(" ")}`;
  if ("dragon" in c) return `${w} • Dragon ${card(c.dragon as CardJ)} • Tiger ${card(c.tiger as CardJ)}`;
  if ("card" in c) return `${w} • Card ${card(c.card as CardJ)}`;
  return w;
}

function betText(r: RoundResult, b: RoundBet) {
  const d = b.detail as Record<string, unknown>;
  if (r.game === "Aviator") return `Bet ${d.slot}${d.auto ? ` • auto ${Number(d.auto).toFixed(2)}x` : ""} • ${d.cash ? `cashed out ${Number(d.cash).toFixed(2)}x` : "not cashed out"}`;
  if (r.game === "Stock Market") return `${sideLabel(String(d.side))}${d.cashTick !== null && d.cashTick !== undefined && Number(d.cashTick) < 80 ? ` • closed early (tick ${d.cashTick})` : " • held to close"}`;
  const bets = (d.bets as { side: string; v: number }[] | undefined) ?? [];
  return bets.length ? bets.map((x) => `${sideLabel(x.side)} ${fmt(Number(x.v))}`).join(", ") : "—";
}

export function RoundLookup() {
  const [round, setRound] = useState("");
  const [game, setGame] = useState("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState<RoundResult[] | null>(null);

  const search = async () => {
    const id = round.replace(/[^0-9]/g, "");
    if (!id) return setErr("Enter a Round ID");
    setBusy(true);
    setErr("");
    const { data } = await supabase().auth.getSession();
    const r = await fetch(`/api/round-lookup?round=${id}&game=${game}`, { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } }).catch(() => null);
    const j = await r?.json().catch(() => null);
    setBusy(false);
    if (!r?.ok) return setErr(j?.error ?? "Could not look up the round");
    setResults(j.results as RoundResult[]);
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div>
        <div className="text-sm font-bold text-white">Find a round</div>
        <div className="text-[11px] text-white/50">Type the Round ID shown in the game (e.g. Round #88245) to see every bet placed in it.</div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); search(); }} className="flex flex-wrap gap-2">
        <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm flex-1 min-w-[160px]">
          <span className="text-white/40">#</span>
          <input value={round} onChange={(e) => { setRound(e.target.value.replace(/[^0-9]/g, "")); setErr(""); }} inputMode="numeric" placeholder="Round ID" className="bg-transparent outline-none text-white w-full min-w-0" />
        </div>
        <select value={game} onChange={(e) => setGame(e.target.value)} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none">
          {GAME_OPTIONS.map((g) => <option key={g.id} value={g.id} className="bg-[#0d1335]">{g.label}</option>)}
        </select>
        <button type="submit" disabled={busy} className="btn-green rounded-xl px-4 py-2 text-sm flex items-center gap-1.5"><Search size={14} />{busy ? "Searching…" : "Search"}</button>
      </form>
      {err && <div className="text-xs text-rose-300">{err}</div>}
      {results && results.length === 0 && <div className="text-xs text-white/50 py-3">No bets found for Round #{round.replace(/[^0-9]/g, "")}{game !== "all" ? ` in ${GAME_OPTIONS.find((g) => g.id === game)?.label}` : ""}.</div>}
      {results?.map((r, i) => (
        <div key={i} className="rounded-xl border border-white/10 overflow-hidden">
          <div className="bg-white/5 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-white">{r.game} • Round #{r.round}</div>
            <div className="text-[11px] text-white/50">{when(r.at)}</div>
            <div className="w-full text-[12px] text-sky-300">{outcome(r)}</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left min-w-[520px]">
              <thead className="text-[10px] text-white/45 uppercase"><tr><th className="px-3 py-2">Player</th><th className="px-3 py-2">Bet</th><th className="px-3 py-2 text-right">Stake</th><th className="px-3 py-2 text-right">Payout</th><th className="px-3 py-2 text-right">Win / Loss</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {r.bets.map((b, k) => {
                  const net = b.payout - b.stake;
                  return (
                    <tr key={k}>
                      <td className="px-3 py-2 text-white font-medium whitespace-nowrap">{b.user ? `${b.user.name} (${b.user.code})` : "—"}</td>
                      <td className="px-3 py-2 text-white/80">{betText(r, b)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-300">{fmt(b.stake)}</td>
                      <td className="px-3 py-2 text-right font-mono text-sky-300">{fmt(b.payout)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold ${net > 0 ? "text-emerald-400" : net < 0 ? "text-rose-400" : "text-white/60"}`}>{net > 0 ? "+" : ""}{fmt(net)}</td>
                    </tr>
                  );
                })}
                {r.bets.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-white/40">No bets from your players in this round.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
