"use client";

import { useEffect, useState } from "react";
import { TrendingUp, X } from "lucide-react";
import { type Account } from "../lib/hierarchy";
import { inr } from "../lib/data";
import { supabase } from "../lib/supabase";
import type { WinAlert } from "../api/win-alerts/route";

// Second bell in the Admin console: players whose net winnings have reached 2× (amber) or 3× (red) what they
// deposited (see /api/win-alerts). Checks every minute; the count is alerts with a win since this admin last opened
// the list on this device.

const POLL_MS = 60_000;
const seenKey = (id: string) => `winAlertsSeen:${id}`;
const readSeen = (id: string) => {
  try {
    return localStorage.getItem(seenKey(id)) ?? "";
  } catch {
    return "";
  }
};

export function WinAlertsBell({ me, className = "" }: { me: Account; className?: string }) {
  const [alerts, setAlerts] = useState<WinAlert[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [seen, setSeen] = useState(() => readSeen(me.id));

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase().auth.getSession();
      const r = await fetch(`/api/win-alerts?days=${days}`, { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (!active) return;
      if (!r?.ok) return setErr(j?.error ?? "Could not load alerts");
      setErr("");
      setAlerts(j.alerts as WinAlert[]);
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [days]);

  const stamp = (a: WinAlert) => a.lastWinAt ?? "";
  const unread = (alerts ?? []).filter((a) => stamp(a) > seen).length;
  const show = () => {
    setOpen(true);
    const latest = (alerts ?? []).map(stamp).sort().at(-1);
    if (latest && latest > seen) {
      setSeen(latest);
      try {
        localStorage.setItem(seenKey(me.id), latest);
      } catch {
        // private mode: the count just resets next visit
      }
    }
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

  return (
    <>
      <button onClick={show} className={`relative ${className}`} aria-label={`Big win alerts${unread ? ` (${unread} new)` : ""}`} title="Players winning 2× / 3× their deposit">
        <TrendingUp size={18} />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-slate-900 text-[10px] font-bold grid place-items-center">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={() => setOpen(false)}>
          <div className="card w-full max-w-lg p-5 bg-[#0d1335] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Big wins</div>
                <div className="text-xs text-white/50">Players whose net winnings reached 2× or 3× of what they deposited</div>
              </div>
              <button onClick={() => setOpen(false)} className="text-white/50 shrink-0" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="flex gap-2 mt-3">
              {[1, 7, 30, 0].map((d) => (
                <button key={d} onClick={() => setDays(d)} className={`pill px-3 py-1 text-xs ${days === d ? "btn-green" : "bg-white/5 text-white/70"}`}>
                  {d === 1 ? "24 hours" : d === 0 ? "All time" : `${d} days`}
                </button>
              ))}
            </div>
            <div className="mt-3 overflow-y-auto space-y-3 -mx-1 px-1">
              {err && <div className="text-xs text-rose-300">{err}</div>}
              {!err && !alerts && <div className="py-8 text-center text-sm text-white/50">Loading…</div>}
              {alerts?.length === 0 && <div className="py-8 text-center text-sm text-white/50">No player has won 2× their deposit in this period.</div>}
              {alerts?.map((a) => {
                const hot = a.multiple >= 3;
                return (
                  <div key={a.id} className={`rounded-xl border p-3 ${hot ? "border-rose-500/50 bg-rose-500/5" : "border-amber-400/40 bg-amber-400/5"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{a.name} <span className="text-white/40">{a.code}{a.username ? ` • @${a.username}` : ""}</span></div>
                        <div className="text-[11px] text-white/45">Last win {when(a.lastWinAt)}</div>
                      </div>
                      <span className={`pill px-2.5 py-1 text-sm font-bold shrink-0 ${hot ? "bg-rose-500 text-white" : "bg-amber-400 text-slate-900"}`}>{a.multiple.toFixed(1)}×</span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                      <div><div className="text-white/45">Deposited</div><div className="font-semibold">{inr(a.deposits)}</div></div>
                      <div><div className="text-white/45">Net won</div><div className={`font-semibold ${hot ? "text-rose-300" : "text-amber-300"}`}>{inr(a.net)}</div></div>
                      <div><div className="text-white/45">Balance now</div><div className="font-semibold">{inr(a.balance)}</div></div>
                    </div>
                    <div className="mt-1 text-[11px] text-white/40">Bets {inr(a.bets)} • Wins {inr(a.wins)}{a.refunds ? ` • Refunds ${inr(a.refunds)}` : ""}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
