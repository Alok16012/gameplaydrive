"use client";

import { useEffect, useMemo, useState } from "react";
import { Percent, RefreshCw } from "lucide-react";
import { GAMES, type GameId } from "../lib/data";
import { GameIcon } from "../components/GameArt";
import { errText, supabase } from "../lib/supabase";

// Admin → RTP (Super Admin). Two sub-sections:
//   RTP — every game: the RTP set for it (what players get back of every ₹100 over many rounds), and what the game
//         actually paid back over the last days. House games deal against the bet just often enough (migration 114);
//         games against the house bots / computer deal the player's way just often enough (119); Stock Market's RTP
//         is 100 − its fee. Cricket settles on match odds and JILI runs on the provider's RNG — shown only.
//   Fee — the platform fee of the games played between players: Teen Patti, Rummy 13 / 21, Poker, Ludo, Chess (and
//         Stock Market's fee on payouts).

/** RTP defaults and ceilings. House games can't return more than their natural return; the others top out at 99. */
export const RTP: Partial<Record<GameId, { def: number; max: number }>> = {
  "dragon-tiger": { def: 91, max: 97 }, "andar-bahar": { def: 91, max: 99 }, "lucky-7": { def: 91, max: 92 }, aviator: { def: 93, max: 99 },
  roulette: { def: 91, max: 97 }, plinko: { def: 91, max: 99 }, blackjack: { def: 91, max: 99 }, "stock-market": { def: 91, max: 100 },
  "teen-patti": { def: 91, max: 99 }, rummy: { def: 91, max: 99 }, poker: { def: 91, max: 99 }, ludo: { def: 91, max: 99 }, chess: { def: 91, max: 99 },
};

type Kind = "house" | "bots" | "market" | "exchange" | "provider";
const ABOUT: Record<string, { kind: Kind; rtp: string; fee?: string; feeDef?: number }> = {
  "dragon-tiger": { kind: "house", rtp: "Cards dealt against the bet just often enough to return this much" },
  "andar-bahar": { kind: "house", rtp: "Cards dealt against the bet just often enough to return this much" },
  "lucky-7": { kind: "house", rtp: "Cards dealt against the bet just often enough to return this much" },
  roulette: { kind: "house", rtp: "Spins landed against the bet just often enough to return this much" },
  plinko: { kind: "house", rtp: "Drops steered to a losing slot just often enough to return this much" },
  blackjack: { kind: "house", rtp: "Hands dealt against the player just often enough to return this much" },
  aviator: { kind: "house", rtp: "The crash curve: the chance of reaching M× is RTP ÷ M" },
  "stock-market": { kind: "market", rtp: "A fair random walk; RTP = 100 − the fee on every payout", fee: "Taken from every payout", feeDef: 9 },
  "teen-patti": { kind: "bots", rtp: "Hands dealt the player's way just often enough — against the house bots", fee: "Taken from every pot before the winner is paid", feeDef: 5 },
  rummy: { kind: "bots", rtp: "13 and 21 Card. Deals go the player's way just often enough — against the house bots", fee: "On Points winnings and Pool / Deals prize pools", feeDef: 10 },
  poker: { kind: "bots", rtp: "Hands dealt the player's way just often enough — against the house bots", fee: "Taken from every pot (side pots too) before the winners are paid", feeDef: 5 },
  ludo: { kind: "bots", rtp: "Dice fall the player's way just often enough — against the computer", fee: "Taken from the entry pot before the winner is paid", feeDef: 10 },
  chess: { kind: "bots", rtp: "Games go the player's way just often enough — against the computer", fee: "Taken from both entries before the winner is paid (none on a draw)", feeDef: 10 },
  cricket: { kind: "exchange", rtp: "Live exchange — bets settle on the real match at the odds taken; no RTP to set" },
  jili: { kind: "provider", rtp: "JILI's own games and RNG (slots usually 96–97%); the RTP is set by the provider, not here" },
  matka: { kind: "provider", rtp: "Bharat Matka runs on the provider's own draw; the return is set by the provider, not here" },
  "9wickets": { kind: "exchange", rtp: "9Wickets live exchange — bets settle on real matches at the odds taken (provider); no RTP to set" },
};
const RTP_ORDER: GameId[] = ["dragon-tiger", "andar-bahar", "lucky-7", "roulette", "plinko", "blackjack", "aviator", "stock-market", "teen-patti", "rummy", "poker", "ludo", "chess"]; // Cricket, JILI, Matka, 9Wickets: no RTP to set here
const FEE_ORDER: GameId[] = ["teen-patti", "rummy", "poker", "ludo", "chess", "stock-market"];

type Cfg = { rtp?: number; rake?: number; outcome_mode?: string };
interface Actual { game: string; stakes: number; returns: number; bets: number; players: number }

const n = (v: number) => Math.round(v).toLocaleString("en-IN");
const name = (id: string) => (id === "rummy" ? "Rummy 13 & 21 Cards" : GAMES.find((x) => x.id === id)!.name);

export function RtpView() {
  const [tab, setTab] = useState<"rtp" | "fee">("rtp");
  const [cfg, setCfg] = useState<Record<string, Cfg> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({}); // box text, keyed "rtp:<game>" / "fee:<game>"
  const [actual, setActual] = useState<Record<string, Actual> | null>(null);
  const [days, setDays] = useState(30);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  /** The box's text from the saved settings: the set RTP (Stock Market: 100 − fee), or the fee. Blank = default. */
  const boxOf = (kind: "rtp" | "fee", id: string, c: Cfg | undefined) => {
    if (kind === "fee") return c?.rake == null ? "" : String(c.rake);
    if (id === "stock-market") return c?.rake == null ? "" : String(100 - c.rake);
    return c?.rtp == null ? "" : String(c.rtp);
  };
  const load = async () => {
    const { data, error } = await supabase().from("app_settings").select("value").eq("key", "games").maybeSingle();
    if (error) return setErr(errText(error));
    const v = (data?.value ?? {}) as Record<string, Cfg>;
    setCfg(v);
    const d: Record<string, string> = {};
    for (const id of RTP_ORDER) d[`rtp:${id}`] = boxOf("rtp", id, v[id]);
    for (const id of FEE_ORDER) d[`fee:${id}`] = boxOf("fee", id, v[id]);
    setDraft(d);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    setActual(null);
    supabase().rpc("admin_game_rtp", { p_from: new Date(Date.now() - days * 86400000).toISOString() }).then(({ data, error }) => {
      if (error) return setErr(/admin_game_rtp/.test(errText(error)) ? "Run migration 118 first" : errText(error));
      setActual(Object.fromEntries(((data ?? []) as Actual[]).map((r) => [r.game, r])));
    });
  }, [days]);

  const save = async (kind: "rtp" | "fee", id: string) => {
    const key = `${kind}:${id}`;
    const text = draft[key] ?? "";
    const v = text === "" ? null : Number(text);
    if (v !== null && !Number.isFinite(v)) return;
    // Stock Market keeps its RTP as the fee: RTP 91 = fee 9; a blank RTP is the default fee, not "no fee".
    const patch = kind === "fee" ? { rake: v ?? (id === "stock-market" ? 9 : null) }
      : id === "stock-market" ? { rake: v === null ? 9 : 100 - v } : { rtp: v };
    setBusy(key);
    setMsg((m) => ({ ...m, [key]: "" }));
    const { error } = await supabase().rpc("set_game_settings", { p_game: id, p_cfg: patch });
    setBusy(null);
    if (error) return setMsg((m) => ({ ...m, [key]: /Unknown setting|rtp/i.test(errText(error)) && kind === "rtp" ? "Run migration 119 first" : errText(error) }));
    setMsg((m) => ({ ...m, [key]: "Saved — applies from the next round" }));
    load();
  };

  const totals = useMemo(() => {
    let s = 0, r = 0;
    for (const a of Object.values(actual ?? {})) { s += Number(a.stakes); r += Number(a.returns); }
    return { s, r };
  }, [actual]);

  const th = "px-4 py-3 font-medium whitespace-nowrap";
  const Row = ({ g }: { g: GameId }) => {
    const game = GAMES.find((x) => x.id === g)!;
    const a = ABOUT[g];
    return (
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg grid place-items-center overflow-hidden shrink-0" style={{ background: `linear-gradient(160deg,${game.from},${game.to})` }}><div className="scale-[.45]"><GameIcon id={game.id} /></div></div>
        <div>
          <div className="font-medium">{name(g)}</div>
          <div className="text-[11px] text-white/45 max-w-[260px]">{tab === "rtp" ? a.rtp : a.fee}</div>
          {tab === "rtp" && cfg?.[g]?.outcome_mode && cfg[g].outcome_mode !== "fair" && (
            <div className="text-[11px] text-amber-300 mt-0.5">⚠ {cfg[g].outcome_mode === "force_loss" ? "Force Loss" : "Force Win"} is on for this game — the RTP is not in effect</div>
          )}
        </div>
      </div>
    );
  };
  const SaveCell = ({ kind, id }: { kind: "rtp" | "fee"; id: string }) => {
    const key = `${kind}:${id}`;
    const dirty = cfg !== null && (draft[key] ?? "") !== boxOf(kind, id, cfg[id]);
    return (
      <>
        <button disabled={!dirty || busy === key} onClick={() => save(kind, id)} className="btn-green rounded-lg px-3 py-1.5 text-xs disabled:opacity-40">{busy === key ? "Saving…" : "Save"}</button>
        {msg[key] && <div className={`text-[11px] mt-1 ${msg[key].startsWith("Saved") ? "text-neon-400" : "text-rose-300"}`}>{msg[key]}</div>}
      </>
    );
  };
  const box = (key: string, min: number, max: number, placeholder: number) => (
    <div className="flex items-center gap-1.5">
      <input type="number" min={min} max={max} step={0.5} value={draft[key] ?? ""} placeholder={String(placeholder)}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-sky-400" />
      <span className="text-xs text-white/40">% <span className="text-white/30">({min}–{max})</span></span>
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2"><Percent size={20} className="text-amber-300" /> RTP &amp; Fee</div>
          <div className="text-sm text-white/55 mt-1">
            {tab === "rtp"
              ? "RTP = of every ₹100 players bet, about how much comes back to them over many rounds; the house keeps the rest. Changes apply from the next round and go to the audit log. Force Win / Force Loss (Win / Loss Control) override the RTP while set."
              : "The platform fee kept from the games played between players — off the pot, the prize pool or the entries before the winner is paid. Players see the fee in the game. Changes apply from the next hand and go to the audit log."}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 bg-[#0d1435] p-1 rounded-xl border border-white/10">
            {([["rtp", "RTP — all games"], ["fee", "Fee — card & board games"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === id ? "bg-amber-400 text-black" : "text-white/60 hover:text-white"}`}>{label}</button>
            ))}
          </div>
          {tab === "rtp" && (
            <div className="flex items-center gap-1 bg-[#0d1435] p-1 rounded-xl border border-white/10">
              {[7, 30, 90].map((d) => (
                <button key={d} onClick={() => setDays(d)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${days === d ? "bg-sky-500/20 text-sky-300 border border-sky-400/40" : "text-white/60 hover:text-white"}`}>Last {d} days</button>
              ))}
              <button onClick={() => { load(); setDays((d) => d); }} className="p-1.5 text-white/60 hover:text-white" title="Refresh"><RefreshCw size={14} /></button>
            </div>
          )}
        </div>
      </div>
      {err && <div className="text-xs text-rose-300 mb-3">{err}</div>}

      {tab === "rtp" && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-[11px] text-white/50 border-b border-white/5">
                {["Game", "RTP set", "Players get", `Actually paid back • last ${days} days`, "Bets", ""].map((h) => <th key={h} className={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {RTP_ORDER.map((id) => {
                const a = ABOUT[id];
                const r = RTP[id];
                const key = `rtp:${id}`;
                const text = draft[key] ?? "";
                const eff = r ? (text === "" ? r.def : Number(text)) : null;
                const act = actual?.[id];
                const paid = act && Number(act.stakes) > 0 ? (100 * Number(act.returns)) / Number(act.stakes) : null;
                const fee = id === "stock-market" ? null : cfg?.[id]?.rake ?? a.feeDef;
                return (
                  <tr key={id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] align-top">
                    <td className="px-4 py-3"><Row g={id} /></td>
                    <td className="px-4 py-3">{r ? box(key, id === "stock-market" ? 75 : 70, r.max, r.def) : <span className="text-xs text-white/40">—</span>}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {eff !== null ? (
                        <>
                          <span className="font-semibold text-amber-300">{eff}%</span>
                          <div className="text-[11px] text-white/40">house keeps {Math.round((100 - eff) * 10) / 10}%{a.kind === "bots" && fee != null ? ` • fee ${fee}%` : ""}</div>
                        </>
                      ) : <span className="text-xs text-white/40">{a.kind === "provider" ? (id === "jili" ? "≈ 96–97% (JILI)" : "Set by the provider") : "By the odds"}</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {actual === null ? <span className="text-white/30">…</span> : paid === null ? <span className="text-xs text-white/40">No bets</span> : (
                        <>
                          <span className={`font-semibold ${paid > 100 ? "text-rose-400" : "text-emerald-400"}`}>{paid.toFixed(1)}%</span>
                          <div className="text-[11px] text-white/40">🪙 {n(Number(act!.stakes))} bet • {n(Number(act!.returns))} back • {act!.players} players</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-white/70 tabular-nums">{act ? n(Number(act.bets)) : ""}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{r && <SaveCell kind="rtp" id={id} />}</td>
                  </tr>
                );
              })}
            </tbody>
            {actual && totals.s > 0 && (
              <tfoot>
                <tr className="border-t border-white/10 bg-white/[0.03] text-sm">
                  <td className="px-4 py-3 font-semibold" colSpan={3}>All games • last {days} days</td>
                  <td className="px-4 py-3 whitespace-nowrap"><span className={`font-semibold ${totals.r > totals.s ? "text-rose-400" : "text-emerald-400"}`}>{((100 * totals.r) / totals.s).toFixed(1)}%</span><div className="text-[11px] text-white/40">🪙 {n(totals.s)} bet • {n(totals.r)} back • house {n(totals.s - totals.r)}</div></td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {tab === "fee" && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-[11px] text-white/50 border-b border-white/5">
                {["Game", "Fee set", "House keeps", ""].map((h) => <th key={h} className={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {FEE_ORDER.map((id) => {
                const a = ABOUT[id];
                const key = `fee:${id}`;
                const text = draft[key] ?? "";
                const fee = text === "" ? a.feeDef! : Number(text);
                return (
                  <tr key={id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] align-top">
                    <td className="px-4 py-3"><Row g={id} /></td>
                    <td className="px-4 py-3">{box(key, 0, 25, a.feeDef!)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-semibold text-amber-300">{fee}%</span>
                      <div className="text-[11px] text-white/40">{id === "stock-market" ? `of every payout • RTP ${100 - fee}%` : "of every pot / prize"}</div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap"><SaveCell kind="fee" id={id} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[11px] text-white/40 mt-3">
        {tab === "rtp"
          ? "Teen Patti, Rummy, Poker, Ludo, Chess: the RTP sets how often hands go the player's way against the house bots / computer; between real players (private tables) only the fee applies. What they actually got back also counts play between real players. Cricket: what was paid back on settled bets."
          : "The fee is the same at public and private tables. Game Config has the same fee boxes along with the other table settings."}
      </div>
    </>
  );
}
