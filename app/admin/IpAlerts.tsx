"use client";

import { useEffect, useState } from "react";
import { ROLE_LABEL, type Role } from "../lib/hierarchy";
import { supabase } from "../lib/supabase";
import type { IpAlert } from "../api/ip-alerts/route";

// Same-IP logins for the Alerts section: IPs that several accounts signed in from (see /api/ip-alerts). Polled
// every minute; "new" means activity since this admin last opened the Alerts section on this device.

export const POLL_MS = 60_000;
const seenKey = (id: string) => `ipAlertsSeen:${id}`;
export const readIpSeen = (id: string) => {
  try {
    return localStorage.getItem(seenKey(id)) ?? "";
  } catch {
    return "";
  }
};
export const writeIpSeen = (id: string, stamp: string) => {
  try {
    localStorage.setItem(seenKey(id), stamp);
  } catch {
    // private mode: the count just resets next visit
  }
};

export function useIpAlerts(days: number) {
  const [alerts, setAlerts] = useState<IpAlert[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase().auth.getSession();
      const r = await fetch(`/api/ip-alerts?days=${days}`, { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (!active) return;
      if (!r?.ok) return setErr(j?.error ?? "Could not load alerts");
      setErr("");
      setAlerts(j.alerts as IpAlert[]);
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

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export function IpAlertCards({ alerts, err, seen }: { alerts: IpAlert[] | null; err: string; seen: string }) {
  return (
    <div className="space-y-3">
      {err && <div className="text-xs text-rose-300">{err}</div>}
      {!err && !alerts && <div className="py-8 text-center text-sm text-white/50">Loading…</div>}
      {alerts?.length === 0 && <div className="py-8 text-center text-sm text-white/50">No IP was shared by two or more IDs in this period.</div>}
      {alerts?.map((a) => (
        <div key={a.ip} className={`rounded-xl border p-3 ${a.lastAt > seen ? "border-rose-500/40 bg-rose-500/5" : "border-white/10 bg-white/[0.03]"}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm text-amber-300 break-all">{a.ip}</span>
            <span className="text-[11px] text-white/50 shrink-0">{a.accounts.length} IDs • {when(a.lastAt)}</span>
          </div>
          <div className="mt-2 divide-y divide-white/5">
            {a.accounts.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                <div className="min-w-0">
                  <div className="font-medium truncate">{u.name} <span className="text-white/40">{u.code}{u.username ? ` • @${u.username}` : ""}</span></div>
                  <div className="text-[11px] text-white/45">{ROLE_LABEL[u.role as Role] ?? u.role}{u.device ? ` • ${u.device}` : ""}</div>
                </div>
                <div className="text-right text-[11px] text-white/50 shrink-0">
                  <div>{when(u.lastAt)}</div>
                  <div>{u.logins} login{u.logins === 1 ? "" : "s"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
