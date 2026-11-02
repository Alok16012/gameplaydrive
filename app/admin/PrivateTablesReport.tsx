"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { errText, supabase } from "../lib/supabase";

// Reports → Private Tables (migration 117): the private tables of Rummy 13 / 21 Card, Teen Patti, Poker, Ludo and
// Chess, apart from the ordinary game reports. Three statements on the period picked at the top of Reports:
//   Tables      — every private table made: code, who made it, when, what it plays, players, its commission so far.
//   Transactions — every coin movement at a private table (entries, bets, payouts, refunds), table by table.
//   Commission   — every settled deal / hand / game and the fee kept from it, with game-wise and overall totals.

const GAME_NAME: Record<string, string> = { rummy: "Rummy 13 Cards", rummy21: "Rummy 21 Cards", "teen-patti": "Teen Patti", poker: "Poker", ludo: "Ludo", chess: "Chess" };
const GAME_ORDER = ["rummy", "rummy21", "teen-patti", "poker", "ludo", "chess"];

interface TableRow { game: string; table_id: string; code: string; host_id: string | null; host_name: string | null; host_code: string | null; created_at: string; status: string; stake: number; detail: string; players: number; rounds: number; stake_in: number; paid_out: number; fee: number; last_at: string | null }
interface FeeRow { id: number; game: string; table_id: string; code: string; host_name: string | null; host_code: string | null; round: string; stake_in: number; paid_out: number; fee: number; created_at: string }
interface TxnRow { game: string; code: string; table_id: string; user_id: string; user_name: string | null; user_code: string | null; kind: string; amount: number; note: string; created_at: string }

type View = "tables" | "txns" | "fees";
const VIEWS: { id: View; label: string }[] = [{ id: "tables", label: "Tables" }, { id: "txns", label: "Transaction statement" }, { id: "fees", label: "Commission statement" }];

const n = (v: number) => Number(v).toLocaleString("en-IN");
const pct = (fee: number, stake: number) => (stake > 0 ? `${((100 * fee) / stake).toFixed(1)}%` : "—");

export function PrivateTablesReport({ bounds, reloadKey, exportToCSV, fmtDate }: {
  bounds: { start?: Date; end?: Date };
  reloadKey: number;
  exportToCSV: (filename: string, rows: Record<string, unknown>[]) => void;
  fmtDate: (iso: string) => string;
}) {
  const [view, setView] = useState<View>("tables");
  const [game, setGame] = useState("all");
  const [q, setQ] = useState("");
  const [tables, setTables] = useState<TableRow[] | null>(null);
  const [fees, setFees] = useState<FeeRow[] | null>(null);
  const [txns, setTxns] = useState<TxnRow[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setErr("");
    setTables(null); setFees(null); setTxns(null);
    const args = { p_from: bounds.start?.toISOString() ?? null, p_to: bounds.end?.toISOString() ?? null };
    const sb = supabase();
    Promise.all([sb.rpc("private_tables_report", args), sb.rpc("private_table_fees", args), sb.rpc("private_table_txns", args)]).then(([t, f, x]) => {
      if (!alive) return;
      const e = t.error ?? f.error ?? x.error;
      if (e) return setErr(/private_tables_report|private_table_/.test(errText(e)) ? "Run migration 117 first" : errText(e));
      setTables((t.data ?? []) as TableRow[]);
      setFees((f.data ?? []) as FeeRow[]);
      setTxns((x.data ?? []) as TxnRow[]);
    });
    return () => { alive = false; };
  }, [bounds, reloadKey]);

  const needle = q.trim().toLowerCase();
  const keep = (g: string, code: string, who?: string | null, whoCode?: string | null) =>
    (game === "all" || g === game) && (!needle || code.toLowerCase().includes(needle) || (who ?? "").toLowerCase().includes(needle) || (whoCode ?? "").toLowerCase().includes(needle));
  const shownTables = useMemo(() => (tables ?? []).filter((r) => keep(r.game, r.code, r.host_name, r.host_code)), [tables, game, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownFees = useMemo(() => (fees ?? []).filter((r) => keep(r.game, r.code, r.host_name, r.host_code)), [fees, game, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownTxns = useMemo(() => (txns ?? []).filter((r) => keep(r.game, r.code, r.user_name, r.user_code)), [txns, game, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Commission summary: per game, from every fee row of the period (the game filter narrows the table, not the totals).
  const summary = useMemo(() => {
    const m = new Map<string, { tables: Set<string>; rounds: number; stake_in: number; paid_out: number; fee: number }>();
    for (const r of fees ?? []) {
      const s = m.get(r.game) ?? { tables: new Set(), rounds: 0, stake_in: 0, paid_out: 0, fee: 0 };
      s.tables.add(r.table_id); s.rounds += 1; s.stake_in += Number(r.stake_in); s.paid_out += Number(r.paid_out); s.fee += Number(r.fee);
      m.set(r.game, s);
    }
    const rows = GAME_ORDER.filter((g) => m.has(g)).map((g) => ({ game: g, ...m.get(g)! }));
    const total = rows.reduce((t, r) => ({ tables: t.tables + r.tables.size, rounds: t.rounds + r.rounds, stake_in: t.stake_in + r.stake_in, paid_out: t.paid_out + r.paid_out, fee: t.fee + r.fee }), { tables: 0, rounds: 0, stake_in: 0, paid_out: 0, fee: 0 });
    return { rows, total };
  }, [fees]);
  const tableCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of tables ?? []) m.set(r.game, (m.get(r.game) ?? 0) + 1);
    return m;
  }, [tables]);

  const th = "px-3 py-2.5 font-medium whitespace-nowrap";
  const td = "px-3 py-2.5 whitespace-nowrap";
  const loading = !err && (tables === null || fees === null || txns === null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-white">Private Tables</h3>
          <p className="text-xs text-white/50">Rummy 13 / 21 Cards, Teen Patti, Poker, Ludo and Chess tables made with an invite code — apart from the public games. Rummy figures start from the day this report was added; the other games include earlier tables.</p>
        </div>
        <div className="flex gap-1.5 bg-[#0d1435] p-1 rounded-xl border border-white/10">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${view === v.id ? "bg-sky-500/20 text-sky-300 border border-sky-400/40" : "text-white/60 hover:text-white"}`}>{v.label}</button>
          ))}
        </div>
      </div>

      {/* Tables made per game, and the commission summary — always in view. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-2">
        {GAME_ORDER.map((g) => {
          const s = summary.rows.find((r) => r.game === g);
          return (
            <button key={g} onClick={() => setGame(game === g ? "all" : g)} className={`text-left rounded-xl border p-3 transition ${game === g ? "border-sky-400/50 bg-sky-500/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
              <div className="text-[11px] text-white/55">{GAME_NAME[g]}</div>
              <div className="text-sm font-bold text-white mt-0.5">{tableCounts.get(g) ?? 0} table{(tableCounts.get(g) ?? 0) === 1 ? "" : "s"}</div>
              <div className="text-[11px] text-emerald-300 font-mono mt-0.5">Fee 🪙 {n(s?.fee ?? 0)}</div>
            </button>
          );
        })}
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
          <div className="text-[11px] text-white/55">All private tables</div>
          <div className="text-sm font-bold text-white mt-0.5">{tables?.length ?? 0} tables • {summary.total.rounds} rounds</div>
          <div className="text-[11px] text-emerald-300 font-mono mt-0.5">Fee 🪙 {n(summary.total.fee)} ({pct(summary.total.fee, summary.total.stake_in)})</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={game} onChange={(e) => setGame(e.target.value)} className="bg-[#0d1435] border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none">
          <option value="all">All games</option>
          {GAME_ORDER.map((g) => <option key={g} value={g}>{GAME_NAME[g]}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Table code, player name or ID" className="flex-1 min-w-[200px] bg-[#0d1435] border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none" />
        <button
          onClick={() => {
            if (view === "tables") exportToCSV("private_tables", shownTables.map((r) => ({ Game: GAME_NAME[r.game], "Table code": r.code, "Table id": r.table_id, "Created by": r.host_name ?? "", "Creator ID": r.host_code ?? "", "Created at": fmtDate(r.created_at), Table: r.detail, Status: r.status, Players: r.players, Rounds: r.rounds, "Coins in": r.stake_in, "Paid out": r.paid_out, Commission: r.fee })));
            else if (view === "txns") exportToCSV("private_table_transactions", shownTxns.map((r) => ({ When: fmtDate(r.created_at), Game: GAME_NAME[r.game], "Table code": r.code, Player: r.user_name ?? "", "Player ID": r.user_code ?? "", Type: r.kind, Amount: r.amount, Note: r.note })));
            else exportToCSV("private_table_commission", shownFees.map((r) => ({ When: fmtDate(r.created_at), Game: GAME_NAME[r.game], "Table code": r.code, "Created by": r.host_name ?? "", "Creator ID": r.host_code ?? "", Round: r.round, "Coins in": r.stake_in, "Paid out": r.paid_out, Commission: r.fee, "Fee %": pct(r.fee, r.stake_in) })));
          }}
          className="px-3 py-2 rounded-xl text-xs font-semibold bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 flex items-center gap-1.5"
        >
          <Download size={13} /> CSV
        </button>
      </div>

      {err && <div className="text-xs text-rose-300">{err}</div>}
      {loading && <div className="py-10 text-center text-white/40 text-sm">Loading…</div>}

      {!loading && view === "tables" && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-xs text-left">
            <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
              <tr><th className={th}>Game</th><th className={th}>Table code</th><th className={th}>Created by</th><th className={th}>Created at</th><th className={th}>Table</th><th className={th}>Status</th><th className={`${th} text-right`}>Players</th><th className={`${th} text-right`}>Rounds</th><th className={`${th} text-right`}>Coins in</th><th className={`${th} text-right`}>Paid out</th><th className={`${th} text-right`}>Commission</th><th className={th}>Last played</th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {shownTables.map((r) => (
                <tr key={r.table_id} className="hover:bg-white/[0.02]">
                  <td className={`${td} font-semibold text-white`}>{GAME_NAME[r.game]}</td>
                  <td className={`${td} font-mono text-sky-300`}>{r.code}</td>
                  <td className={td}>{r.host_name ?? "—"}{r.host_code ? <span className="text-white/40"> • {r.host_code}</span> : null}</td>
                  <td className={`${td} text-white/70`}>{fmtDate(r.created_at)}</td>
                  <td className={`${td} text-white/70`}>{r.detail}</td>
                  <td className={td}><span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.status === "playing" ? "bg-emerald-500/15 text-emerald-300" : r.status === "done" ? "bg-white/10 text-white/60" : r.status === "cancelled" ? "bg-rose-500/15 text-rose-300" : "bg-amber-500/15 text-amber-300"}`}>{r.status}</span></td>
                  <td className={`${td} text-right font-mono`}>{r.players}</td>
                  <td className={`${td} text-right font-mono`}>{r.rounds}</td>
                  <td className={`${td} text-right font-mono text-amber-300`}>{n(r.stake_in)}</td>
                  <td className={`${td} text-right font-mono text-sky-300`}>{n(r.paid_out)}</td>
                  <td className={`${td} text-right font-mono font-bold text-emerald-400`}>{n(r.fee)}</td>
                  <td className={`${td} text-white/50`}>{r.last_at ? fmtDate(r.last_at) : "—"}</td>
                </tr>
              ))}
              {shownTables.length === 0 && <tr><td colSpan={12} className="px-4 py-10 text-center text-white/40">No private tables in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {!loading && view === "txns" && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-xs text-left">
            <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
              <tr><th className={th}>When</th><th className={th}>Game</th><th className={th}>Table code</th><th className={th}>Player</th><th className={th}>Type</th><th className={`${th} text-right`}>Amount</th><th className={th}>Note</th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {shownTxns.map((r, i) => (
                <tr key={i} className="hover:bg-white/[0.02]">
                  <td className={`${td} text-white/70`}>{fmtDate(r.created_at)}</td>
                  <td className={`${td} font-semibold text-white`}>{GAME_NAME[r.game]}</td>
                  <td className={`${td} font-mono text-sky-300`}>{r.code}</td>
                  <td className={td}>{r.user_name ?? "—"}{r.user_code ? <span className="text-white/40"> • {r.user_code}</span> : null}</td>
                  <td className={`${td} capitalize text-white/70`}>{r.kind}</td>
                  <td className={`${td} text-right font-mono font-bold ${Number(r.amount) < 0 ? "text-rose-400" : "text-emerald-400"}`}>{Number(r.amount) < 0 ? "−" : "+"}{n(Math.abs(Number(r.amount)))}</td>
                  <td className={`${td} text-white/60 max-w-[360px] truncate`} title={r.note}>{r.note}</td>
                </tr>
              ))}
              {shownTxns.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-white/40">No private-table transactions in this period.</td></tr>}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[11px] text-white/40 border-t border-white/10">
            In: 🪙 {n(shownTxns.reduce((t, r) => t + (Number(r.amount) < 0 ? -Number(r.amount) : 0), 0))} • Out: 🪙 {n(shownTxns.reduce((t, r) => t + (Number(r.amount) > 0 ? Number(r.amount) : 0), 0))} • {shownTxns.length} lines
          </div>
        </div>
      )}

      {!loading && view === "fees" && (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-xl border border-emerald-400/20">
            <table className="w-full text-xs text-left">
              <thead className="bg-emerald-500/10 text-[11px] text-white/60 uppercase border-b border-white/10">
                <tr><th className={th}>Commission summary</th><th className={`${th} text-right`}>Tables</th><th className={`${th} text-right`}>Rounds</th><th className={`${th} text-right`}>Coins in</th><th className={`${th} text-right`}>Paid out</th><th className={`${th} text-right`}>Commission</th><th className={`${th} text-right`}>Fee %</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {summary.rows.map((r) => (
                  <tr key={r.game}>
                    <td className={`${td} font-semibold text-white`}>{GAME_NAME[r.game]}</td>
                    <td className={`${td} text-right font-mono`}>{r.tables.size}</td>
                    <td className={`${td} text-right font-mono`}>{r.rounds}</td>
                    <td className={`${td} text-right font-mono text-amber-300`}>{n(r.stake_in)}</td>
                    <td className={`${td} text-right font-mono text-sky-300`}>{n(r.paid_out)}</td>
                    <td className={`${td} text-right font-mono font-bold text-emerald-400`}>{n(r.fee)}</td>
                    <td className={`${td} text-right font-mono text-white/70`}>{pct(r.fee, r.stake_in)}</td>
                  </tr>
                ))}
                <tr className="bg-white/5 font-bold">
                  <td className={`${td} text-white`}>Total</td>
                  <td className={`${td} text-right font-mono`}>{summary.total.tables}</td>
                  <td className={`${td} text-right font-mono`}>{summary.total.rounds}</td>
                  <td className={`${td} text-right font-mono text-amber-300`}>{n(summary.total.stake_in)}</td>
                  <td className={`${td} text-right font-mono text-sky-300`}>{n(summary.total.paid_out)}</td>
                  <td className={`${td} text-right font-mono text-emerald-400`}>{n(summary.total.fee)}</td>
                  <td className={`${td} text-right font-mono text-white/70`}>{pct(summary.total.fee, summary.total.stake_in)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-xs text-left">
              <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                <tr><th className={th}>When</th><th className={th}>Game</th><th className={th}>Table code</th><th className={th}>Created by</th><th className={th}>Round</th><th className={`${th} text-right`}>Coins in</th><th className={`${th} text-right`}>Paid out</th><th className={`${th} text-right`}>Commission</th><th className={`${th} text-right`}>Fee %</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {shownFees.map((r) => (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
                    <td className={`${td} text-white/70`}>{fmtDate(r.created_at)}</td>
                    <td className={`${td} font-semibold text-white`}>{GAME_NAME[r.game]}</td>
                    <td className={`${td} font-mono text-sky-300`}>{r.code}</td>
                    <td className={td}>{r.host_name ?? "—"}{r.host_code ? <span className="text-white/40"> • {r.host_code}</span> : null}</td>
                    <td className={`${td} text-white/70`}>{r.round}</td>
                    <td className={`${td} text-right font-mono text-amber-300`}>{n(r.stake_in)}</td>
                    <td className={`${td} text-right font-mono text-sky-300`}>{n(r.paid_out)}</td>
                    <td className={`${td} text-right font-mono font-bold text-emerald-400`}>{n(r.fee)}</td>
                    <td className={`${td} text-right font-mono text-white/70`}>{pct(r.fee, r.stake_in)}</td>
                  </tr>
                ))}
                {shownFees.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-white/40">No settled private-table rounds in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
