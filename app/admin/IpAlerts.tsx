"use client";

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { ROLE_LABEL, type Account, type Role } from "../lib/hierarchy";
import { supabase } from "../lib/supabase";
import type { IpAlert } from "../api/ip-alerts/route";

// Bell in the Admin console: IPs that several accounts signed in from (see /api/ip-alerts). Checks every minute;
// the red count is alerts with activity since this admin last opened the list on this device.

const POLL_MS = 60_000;
const seenKey = (id: string) => `ipAlertsSeen:${id}`;
const readSeen = (id: string) => {
  try {
    return localStorage.getItem(seenKey(id)) ?? "";
  } catch {
    return "";
  }
};

export function IpAlertsBell({ me, className = "" }: { me: Account; className?: string }) {
  const [alerts, setAlerts] = useState<IpAlert[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [seen, setSeen] = useState(() => readSeen(me.id));

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

  const unread = (alerts ?? []).filter((a) => a.lastAt > seen).length;
  const show = () => {
    setOpen(true);
    const latest = alerts?.[0]?.lastAt;
    if (latest && latest > seen) {
      setSeen(latest);
      try {
        localStorage.setItem(seenKey(me.id), latest);
      } catch {
        // private mode: the count just resets next visit
      }
    }
  };
  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <button onClick={show} className={`relative ${className}`} aria-label={`Same-IP alerts${unread ? ` (${unread} new)` : ""}`} title="Same-IP login alerts">
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold grid place-items-center">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={() => setOpen(false)}>
          <div className="card w-full max-w-lg p-5 bg-[#0d1335] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Same-IP logins</div>
                <div className="text-xs text-white/50">More than one ID signed in from the same internet connection</div>
              </div>
              <button onClick={() => setOpen(false)} className="text-white/50 shrink-0" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="flex gap-2 mt-3">
              {[1, 7, 30].map((d) => (
                <button key={d} onClick={() => setDays(d)} className={`pill px-3 py-1 text-xs ${days === d ? "btn-green" : "bg-white/5 text-white/70"}`}>
                  {d === 1 ? "24 hours" : `${d} days`}
                </button>
              ))}
            </div>
            <div className="mt-3 overflow-y-auto space-y-3 -mx-1 px-1">
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
          </div>
        </div>
      )}
    </>
  );
}
