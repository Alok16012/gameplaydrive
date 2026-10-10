"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, Trophy } from "lucide-react";
import { coins, type Account } from "../lib/hierarchy";
import { errText, supabase } from "../lib/supabase";
import type { SportBetRow } from "../lib/cricketApi";

// Super Admin declares the result of each cricket market; settle_sport_market pays every open bet on it.

interface MarketGroup {
  eventId: string;
  eventName: string;
  marketName: string;
  marketType: SportBetRow["market_type"];
  bets: SportBetRow[];
}

export function CricketResultsView({ accounts }: { me: Account; accounts: Account[] }) {
  const [rows, setRows] = useState<SportBetRow[]>([]);
  const [settledRows, setSettledRows] = useState<SportBetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const load = async () => {
    setLoading(true);
    setErr("");
    try {
      const sb = supabase();
      const [open, done] = await Promise.all([
        sb.from("sport_bets").select("*").eq("status", "OPEN").order("created_at", { ascending: true }).limit(1000),
        sb.from("sport_bets").select("*").neq("status", "OPEN").order("settled_at", { ascending: false }).limit(50),
      ]);
      if (open.error) throw open.error;
      if (done.error) throw done.error;
      setRows(open.data as SportBetRow[]);
      setSettledRows(done.data as SportBetRow[]);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, MarketGroup>();
    for (const r of rows) {
      const key = `${r.event_id}|${r.market_name}`;
      if (!m.has(key)) {
        m.set(key, { eventId: r.event_id, eventName: r.event_name, marketName: r.market_name, marketType: r.market_type, bets: [] });
      }
      m.get(key)!.bets.push(r);
    }
    return [...m.entries()];
  }, [rows]);

  // Possible winners: both teams from the event name plus every runner someone bet on.
  const runnerOptions = (g: MarketGroup) => {
    const teams = g.eventName.split(/\s+(?:v|vs)\.?\s+/i).map((t) => t.trim()).filter(Boolean);
    return [...new Set([...teams, ...g.bets.map((b) => b.runner_name)])];
  };

  const settle = async (key: string, g: MarketGroup, result: string) => {
    setBusy(key);
    setErr("");
    setMsg("");
    try {
      const { data, error } = await supabase().rpc("settle_sport_market", {
        p_event_id: g.eventId,
        p_market_name: g.marketName,
        p_result: result,
      });
      if (error) throw error;
      setMsg(
        `${g.eventName} • ${g.marketName}: ${result} — won ${data.won}, lost ${data.lost}, void ${data.void}, paid ${coins(data.paid)}`
      );
      setConfirmKey(null);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Trophy size={20} className="text-gold-300" /> Cricket Results
          </h1>
          <p className="text-xs text-white/50 mt-1">
            Declare each market&apos;s result to settle every open bet on it. Winners are credited instantly.
          </p>
        </div>
        <button onClick={load} className="pill px-3 py-1.5 text-xs bg-white/5 flex items-center gap-1.5">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {err && <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm p-3">{err}</div>}
      {msg && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm p-3 flex gap-2">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" /> {msg}
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center text-sm text-white/50">
          No open cricket bets waiting for a result.
        </div>
      )}

      <div className="space-y-4">
        {groups.map(([key, g]) => {
          const isFancy = g.marketType === "FANCY";
          const sel = choice[key] || "";
          const totalExposure = g.bets.reduce((s, b) => s + Number(b.exposure), 0);
          const confirming = confirmKey === key;
          const pending = confirming ? sel : "";
          return (
            <div key={key} className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-white break-words">{g.eventName}</div>
                  <div className="text-xs text-sky-300 mt-0.5">
                    {g.marketName} <span className="text-white/40">• {g.marketType.replace("_", " ")}</span>
                  </div>
                </div>
                <div className="text-right text-xs text-white/60">
                  <div>{g.bets.length} open bet(s)</div>
                  <div>Exposure: {coins(totalExposure)}</div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-xs text-left">
                  <thead className="bg-white/5 text-[10px] uppercase text-white/50">
                    <tr>
                      <th className="px-3 py-2">Player</th>
                      <th className="px-3 py-2">Selection</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2 text-right">{isFancy ? "Line" : "Odds"}</th>
                      <th className="px-3 py-2 text-right">Stake</th>
                      <th className="px-3 py-2 text-right">Win</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {g.bets.map((b) => {
                      const u = byId.get(b.user_id);
                      return (
                        <tr key={b.id}>
                          <td className="px-3 py-2 whitespace-nowrap">{u ? u.name : b.user_id.slice(0, 8)}</td>
                          <td className="px-3 py-2">{b.runner_name}</td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 rounded text-[10px] font-bold ${b.bet_type === "BACK" ? "bg-blue-600" : "bg-pink-600"}`}>
                              {isFancy ? (b.bet_type === "BACK" ? "YES" : "NO") : b.bet_type}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{isFancy ? b.line : Number(b.odds)}</td>
                          <td className="px-3 py-2 text-right font-mono">{coins(Number(b.stake))}</td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-400">+{coins(Number(b.profit))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {confirming ? (
                <div className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm">
                  <span className="text-amber-200">
                    Settle {g.bets.length} bet(s) with result <strong>{pending}</strong>? This can&apos;t be undone.
                  </span>
                  <div className="flex gap-2 ml-auto">
                    <button
                      disabled={busy === key}
                      onClick={() => settle(key, g, pending)}
                      className="pill px-3 py-1.5 text-xs btn-green disabled:opacity-50"
                    >
                      {busy === key ? "Settling…" : "Confirm"}
                    </button>
                    <button onClick={() => setConfirmKey(null)} className="pill px-3 py-1.5 text-xs bg-white/10">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {isFancy ? (
                    <input
                      type="number"
                      inputMode="numeric"
                      value={sel === "VOID" ? "" : sel}
                      onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}
                      placeholder="Final runs"
                      className="w-36 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm"
                    />
                  ) : (
                    <select
                      value={sel === "VOID" ? "" : sel}
                      onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}
                      className="rounded-xl bg-[#0b102e] border border-white/10 px-3 py-2 text-sm"
                    >
                      <option value="">Select winner…</option>
                      {runnerOptions(g).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  )}
                  <button
                    disabled={!sel || sel === "VOID"}
                    onClick={() => setConfirmKey(key)}
                    className="pill px-3 py-2 text-xs btn-green disabled:opacity-40"
                  >
                    Declare Result
                  </button>
                  <button
                    onClick={() => {
                      setChoice({ ...choice, [key]: "VOID" });
                      setConfirmKey(key);
                    }}
                    className="pill px-3 py-2 text-xs bg-white/10"
                  >
                    Void (refund all)
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {settledRows.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-white/70">Recently settled</h2>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-xs text-left">
              <thead className="bg-white/5 text-[10px] uppercase text-white/50">
                <tr>
                  <th className="px-3 py-2">Match / Market</th>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">Selection</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {settledRows.map((b) => (
                  <tr key={b.id}>
                    <td className="px-3 py-2 min-w-[180px]">
                      <div>{b.event_name}</div>
                      <div className="text-white/40">{b.market_name}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{byId.get(b.user_id)?.name || b.user_id.slice(0, 8)}</td>
                    <td className="px-3 py-2">{b.runner_name} <span className="text-white/40">({b.bet_type})</span></td>
                    <td className="px-3 py-2">{b.result}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-1.5 rounded text-[10px] font-bold ${
                          b.status === "WON" ? "bg-emerald-600" : b.status === "LOST" ? "bg-rose-600" : "bg-white/20"
                        }`}
                      >
                        {b.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{coins(Number(b.payout))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
