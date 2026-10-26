"use client";

import { useEffect, useState } from "react";
import { Globe, TrendingUp } from "lucide-react";
import type { Account } from "../lib/hierarchy";
import { IpAlertCards, readIpSeen, useIpAlerts, writeIpSeen } from "./IpAlerts";
import { WinAlertCards, readWinSeen, useWinAlerts, winStamp, writeWinSeen } from "./WinAlerts";

// The Alerts section of the Admin console: big wins (players at 2× / 3× of their deposit) and same-IP logins, each
// with its own period. Opening the section marks everything loaded so far as seen; the nav badge (AlertsBadge)
// counts what has come in since.

const SEEN_EVENT = "khelobaazi:alerts-seen";

export function AlertsView({ me }: { me: Account }) {
  const [tab, setTab] = useState<"wins" | "ip">("wins");
  const [winDays, setWinDays] = useState(7);
  const [ipDays, setIpDays] = useState(7);
  const wins = useWinAlerts(winDays);
  const ips = useIpAlerts(ipDays);
  // What was seen when this section was opened: cards newer than that are marked "new" until the next visit.
  const [winSeen] = useState(() => readWinSeen(me.id));
  const [ipSeen] = useState(() => readIpSeen(me.id));

  useEffect(() => {
    const latest = (wins.alerts ?? []).map(winStamp).sort().at(-1);
    if (latest && latest > readWinSeen(me.id)) { writeWinSeen(me.id, latest); window.dispatchEvent(new Event(SEEN_EVENT)); }
  }, [wins.alerts, me.id]);
  useEffect(() => {
    const latest = ips.alerts?.[0]?.lastAt;
    if (latest && latest > readIpSeen(me.id)) { writeIpSeen(me.id, latest); window.dispatchEvent(new Event(SEEN_EVENT)); }
  }, [ips.alerts, me.id]);

  const pills = (days: number, set: (d: number) => void, allTime: boolean) => (
    <div className="flex gap-2 flex-wrap">
      {[1, 7, 30, ...(allTime ? [0] : [])].map((d) => (
        <button key={d} onClick={() => set(d)} className={`pill px-3 py-1 text-xs ${days === d ? "btn-green" : "bg-white/5 text-white/70"}`}>
          {d === 1 ? "24 hours" : d === 0 ? "All time" : `${d} days`}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl font-bold">Alerts</h1>
      <p className="text-white/50 mt-1">Players winning far more than they put in, and IDs sharing an internet connection</p>
      <div className="flex gap-2 mt-4">
        <button onClick={() => setTab("wins")} className={`pill px-4 py-1.5 text-sm flex items-center gap-1.5 ${tab === "wins" ? "btn-green" : "bg-white/5 text-white/70"}`}>
          <TrendingUp size={15} /> Big wins{wins.alerts?.length ? ` (${wins.alerts.length})` : ""}
        </button>
        <button onClick={() => setTab("ip")} className={`pill px-4 py-1.5 text-sm flex items-center gap-1.5 ${tab === "ip" ? "btn-green" : "bg-white/5 text-white/70"}`}>
          <Globe size={15} /> Same-IP logins{ips.alerts?.length ? ` (${ips.alerts.length})` : ""}
        </button>
      </div>
      {tab === "wins" ? (
        <div className="card p-5 mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="font-semibold">Big wins</div>
              <div className="text-xs text-white/50">Net winnings (wins + refunds − bets) at 2× of the coins deposited: amber; at 3×: red</div>
            </div>
            {pills(winDays, setWinDays, true)}
          </div>
          <div className="mt-4"><WinAlertCards alerts={wins.alerts} err={wins.err} seen={winSeen} /></div>
        </div>
      ) : (
        <div className="card p-5 mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="font-semibold">Same-IP logins</div>
              <div className="text-xs text-white/50">More than one ID signed in from the same internet connection</div>
            </div>
            {pills(ipDays, setIpDays, false)}
          </div>
          <div className="mt-4"><IpAlertCards alerts={ips.alerts} err={ips.err} seen={ipSeen} /></div>
        </div>
      )}
    </div>
  );
}

/** The red count on the Alerts nav item: wins and shared IPs with activity since the section was last opened. */
export function AlertsBadge({ me }: { me: Account }) {
  const wins = useWinAlerts(7);
  const ips = useIpAlerts(7);
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(SEEN_EVENT, on);
    return () => window.removeEventListener(SEEN_EVENT, on);
  }, []);
  const winSeen = readWinSeen(me.id);
  const ipSeen = readIpSeen(me.id);
  const n = (wins.alerts ?? []).filter((a) => winStamp(a) > winSeen).length + (ips.alerts ?? []).filter((a) => a.lastAt > ipSeen).length;
  if (!n) return null;
  return <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold grid place-items-center">{n > 99 ? "99+" : n}</span>;
}
