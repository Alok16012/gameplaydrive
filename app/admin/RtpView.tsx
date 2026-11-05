"use client";

import { useEffect, useMemo, useState } from "react";
import { Percent, RefreshCw } from "lucide-react";
import { GAMES, type GameId } from "../lib/data";
import { GameIcon } from "../components/GameArt";
import { errText, supabase } from "../lib/supabase";

// Admin → RTP (Super Admin): every game on one screen — the RTP (or platform fee) set for it, what that means for
// players, and what the game actually paid back over the last days. House games take an RTP % straight (migration
// 114); games played between players (Teen Patti, Rummy, Poker, Ludo, Chess) and Stock Market take a fee %, so their
// RTP is 100 − fee. Cricket settles on match odds and JILI runs on the provider's own RNG, so those are shown only.

/** RTP on "Fair" for the house games (migration 114): the default, and the most the game can return — its natural
 *  return with every round dealt as it comes. */
export const RTP: Partial<Record<GameId, { def: number; max: number }>> = {
  "dragon-tiger": { def: 91, max: 97 }, "andar-bahar": { def: 91, max: 99 }, "lucky-7": { def: 91, max: 92 }, aviator: { def: 93, max: 99 },
  roulette: { def: 91, max: 97 }, plinko: { def: 91, max: 99 }, blackjack: { def: 91, max: 99 }, "stock-market": { def: 91, max: 100 },
};

type Kind = "rtp" | "fee" | "exchange" | "provider";
/** How each game's return is controlled, with the fee default where the fee is the control. */
const CONTROL: Record<string, { kind: Kind; feeDef?: number; about: string }> = {
  "dragon-tiger": { kind: "rtp", about: "Cards dealt against the bet just often enough to return this much" },
  "andar-bahar": { kind: "rtp", about: "Cards dealt against the bet just often enough to return this much" },
  "lucky-7": { kind: "rtp", about: "Cards dealt against the bet just often enough to return this much" },
  roulette: { kind: "rtp", about: "Spins landed against the bet just often enough to return this much" },
  plinko: { kind: "rtp", about: "Drops steered to a losing slot just often enough to return this much" },
  blackjack: { kind: "rtp", about: "Hands dealt against the player just often enough to return this much" },
  aviator: { kind: "rtp", about: "The crash curve: the chance of reaching M× is RTP ÷ M" },
  "stock-market": { kind: "fee", feeDef: 9, about: "A fair random walk; the house keeps a fee on every payout (RTP = 100 − fee)" },
  "teen-patti": { kind: "fee", feeDef: 5, about: "Fee taken from every pot before the winner is paid" },
  rummy: { kind: "fee", feeDef: 10, about: "13 and 21 Card. Fee on Points winnings and Pool / Deals prize pools" },
  poker: { kind: "fee", feeDef: 5, about: "Fee taken from every pot (side pots too) before the winners are paid" },
  ludo: { kind: "fee", feeDef: 10, about: "Fee taken from the entry pot before the winner is paid" },
  chess: { kind: "fee", feeDef: 10, about: "Fee taken from both entries before the winner is paid (none on a draw)" },
  cricket: { kind: "exchange", about: "Live exchange — bets settle on the real match at the odds taken; no RTP to set" },
  jili: { kind: "provider", about: "JILI's own games and RNG (slots usually 96–97%); the RTP is set by the provider, not here" },
};
const ORDER: GameId[] = ["dragon-tiger", "andar-bahar", "lucky-7", "roulette", "plinko", "blackjack", "aviator", "stock-market", "teen-patti", "rummy", "poker", "ludo", "chess", "cricket", "jili"];

type Cfg = { rtp?: number; rake?: number; outcome_mode?: string };
interface Actual { game: string; stakes: number; returns: number; bets: number; players: number }

const n = (v: number) => Math.round(v).toLocaleString("en-IN");

export function RtpView() {
  const [cfg, setCfg] = useState<Record<string, Cfg> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({}); // the box's text per game
  const [actual, setActual] = useState<Record<string, Actual> | null>(null);
  const [days, setDays] = useState(30);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const { data, error } = await supabase().from("app_settings").select("value").eq("key", "games").maybeSingle();
    if (error) return setErr(errText(error));
    const v = (data?.value ?? {}) as Record<string, Cfg>;
    setCfg(v);
    setDraft(Object.fromEntries(ORDER.map((id) => [id, boxValue(id, v[id])])));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    setActual(null);
    supabase().rpc("admin_game_rtp", { p_from: new Date(Date.now() - days * 86400000).toISOString() }).then(({ data, error }) => {
      if (error) return setErr(/admin_game_rtp/.test(errText(error)) ? "Run migration 118 first" : errText(error));
      setActual(Object.fromEntries(((data ?? []) as Actual[]).map((r) => [r.game, r])));
    });
  }, [days]);

  /** The number shown in the box: the set RTP for house games, the fee for the others (blank = default). */
  function boxValue(id: string, c: Cfg | undefined) {
    const k = CONTROL[id]?.kind;
    if (k === "rtp") return c?.rtp == null ? "" : String(c.rtp);
    if (k === "fee") return c?.rake == null ? "" : String(c.rake);
    return "";
  }
  /** Effective RTP for players from a box value. */
  const effective = (id: string, text: string) => {
    const k = CONTROL[id]?.kind;
    const v = text === "" ? undefined : Number(text);
    if (k === "rtp") return v ?? RTP[id as GameId]!.def;
    if (k === "fee") return 100 - (v ?? CONTROL[id].feeDef!);
    return null;
  };

  const save = async (id: string) => {
    const k = CONTROL[id].kind;
    const text = draft[id] ?? "";
    const v = text === "" ? null : Number(text);
    if (v !== null && !Number.isFinite(v)) return;
    setBusy(id);
    setMsg((m) => ({ ...m, [id]: "" }));
    const { error } = await supabase().rpc("set_game_settings", { p_game: id, p_cfg: k === "rtp" ? { rtp: v } : { rake: v ?? (id === "stock-market" ? 9 : null) } });
    setBusy(null);
    if (error) return setMsg((m) => ({ ...m, [id]: errText(error) }));
    setMsg((m) => ({ ...m, [id]: "Saved — applies from the next round" }));
    load();
  };

  const totals = useMemo(() => {
    let s = 0, r = 0;
    for (const a of Object.values(actual ?? {})) { s += Number(a.stakes); r += Number(a.returns); }
    return { s, r };
  }, [actual]);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2"><Percent size={20} className="text-amber-300" /> RTP — every game</div>
          <div className="text-sm text-white/55 mt-1">RTP = of every ₹100 players bet, about how much comes back to them over many rounds; the house keeps the rest. House games take an RTP straight; player-vs-player games and Stock Market take a fee (RTP = 100 − fee). Changes apply from the next round and are written to the audit log. Force Win / Force Loss (Win / Loss Control) override the RTP while set.</div>
        </div>
        <div className="flex items-center gap-1.5 bg-[#0d1435] p-1 rounded-xl border border-white/10">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${days === d ? "bg-sky-500/20 text-sky-300 border border-sky-400/40" : "text-white/60 hover:text-white"}`}>Last {d} days</button>
          ))}
          <button onClick={() => { load(); setDays((d) => d); }} className="p-1.5 text-white/60 hover:text-white" title="Refresh"><RefreshCw size={14} /></button>
        </div>
      </div>
      {err && <div className="text-xs text-rose-300 mb-3">{err}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-left text-[11px] text-white/50 border-b border-white/5">
              {["Game", "Control", "Set", "Players get (RTP)", `Actually paid back • last ${days} days`, "Bets", ""].map((h) => <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {ORDER.map((id) => {
              const g = GAMES.find((x) => x.id === id)!;
              const c = CONTROL[id];
              const text = draft[id] ?? "";
              const eff = effective(id, text);
              const a = actual?.[id];
              const paid = a && Number(a.stakes) > 0 ? (100 * Number(a.returns)) / Number(a.stakes) : null;
              const dirty = cfg !== null && text !== boxValue(id, cfg[id]);
              const forced = cfg?.[id]?.outcome_mode && cfg[id].outcome_mode !== "fair";
              const min = c.kind === "rtp" ? 70 : 0;
              const max = c.kind === "rtp" ? RTP[id as GameId]!.max : 25;
              return (
                <tr key={id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] align-top">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg grid place-items-center overflow-hidden shrink-0" style={{ background: `linear-gradient(160deg,${g.from},${g.to})` }}><div className="scale-[.45]"><GameIcon id={g.id} /></div></div>
                      <div>
                        <div className="font-medium">{id === "rummy" ? "Rummy 13 & 21 Cards" : g.name}</div>
                        <div className="text-[11px] text-white/45 max-w-[260px]">{c.about}</div>
                        {forced && <div className="text-[11px] text-amber-300 mt-0.5">⚠ {cfg![id].outcome_mode === "force_loss" ? "Force Loss" : "Force Win"} is on for this game — the RTP is not in effect</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-white/70 whitespace-nowrap">
                    {c.kind === "rtp" ? "RTP %" : c.kind === "fee" ? "Fee %" : c.kind === "exchange" ? "Match odds" : "Provider"}
                  </td>
                  <td className="px-4 py-3">
                    {c.kind === "rtp" || c.kind === "fee" ? (
                      <div className="flex items-center gap-1.5">
                        <input type="number" min={min} max={max} step={0.5} value={text} placeholder={String(c.kind === "rtp" ? RTP[id as GameId]!.def : c.feeDef)}
                          onChange={(e) => setDraft((d) => ({ ...d, [id]: e.target.value }))}
                          className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-sky-400" />
                        <span className="text-xs text-white/40">% <span className="text-white/30">({min}–{max})</span></span>
                      </div>
                    ) : <span className="text-xs text-white/40">—</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {eff !== null ? <span className="font-semibold text-amber-300">{eff}%</span> : <span className="text-xs text-white/40">{c.kind === "provider" ? "≈ 96–97% (JILI)" : "By the odds"}</span>}
                    {eff !== null && <div className="text-[11px] text-white/40">house keeps {Math.round((100 - eff) * 10) / 10}%</div>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {actual === null ? <span className="text-white/30">…</span> : paid === null ? <span className="text-xs text-white/40">No bets</span> : (
                      <>
                        <span className={`font-semibold ${paid > 100 ? "text-rose-400" : "text-emerald-400"}`}>{paid.toFixed(1)}%</span>
                        <div className="text-[11px] text-white/40">🪙 {n(Number(a!.stakes))} bet • {n(Number(a!.returns))} back • {a!.players} players</div>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-white/70 tabular-nums">{a ? n(Number(a.bets)) : ""}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {(c.kind === "rtp" || c.kind === "fee") && (
                      <>
                        <button disabled={!dirty || busy === id} onClick={() => save(id)} className="btn-green rounded-lg px-3 py-1.5 text-xs disabled:opacity-40">{busy === id ? "Saving…" : "Save"}</button>
                        {msg[id] && <div className={`text-[11px] mt-1 ${msg[id].startsWith("Saved") ? "text-neon-400" : "text-rose-300"}`}>{msg[id]}</div>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {actual && totals.s > 0 && (
            <tfoot>
              <tr className="border-t border-white/10 bg-white/[0.03] text-sm">
                <td className="px-4 py-3 font-semibold" colSpan={4}>All games • last {days} days</td>
                <td className="px-4 py-3 whitespace-nowrap"><span className={`font-semibold ${totals.r > totals.s ? "text-rose-400" : "text-emerald-400"}`}>{((100 * totals.r) / totals.s).toFixed(1)}%</span><div className="text-[11px] text-white/40">🪙 {n(totals.s)} bet • {n(totals.r)} back • house {n(totals.s - totals.r)}</div></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div className="text-[11px] text-white/40 mt-3">Teen Patti, Rummy, Poker: at public tables players also win and lose against the house bots, so what they got back there is not only the fee. Cricket: what was paid back on settled bets.</div>
    </>
  );
}
