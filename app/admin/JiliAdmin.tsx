"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Search } from "lucide-react";
import { apiFetch, errText, supabase } from "../lib/supabase";
import type { JiliGameInfo } from "../lib/server/jili";

// Admin → JILI Games (Super Admin): which JILI games players see in the app. Switched-off games are saved in
// app_settings 'jili_games' (migration 111); the lobby leaves them out and the server won't open them.

type Row = JiliGameInfo & { hidden: boolean };
const CATS = ["All", "Slots", "Fishing", "Crash", "Mines", "Table & Casino", "Mini games"] as const;

export function JiliAdmin() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<(typeof CATS)[number]>("All");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/jili/games?all=1").then((r) => r.json()).then((j: { games?: Row[]; error?: string }) => {
      if (j.games) setRows(j.games); else setErr(j.error ?? "Could not load JILI games");
    }).catch(() => setErr("Could not load JILI games"));
  }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rows ?? []).filter((g) => (cat === "All" || g.category === cat) && (!n || g.name.toLowerCase().includes(n) || g.uid === n));
  }, [rows, q, cat]);
  const on = (rows ?? []).filter((g) => !g.hidden).length;

  /** Save the switched-off list (and note it in the audit log). */
  const save = async (next: Row[], what: string) => {
    setBusy(true);
    setMsg("");
    const hidden = next.filter((g) => g.hidden).map((g) => g.uid);
    const { error } = await supabase().from("app_settings").update({ value: { hidden } }).eq("key", "jili_games");
    setBusy(false);
    if (error) return setErr(errText(error));
    setRows(next);
    setMsg(`Saved • ${next.length - hidden.length} of ${next.length} games shown`);
    supabase().rpc("write_audit", { p_action: `JILI games • ${what}`, p_before: null, p_after: `${next.length - hidden.length} shown` }).then(() => {}, () => {});
  };
  const toggle = (g: Row) => save((rows ?? []).map((x) => (x.uid === g.uid ? { ...x, hidden: !x.hidden } : x)), `${g.hidden ? "shown" : "hidden"}: ${g.name}`);
  const setAll = (hidden: boolean) => {
    const ids = new Set(shown.map((g) => g.uid));
    save((rows ?? []).map((x) => (ids.has(x.uid) ? { ...x, hidden } : x)), `${hidden ? "hid" : "showed"} ${ids.size} games${cat !== "All" ? ` (${cat})` : ""}${q ? ` matching "${q}"` : ""}`);
  };

  return (
    <div>
      <div className="mb-4">
        <div className="text-xl font-semibold">JILI Games</div>
        <div className="text-sm text-white/55">Choose which JILI games players see in the app. Switched-off games are left out of the lobby and can&apos;t be opened. {rows ? `${on} of ${rows.length} shown.` : ""}</div>
      </div>
      <div className="card p-3 mb-3 space-y-2">
        <label className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2">
          <Search size={15} className="text-white/50" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or id" className="flex-1 bg-transparent outline-none text-sm" />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {CATS.map((c) => (
            <button key={c} onClick={() => setCat(c)} className={`rounded-full px-3 py-1 text-xs font-semibold border ${cat === c ? "bg-amber-400 text-black border-amber-300" : "border-white/15 text-white/70"}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button disabled={busy || !rows} onClick={() => setAll(false)} className="rounded-lg px-3 py-1.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">Show all {shown.length !== rows?.length ? "listed" : ""} ({shown.length})</button>
          <button disabled={busy || !rows} onClick={() => setAll(true)} className="rounded-lg px-3 py-1.5 bg-rose-500/15 border border-rose-500/30 text-rose-300">Hide all {shown.length !== rows?.length ? "listed" : ""} ({shown.length})</button>
          {msg && <span className="text-emerald-300">{msg}</span>}
          {err && <span className="text-rose-300">{err}</span>}
        </div>
      </div>
      {!rows && !err && <div className="text-sm text-white/50 py-8 text-center">Loading…</div>}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
        {shown.map((g) => (
          <button key={g.uid} onClick={() => toggle(g)} disabled={busy} className={`text-left rounded-xl border p-1.5 transition ${g.hidden ? "border-white/10 opacity-45" : "border-emerald-400/50"}`} title={g.hidden ? "Hidden — tap to show" : "Shown — tap to hide"}>
            <div className="relative aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-amber-700 to-[#2a1405] grid place-items-center">
              {g.logo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={g.logo} alt={g.name} loading="lazy" className="w-full h-full object-cover" />
                : <span className="px-2 text-center text-[11px] font-bold text-amber-100">{g.name}</span>}
              <span className={`absolute top-1 right-1 rounded-full p-1 ${g.hidden ? "bg-black/70 text-white/70" : "bg-emerald-500 text-white"}`}>{g.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</span>
            </div>
            <div className="mt-1 text-[11px] font-medium truncate">{g.name}</div>
            <div className="text-[10px] text-white/45">{g.category} • #{g.uid}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
