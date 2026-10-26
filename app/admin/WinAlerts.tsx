"use client";

import { useEffect, useState } from "react";
import { inr } from "../lib/data";
import { supabase } from "../lib/supabase";
import type { WinAlert } from "../api/win-alerts/route";
import { POLL_MS, when } from "./IpAlerts";

// Big wins for the Alerts section: players whose net winnings reached 2× (amber) or 3× (red) what they deposited
// (see /api/win-alerts). Polled every minute; "new" means a win since this admin last opened the Alerts section.

const seenKey = (id: string) => `winAlertsSeen:${id}`;
export const readWinSeen = (id: string) => {
  try {
    return localStorage.getItem(seenKey(id)) ?? "";
  } catch {
    return "";
  }
};
export const writeWinSeen = (id: string, stamp: string) => {
  try {
    localStorage.setItem(seenKey(id), stamp);
  } catch {
    // private mode: the count just resets next visit
  }
};
export const winStamp = (a: WinAlert) => a.lastWinAt ?? "";

export function useWinAlerts(days: number) {
  const [alerts, setAlerts] = useState<WinAlert[] | null>(null);
  const [err, setErr] = useState("");
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
  return { alerts, err };
}

export function WinAlertCards({ alerts, err, seen }: { alerts: WinAlert[] | null; err: string; seen: string }) {
  return (
    <div className="space-y-3">
      {err && <div className="text-xs text-rose-300">{err}</div>}
      {!err && !alerts && <div className="py-8 text-center text-sm text-white/50">Loading…</div>}
      {alerts?.length === 0 && <div className="py-8 text-center text-sm text-white/50">No player has won 2× their deposit in this period.</div>}
      {alerts?.map((a) => {
        const hot = a.multiple >= 3;
        const fresh = winStamp(a) > seen;
        return (
          <div key={a.id} className={`rounded-xl border p-3 ${hot ? "border-rose-500/50 bg-rose-500/5" : "border-amber-400/40 bg-amber-400/5"} ${fresh ? "ring-1 ring-white/20" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium truncate">{a.name} <span className="text-white/40">{a.code}{a.username ? ` • @${a.username}` : ""}</span>{fresh && <span className="ml-2 pill px-1.5 py-px text-[10px] bg-white/15">new</span>}</div>
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
  );
}
