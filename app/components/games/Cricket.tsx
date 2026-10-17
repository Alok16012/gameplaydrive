"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Clock, Radio, RefreshCw, Search, Wallet as WalletIcon, X } from "lucide-react";
import type { Nav } from "../nav";
import { Header, Money } from "../ui";
import { useStore } from "../../lib/store";
import { inr } from "../../lib/data";
import { sfx } from "../../lib/sound";
import { errText } from "../../lib/supabase";
import {
  fetchCricketMatches,
  fetchCricketOdds,
  fetchMyBets,
  placeSportBet,
  type CricketBet,
  type CricketMatch,
  type CricketOddsResponse,
  type Price,
} from "../../lib/cricketApi";

// Cricket exchange: Match Winner (Back / Lay) on every match The Odds API lists. All prices come from the API through
// the server (app/lib/server/oddsApi.ts), which refreshes them every few minutes; nothing here invents a price.

interface BetSlipState {
  runnerName: string;
  betType: "BACK" | "LAY";
  odds: number;
}

const QUICK_STAKES = [100, 500, 1000, 2000, 5000, 10000, 25000, 50000];
const MIN_STAKE = 100;
const MAX_STAKE = 500000;
const MARKET = "Match Odds";

const ago = (ms: number | null, now: number) => {
  if (!ms) return "";
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

export function Cricket({ nav, matchId }: { nav: Nav; matchId?: string }) {
  const { total, showToast, applyBalance, refresh } = useStore();
  const [placing, setPlacing] = useState(false);
  const [matches, setMatches] = useState<CricketMatch[]>([]);
  const [listInfo, setListInfo] = useState<{ updatedAt: number | null; message?: string }>({ updatedAt: null });
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(matchId || null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTabFilter, setActiveTabFilter] = useState<"all" | "inplay" | "upcoming">("all");
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [showMyBets, setShowMyBets] = useState(false);
  const [myBets, setMyBets] = useState<CricketBet[]>([]);
  const [showAllBets, setShowAllBets] = useState(false);
  const [betsFilter, setBetsFilter] = useState<"OPEN" | "SETTLED">("OPEN");
  const openBets = myBets.filter((b) => b.status === "OPEN");
  const [oddsData, setOddsData] = useState<CricketOddsResponse | null>(null);
  const [betSlip, setBetSlip] = useState<BetSlipState | null>(null);
  const [stake, setStake] = useState(0);

  useEffect(() => {
    if (matchId !== undefined) setSelectedMatchId(matchId || null);
  }, [matchId]);

  // "Odds updated … ago" stays current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // The server refreshes odds from the API every few minutes, so a 60 s poll is plenty.
  const loadMatches = async () => {
    setLoading(true);
    const r = await fetchCricketMatches();
    setMatches(r.matches);
    setListInfo({ updatedAt: r.updatedAt, message: r.message });
    setLoading(false);
  };
  useEffect(() => {
    loadMatches();
    const t = setInterval(loadMatches, 60000);
    return () => clearInterval(t);
  }, []);

  // Bets are settled by the admin on the server, so poll for status changes.
  const reloadBets = () => fetchMyBets().then(setMyBets).catch(() => {});
  useEffect(() => {
    reloadBets();
    const t = setInterval(reloadBets, 30000);
    return () => clearInterval(t);
  }, []);
  const settledSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const settled = myBets.filter((b) => b.status !== "OPEN");
    if (settledSeen.current) {
      const fresh = settled.filter((b) => !settledSeen.current!.has(b.id));
      if (fresh.length > 0) {
        const won = fresh.reduce((s, b) => s + (b.payout || 0), 0);
        showToast(won > 0 ? `${fresh.length} bet(s) settled • ${inr(won)} credited` : `${fresh.length} bet(s) settled`);
        refresh();
      }
    }
    settledSeen.current = new Set(settled.map((b) => b.id));
  }, [myBets]);

  const activeMatch = useMemo(() => matches.find((m) => m.eventId === selectedMatchId), [matches, selectedMatchId]);

  // Odds of the open match, every 30 s.
  useEffect(() => {
    setOddsData(null);
    if (!activeMatch) return;
    let alive = true;
    const load = () => fetchCricketOdds(activeMatch.eventId).then((r) => alive && setOddsData(r));
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [activeMatch?.eventId]);

  const filteredMatches = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return matches.filter((m) => {
      if (activeTabFilter === "inplay" && !m.inPlay) return false;
      if (activeTabFilter === "upcoming" && m.inPlay) return false;
      return !q || [m.eventName, m.seriesName, m.team1.name, m.team2.name].some((x) => x.toLowerCase().includes(q));
    });
  }, [matches, searchQuery, activeTabFilter]);

  const openBet = (runnerName: string, betType: "BACK" | "LAY", odds: Price, eventId?: string) => {
    if (odds === "-" || !(odds > 1)) return;
    sfx.click();
    if (eventId) setSelectedMatchId(eventId);
    setBetSlip({ runnerName, betType, odds });
    setStake(0);
  };

  // Place a bet — at the latest price: if the odds moved or the market closed since they were shown, say so instead.
  const handlePlaceBet = async () => {
    if (!betSlip || !activeMatch || placing) return;
    if (stake < MIN_STAKE) return showToast(`Minimum bet is ${inr(MIN_STAKE)}`);
    if (stake > MAX_STAKE) return showToast(`Maximum bet is ${inr(MAX_STAKE)}`);
    const exposure = betSlip.betType === "LAY" ? Math.round(stake * (betSlip.odds - 1)) : stake;
    if (total < exposure) return showToast("Insufficient coins for this bet exposure!");

    setPlacing(true);
    try {
      const latest = await fetchCricketOdds(activeMatch.eventId);
      setOddsData(latest);
      const runner = latest.matchOdds?.oddDatas.find((r) => r.rname === betSlip.runnerName);
      if (!runner || runner.status !== "ACTIVE" || latest.matchOdds?.status !== "ACTIVE") {
        setBetSlip(null);
        return showToast("This market is suspended right now");
      }
      const odds = Number(betSlip.betType === "BACK" ? runner.b1 : runner.l1);
      if (odds !== betSlip.odds) {
        setBetSlip({ ...betSlip, odds });
        return showToast(`Odds changed to ${odds.toFixed(2)} — check and place again`);
      }
      const res = await placeSportBet({
        sport: "cricket",
        eventId: activeMatch.eventId,
        eventName: activeMatch.eventName,
        marketType: "MATCH_ODDS",
        marketName: MARKET,
        runnerName: betSlip.runnerName,
        betType: betSlip.betType,
        odds,
        stake,
      });
      applyBalance(res.balance);
      await reloadBets();
      sfx.win();
      showToast(`Bet Placed on ${betSlip.runnerName}! ⚡`);
      setBetSlip(null);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setPlacing(false);
    }
  };

  const betSlipSheet = betSlip && (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end justify-center p-0 md:p-4 fadein">
      <div
        className={`w-full max-w-md rounded-t-3xl md:rounded-3xl p-4 border shadow-2xl transition-all ${
          betSlip.betType === "BACK" ? "bg-[#0b1c3d] border-blue-500/50" : "bg-[#2d0e23] border-pink-500/50"
        }`}
      >
        <div className="flex items-start justify-between pb-2.5 border-b border-white/10">
          <div>
            <span
              className={`inline-block px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider mb-1 ${
                betSlip.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"
              }`}
            >
              {betSlip.betType} • {MARKET}
            </span>
            <div className="font-extrabold text-sm text-white">{betSlip.runnerName}</div>
          </div>
          <button onClick={() => setBetSlip(null)} className="w-7 h-7 rounded-full bg-white/10 grid place-items-center text-white/70 hover:text-white">
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2.5 my-3">
          <div className="bg-black/50 rounded-xl p-2.5 border border-white/10">
            <div className="text-[10px] text-white/60 font-bold uppercase">ODDS RATE</div>
            <div className="text-xl font-black text-white mt-0.5">{betSlip.odds.toFixed(2)}</div>
          </div>
          <div className="bg-black/50 rounded-xl p-2.5 border border-white/10 relative">
            <div className="text-[10px] text-white/60 font-bold uppercase">STAKE COINS</div>
            <div className="text-xl font-black text-emerald-400 mt-0.5">{inr(stake)}</div>
            {stake > 0 && (
              <button
                onClick={() => { sfx.click(); setStake(0); }}
                className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-white/10 hover:bg-rose-500/30 text-white/60 hover:text-rose-300 text-[10px] font-bold flex items-center justify-center transition"
                title="Clear stake"
              >✕</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5 mb-3">
          {QUICK_STAKES.map((amt) => (
            <button
              key={amt}
              onClick={() => { sfx.click(); setStake((prev) => prev + amt); }}
              className="py-1.5 rounded-lg text-xs font-bold transition-all bg-white/10 text-white/80 hover:bg-white/20 active:bg-white active:text-slate-950 active:scale-95"
            >
              +{amt >= 1000 ? `${amt / 1000}K` : amt}
            </button>
          ))}
        </div>

        <div className="bg-black/40 rounded-xl p-2.5 border border-white/5 space-y-1 text-xs mb-3">
          <div className="flex items-center justify-between text-white/70">
            <span>Potential Win:</span>
            <strong className="text-emerald-400 text-xs">+{inr(betSlip.betType === "BACK" ? Math.round(stake * (betSlip.odds - 1)) : stake)}</strong>
          </div>
          <div className="flex items-center justify-between text-white/70">
            <span>Account Liability:</span>
            <strong className="text-rose-400 text-xs">-{inr(betSlip.betType === "LAY" ? Math.round(stake * (betSlip.odds - 1)) : stake)}</strong>
          </div>
        </div>

        <button
          onClick={handlePlaceBet}
          disabled={placing}
          className={`w-full py-3.5 rounded-xl font-black text-sm uppercase tracking-wider text-white shadow-xl active:scale-95 transition-all disabled:opacity-60 ${
            betSlip.betType === "BACK" ? "bg-gradient-to-r from-blue-600 to-indigo-600 shadow-blue-600/40" : "bg-gradient-to-r from-pink-600 to-rose-600 shadow-pink-600/40"
          }`}
        >
          {placing ? "Placing…" : `Place Bet (${inr(stake)})`}
        </button>
      </div>
    </div>
  );

  // -------------------------------------------------------------
  // Match view
  // -------------------------------------------------------------
  if (selectedMatchId && activeMatch) {
    const matchBets = myBets.filter((b) => b.eventId === selectedMatchId && b.status === "OPEN");
    const market = oddsData?.matchOdds ?? null;

    return (
      <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
        {/* Sticky Header */}
        <div className="sticky top-0 z-30 bg-[#0c122c]/95 backdrop-blur-md border-b border-white/10 px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => setSelectedMatchId(null)}
              className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 grid place-items-center active:scale-95 transition-transform"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider truncate">{activeMatch.seriesName}</div>
              <div className="text-xs font-extrabold truncate">{activeMatch.eventName}</div>
            </div>
          </div>
          <div className="px-2.5 py-1 rounded-xl bg-emerald-950/80 border border-emerald-500/40 text-xs font-bold text-emerald-300 flex items-center gap-1.5">
            <WalletIcon size={12} />
            <Money n={total} />
          </div>
        </div>

        {/* Action Bar */}
        <div className="px-3 py-1.5 bg-[#0a0f24] border-b border-white/5 flex items-center justify-between gap-2">
          <div className="text-[10px] text-white/45 font-semibold">{oddsData?.updatedAt ? `Odds updated ${ago(oddsData.updatedAt, now)}` : ""}</div>
          <button
            onClick={() => setShowMyBets(!showMyBets)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 transition-all ${
              showMyBets ? "bg-blue-600 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            📜 Bets {matchBets.length > 0 && `(${matchBets.length})`}
          </button>
        </div>

        {/* Match Header Card */}
        <div className="p-3">
          <div
            className="rounded-2xl p-3.5 border border-emerald-500/20 relative overflow-hidden shadow-lg"
            style={{ background: "linear-gradient(135deg, #064e3b 0%, #022c22 60%, #081229 100%)" }}
          >
            <div className="flex items-center justify-between mb-2">
              {activeMatch.inPlay ? (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-600 text-[10px] font-black uppercase tracking-wider text-white animate-pulse">
                  <Radio size={10} /> Live In-Play
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-slate-300">Upcoming</span>
              )}
              <div className="text-[11px] text-white/70 flex items-center gap-1">
                <Clock size={11} />
                {new Date(activeMatch.eventTime).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 my-1 items-center">
              <div className="bg-black/40 rounded-xl p-3 border border-white/5 text-sm text-white font-bold truncate text-center">{activeMatch.team1.name}</div>
              <div className="bg-black/40 rounded-xl p-3 border border-white/5 text-sm text-white font-bold truncate text-center">{activeMatch.team2.name}</div>
            </div>
          </div>
        </div>

        {/* My Bets on this match */}
        {showMyBets && (
          <div className="px-3 mb-3 fadein">
            <div className="rounded-2xl p-3 bg-[#0f172a] border border-blue-500/30 shadow-xl space-y-2">
              <div className="flex items-center justify-between border-b border-white/10 pb-1.5">
                <div className="font-bold text-xs text-blue-300">Open Bets on this Match ({matchBets.length})</div>
                <button onClick={() => setShowMyBets(false)} className="text-white/60 hover:text-white"><X size={14} /></button>
              </div>
              {matchBets.length === 0 ? (
                <div className="text-center py-3 text-xs text-white/50">No bets placed yet on this match.</div>
              ) : (
                matchBets.map((b) => (
                  <div key={b.id} className="rounded-xl p-2 bg-black/40 border border-white/5 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className={`px-1.5 rounded text-[10px] font-black ${b.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"}`}>
                        {b.betType} • {b.marketName}
                      </span>
                      <span className="text-white/50 text-[10px]">{b.placedAt}</span>
                    </div>
                    <div className="font-bold text-white text-xs">{b.runnerName}</div>
                    <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[11px]">
                      <span>Stake: <strong>{inr(b.stake)}</strong></span>
                      <span>Odds: <strong>{b.odds.toFixed(2)}</strong></span>
                      <span className="text-emerald-400 font-bold">Win: +{inr(b.profit)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Match Odds */}
        <div className="px-3">
          <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
            <div className="px-3 py-2 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="font-extrabold text-xs text-white">MATCH ODDS</span>
              </div>
              <span className="text-[10px] text-white/50 font-bold">Max: 🪙 5,00,000</span>
            </div>

            <div className="grid grid-cols-12 px-2 py-1 bg-black/50 text-[10px] font-extrabold text-white/70 border-b border-white/5 text-center">
              <div className="col-span-6 text-left pl-1">SELECTION</div>
              <div className="col-span-3 text-[#72bbef] bg-blue-950/50 rounded py-0.5">BACK (Lagai)</div>
              <div className="col-span-3 text-[#faa9ba] bg-pink-950/50 rounded py-0.5">LAY (Khai)</div>
            </div>

            <div className="divide-y divide-white/5">
              {!market ? (
                <div className="py-5 text-center text-[11px] font-bold text-white/45">{oddsData ? oddsData.message ?? "Odds not available for this match" : "Loading odds…"}</div>
              ) : (
                market.oddDatas.map((runner) => {
                  const off = market.status !== "ACTIVE" || runner.status !== "ACTIVE";
                  return (
                    <div key={runner.sid} className="grid grid-cols-12 items-center p-2 gap-1.5 hover:bg-white/[0.02]">
                      <div className="col-span-6 font-bold text-xs pl-1 truncate text-white">{runner.rname}</div>
                      {off ? (
                        <div className="col-span-6 py-1.5 rounded-lg bg-white/5 text-white/40 font-black text-[10px] flex items-center justify-center tracking-widest uppercase shadow-inner">
                          SUSPENDED
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => openBet(runner.rname, "BACK", Number(runner.b1))}
                            className="col-span-3 py-2.5 rounded-lg bg-[#72bbef] hover:bg-blue-300 text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform shadow-sm"
                          >
                            {Number(runner.b1).toFixed(2)}
                          </button>
                          <button
                            onClick={() => openBet(runner.rname, "LAY", Number(runner.l1))}
                            className="col-span-3 py-2.5 rounded-lg bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform shadow-sm"
                          >
                            {Number(runner.l1).toFixed(2)}
                          </button>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {market?.status === "SUSPENDED" && (
            <div className="mt-2 text-center text-[10px] text-white/45">Live odds are refreshed every few minutes; betting reopens with the next update.</div>
          )}
        </div>

        {betSlipSheet}
      </div>
    );
  }

  // -------------------------------------------------------------
  // Lobby: 1 | X | 2 match table
  // -------------------------------------------------------------
  const cell = (p: Price | undefined, back: boolean, runner: string, eventId: string, edge = false) => (
    <td className={`p-[1px] text-center w-[55px] ${edge ? "border-l border-white" : ""}`}>
      {p !== undefined && p !== "-" ? (
        <button
          onClick={() => openBet(runner, back ? "BACK" : "LAY", p, eventId)}
          className={`w-full h-8 text-slate-900 font-bold text-xs flex items-center justify-center transition-colors ${
            back ? "bg-[#93c5fd] hover:bg-blue-300 active:bg-blue-400" : "bg-[#fca5a5] hover:bg-red-300 active:bg-red-400"
          }`}
        >
          {p.toFixed(2)}
        </button>
      ) : (
        <div className="w-full h-8 bg-white flex items-center justify-center text-slate-300 font-bold text-sm">-</div>
      )}
    </td>
  );

  return (
    <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
      <Header
        title="Cricket Exchange"
        onBack={() => nav.reset({ name: "home" })}
        right={
          <button
            onClick={loadMatches}
            className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 grid place-items-center active:scale-95 transition-transform"
            aria-label="Refresh matches"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        }
      />

      {/* Live matches ticker */}
      {matches.some((m) => m.inPlay) && (
        <div className="px-3 py-1.5 bg-[#0a0f24] border-b border-white/10 overflow-x-auto no-scrollbar flex items-center gap-2">
          {matches.filter((m) => m.inPlay).map((m) => (
            <button
              key={m.eventId}
              onClick={() => setSelectedMatchId(m.eventId)}
              className="px-2.5 py-1 rounded-full bg-[#1e293b] border border-white/10 hover:border-emerald-500/50 flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap active:scale-95 transition-all shrink-0 shadow-sm"
            >
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              <span className="text-white/90 truncate max-w-[170px]">{m.eventName}</span>
            </button>
          ))}
        </div>
      )}

      {/* Title bar + My Bets */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-white/10 bg-[#0c122c]">
        <div className="text-xs font-extrabold text-emerald-300 flex items-center gap-1.5">
          🏏 Cricket
          {listInfo.updatedAt ? <span className="text-[10px] text-white/45 font-semibold">• odds {ago(listInfo.updatedAt, now)}</span> : null}
        </div>
        <button
          onClick={() => {
            sfx.click();
            reloadBets();
            setShowAllBets(!showAllBets);
          }}
          className={`px-3 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-all shrink-0 ${
            showAllBets ? "bg-blue-600 text-white" : "bg-white/5 text-white/80 border border-white/10 hover:bg-white/10"
          }`}
        >
          📜 My Bets {openBets.length > 0 && `(${openBets.length})`}
        </button>
      </div>

      {/* All bets across every match */}
      {showAllBets && (
        <div className="px-3 py-3 bg-[#0b1029] border-b border-white/10 fadein">
          <div className="flex items-center gap-1.5 mb-2">
            {(["OPEN", "SETTLED"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setBetsFilter(f)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition-all ${
                  betsFilter === f ? "bg-white/15 text-white" : "text-white/50 hover:text-white"
                }`}
              >
                {f === "OPEN" ? `Current Bets (${openBets.length})` : `Settled (${myBets.length - openBets.length})`}
              </button>
            ))}
            <button onClick={() => setShowAllBets(false)} className="ml-auto text-white/60 hover:text-white">
              <X size={16} />
            </button>
          </div>
          {(() => {
            const list = myBets.filter((b) => (betsFilter === "OPEN" ? b.status === "OPEN" : b.status !== "OPEN"));
            if (list.length === 0) {
              return <div className="text-center py-6 text-xs text-white/50">{betsFilter === "OPEN" ? "No active bets right now." : "No settled bets yet."}</div>;
            }
            return (
              <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                {list.map((b) => (
                  <div key={b.id} className="rounded-xl p-2.5 bg-black/40 border border-white/5 space-y-1 text-xs">
                    <button
                      onClick={() => {
                        setShowAllBets(false);
                        setSelectedMatchId(b.eventId);
                      }}
                      className="text-[11px] font-semibold text-sky-300 text-left hover:underline"
                    >
                      {b.eventName}
                    </button>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`px-1.5 rounded text-[10px] font-black ${b.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"}`}>
                        {b.betType} • {b.marketName}
                      </span>
                      <span
                        className={`px-1.5 rounded text-[10px] font-black ${
                          b.status === "WON" ? "bg-emerald-600 text-white" : b.status === "LOST" ? "bg-rose-600 text-white" : b.status === "VOID" ? "bg-white/20 text-white" : "bg-amber-500 text-black"
                        }`}
                      >
                        {b.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white">{b.runnerName}</span>
                      <span className="text-white/50 text-[10px]">{b.placedAt}</span>
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[11px]">
                      <span>Stake: <strong>{inr(b.stake)}</strong></span>
                      <span>Odds: <strong>{b.odds.toFixed(2)}</strong></span>
                      {b.status === "OPEN" ? (
                        <span className="text-emerald-400 font-bold">Win: +{inr(b.profit)}</span>
                      ) : (
                        <span className={`font-bold ${b.payout ? "text-emerald-400" : "text-rose-400"}`}>Paid: {inr(b.payout || 0)}</span>
                      )}
                    </div>
                    {b.result && <div className="text-[10px] text-white/50">Result: {b.result}</div>}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* In-play / upcoming filter */}
      <div className="px-3 py-2 bg-[#0b1029] flex items-center gap-1.5 border-b border-white/5">
        <button
          onClick={() => setActiveTabFilter("all")}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition-all ${activeTabFilter === "all" ? "bg-white/15 text-white" : "text-white/50 hover:text-white"}`}
        >
          All ({matches.length})
        </button>
        <button
          onClick={() => setActiveTabFilter("inplay")}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold flex items-center gap-1 transition-all ${
            activeTabFilter === "inplay" ? "bg-rose-600 text-white shadow-sm" : "text-white/50 hover:text-white"
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          In-Play ({matches.filter((m) => m.inPlay).length})
        </button>
        <button
          onClick={() => setActiveTabFilter("upcoming")}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition-all ${activeTabFilter === "upcoming" ? "bg-white/15 text-white" : "text-white/50 hover:text-white"}`}
        >
          Upcoming ({matches.filter((m) => !m.inPlay).length})
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 bg-[#0b1029]">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search cricket match or series..."
            className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-white/40 focus:outline-none focus:border-emerald-400"
          />
        </div>
      </div>

      {/* Matches table */}
      <div className="overflow-x-auto bg-white min-h-[500px]">
        <table className="w-full text-left border-collapse text-[11px] text-slate-900 font-semibold">
          <thead>
            <tr className="border-b-2 border-gray-200/60 bg-white">
              <th className="py-2 px-3 font-bold text-slate-800">Game</th>
              <th colSpan={2} className="py-2 px-1 text-center font-bold text-slate-800 w-[110px]">1</th>
              <th colSpan={2} className="py-2 px-1 text-center font-bold text-slate-800 w-[110px]">X</th>
              <th colSpan={2} className="py-2 px-1 text-center font-bold text-slate-800 w-[110px]">2</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {loading && matches.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-slate-500 text-xs font-medium">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <RefreshCw size={18} className="animate-spin text-blue-500" />
                    <span>Loading cricket matches...</span>
                  </div>
                </td>
              </tr>
            ) : filteredMatches.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-10 text-slate-500 text-xs font-medium">
                  {matches.length === 0 && listInfo.message ? listInfo.message : `No ${activeTabFilter !== "all" ? activeTabFilter : ""} cricket matches right now.`}
                </td>
              </tr>
            ) : (
              filteredMatches.map((match) => (
                <tr key={match.eventId} className="hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 px-3 align-middle max-w-[150px] md:max-w-[280px]">
                    <div onClick={() => setSelectedMatchId(match.eventId)} className="cursor-pointer group flex items-center gap-1.5 min-w-0">
                      {match.inPlay && <span className="w-2 h-2 rounded-full bg-[#22c55e] shrink-0" title="In-Play Live" />}
                      <div className="font-semibold text-slate-800 text-[11px] group-hover:text-blue-600 transition-colors truncate">
                        {match.eventName}{" "}
                        <span className="text-slate-500 font-normal">
                          / {new Date(match.eventTime).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} • {match.seriesName}
                        </span>
                      </div>
                    </div>
                  </td>
                  {cell(match.back1, true, match.team1.name, match.eventId)}
                  {cell(match.lay1, false, match.team1.name, match.eventId)}
                  {cell(match.drawBack, true, "The Draw", match.eventId, true)}
                  {cell(match.drawLay, false, "The Draw", match.eventId)}
                  {cell(match.back2, true, match.team2.name, match.eventId, true)}
                  {cell(match.lay2, false, match.team2.name, match.eventId)}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {betSlipSheet}
    </div>
  );
}
