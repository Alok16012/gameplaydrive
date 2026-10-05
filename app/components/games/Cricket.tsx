"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Flame,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Trophy,
  Tv,
  Wallet as WalletIcon,
  X,
  CheckCircle2,
  TrendingUp,
  Clock,
} from "lucide-react";
import type { Nav } from "../nav";
import { Header, Money } from "../ui";
import { useStore } from "../../lib/store";
import { inr } from "../../lib/data";
import { sfx } from "../../lib/sound";
import {
  fetchCricketMatches,
  fetchCricketOdds,
  fetchCricketScorecard,
  loadStoredBets,
  saveStoredBet,
  type CricketBet,
  type CricketMatch,
  type CricketOddsResponse,
  type CricketScorecard,
  type RunnerOdd,
} from "../../lib/cricketApi";

interface BetSlipState {
  isOpen: boolean;
  marketType: "MATCH_ODDS" | "BOOKMAKER" | "FANCY";
  marketName: string;
  runnerName: string;
  betType: "BACK" | "LAY";
  odds: number;
  size?: number;
  min: number;
  max: number;
}

export function Cricket({ nav, matchId }: { nav: Nav; matchId?: string }) {
  const { total, debit, credit, showToast } = useStore();
  const [matches, setMatches] = useState<CricketMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(matchId || null);
  const [tab, setTab] = useState<"inplay" | "upcoming" | "all">("inplay");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  // Selected Match Live State
  const [oddsData, setOddsData] = useState<CricketOddsResponse | null>(null);
  const [scorecard, setScorecard] = useState<CricketScorecard | null>(null);
  const [activeView, setActiveView] = useState<"markets" | "tv" | "mybets">("markets");
  const [myBets, setMyBets] = useState<CricketBet[]>([]);

  // Bet Slip State
  const [betSlip, setBetSlip] = useState<BetSlipState | null>(null);
  const [stake, setStake] = useState<number>(500);

  // Load matches
  const loadMatches = async () => {
    setLoading(true);
    const list = await fetchCricketMatches();
    setMatches(list);
    setLoading(false);
  };

  useEffect(() => {
    loadMatches();
    setMyBets(loadStoredBets());
    const t = setInterval(loadMatches, 8000);
    return () => clearInterval(t);
  }, []);

  // Poll live odds & scorecard for selected match
  useEffect(() => {
    if (!selectedMatchId) return;

    const loadMatchDetails = async () => {
      const [odds, score] = await Promise.all([
        fetchCricketOdds(selectedMatchId),
        fetchCricketScorecard(selectedMatchId),
      ]);
      setOddsData(odds);
      if (score) setScorecard(score);
    };

    loadMatchDetails();
    const t = setInterval(loadMatchDetails, 3000);
    return () => clearInterval(t);
  }, [selectedMatchId]);

  const activeMatch = useMemo(
    () => matches.find((m) => m.eventId === selectedMatchId),
    [matches, selectedMatchId]
  );

  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
      if (tab === "inplay" && !m.isLive) return false;
      if (tab === "upcoming" && m.isLive) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          m.eventName.toLowerCase().includes(q) ||
          m.seriesName.toLowerCase().includes(q) ||
          m.team1.name.toLowerCase().includes(q) ||
          m.team2.name.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [matches, tab, searchQuery]);

  // Open Bet Slip
  const openBet = (
    marketType: "MATCH_ODDS" | "BOOKMAKER" | "FANCY",
    marketName: string,
    runnerName: string,
    betType: "BACK" | "LAY",
    odds: number,
    size?: number,
    min = 100,
    max = 500000
  ) => {
    sfx.click();
    setBetSlip({
      isOpen: true,
      marketType,
      marketName,
      runnerName,
      betType,
      odds: Number(odds) || 1.95,
      size,
      min,
      max,
    });
    setStake(Math.min(500, total > 0 ? total : 500));
  };

  // Place Bet
  const handlePlaceBet = () => {
    if (!betSlip || !activeMatch) return;
    if (stake < betSlip.min) return showToast(`Minimum bet is ${inr(betSlip.min)}`);
    if (stake > betSlip.max) return showToast(`Maximum bet is ${inr(betSlip.max)}`);

    const exposure =
      betSlip.betType === "LAY" && betSlip.marketType === "MATCH_ODDS"
        ? Math.round(stake * (betSlip.odds - 1))
        : stake;

    if (total < exposure) {
      return showToast("Insufficient coins for this bet exposure!");
    }

    const ok = debit(exposure, `Cricket: ${activeMatch.eventName} • ${betSlip.runnerName}`);
    if (!ok) {
      return showToast("Failed to place bet. Please check coin balance.");
    }

    const profit =
      betSlip.betType === "BACK"
        ? Math.round(stake * (betSlip.odds - 1))
        : stake;

    const newBet: CricketBet = {
      id: "bet_" + Date.now(),
      eventId: activeMatch.eventId,
      eventName: activeMatch.eventName,
      marketType: betSlip.marketType,
      marketName: betSlip.marketName,
      runnerName: betSlip.runnerName,
      betType: betSlip.betType,
      odds: betSlip.odds,
      size: betSlip.size,
      stake,
      profit,
      exposure,
      status: "OPEN",
      placedAt: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    };

    const updated = saveStoredBet(newBet);
    setMyBets(updated);
    sfx.win();
    showToast(`Bet Placed on ${betSlip.runnerName}! 🏏`);
    setBetSlip(null);
  };

  // -------------------------------------------------------------
  // RENDER: Match Detail / Live Arena View
  // -------------------------------------------------------------
  if (selectedMatchId && activeMatch) {
    const matchBets = myBets.filter((b) => b.eventId === selectedMatchId);

    return (
      <div className="min-h-screen bg-[#070b19] text-white pb-24 fadein">
        {/* Sticky Header */}
        <div className="sticky top-0 z-30 bg-[#0c122c]/95 backdrop-blur-md border-b border-white/10 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => setSelectedMatchId(null)}
              className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 grid place-items-center active:scale-95 transition-transform"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-emerald-400 truncate">{activeMatch.seriesName}</div>
              <div className="text-sm font-bold truncate">{activeMatch.eventName}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="px-3 py-1 rounded-xl bg-emerald-950/60 border border-emerald-500/30 text-xs font-bold text-emerald-300 flex items-center gap-1.5">
              <WalletIcon size={13} />
              <Money n={total} />
            </div>
          </div>
        </div>

        {/* Live Scorecard Bar */}
        <div className="p-4">
          <div
            className="rounded-2xl p-4 border border-emerald-500/20 relative overflow-hidden"
            style={{
              background: "linear-gradient(135deg, #064e3b 0%, #022c22 60%, #081229 100%)",
              boxShadow: "0 10px 30px rgba(5,150,105,0.2)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {activeMatch.isLive ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-600 text-[10px] font-extrabold uppercase tracking-wider text-white shadow-sm animate-pulse">
                    <Radio size={12} /> Live
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-slate-300">
                    Upcoming
                  </span>
                )}
                <span className="text-xs text-emerald-200/80 font-medium">T20 International</span>
              </div>
              <div className="text-xs text-white/60 flex items-center gap-1">
                <Clock size={12} /> {new Date(activeMatch.eventTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>

            {/* Teams & Scores */}
            <div className="grid grid-cols-2 gap-4 my-2">
              <div className="bg-black/25 rounded-xl p-2.5 border border-white/5">
                <div className="text-xs text-white/70 font-semibold">{activeMatch.team1.name}</div>
                <div className="text-xl font-extrabold text-white mt-0.5">
                  {scorecard?.runs ? `${scorecard.runs}/${scorecard.wickets}` : activeMatch.team1.score || "0/0"}
                  <span className="text-xs font-normal text-white/60 ml-1.5">({scorecard?.overs || activeMatch.team1.overs || "0.0"} ov)</span>
                </div>
              </div>
              <div className="bg-black/25 rounded-xl p-2.5 border border-white/5">
                <div className="text-xs text-white/70 font-semibold">{activeMatch.team2.name}</div>
                <div className="text-xl font-extrabold text-white/80 mt-0.5">
                  {activeMatch.team2.score || "Yet to bat"}
                  {activeMatch.team2.overs && <span className="text-xs font-normal text-white/60 ml-1.5">({activeMatch.team2.overs} ov)</span>}
                </div>
              </div>
            </div>

            {/* Ball-by-Ball & Batsmen / Bowler */}
            {scorecard && (
              <div className="mt-3 pt-3 border-t border-white/10 text-xs">
                <div className="flex items-center justify-between text-white/70 mb-2">
                  <span>CRR: <strong className="text-white">{scorecard.crr}</strong></span>
                  {scorecard.target && <span>Target: <strong className="text-amber-400">{scorecard.target}</strong></span>}
                  <span>RRR: <strong className="text-rose-400">{scorecard.rrr || "4.5"}</strong></span>
                </div>

                {/* Recent Balls */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  <span className="text-[10px] text-white/50 uppercase font-semibold mr-1">This Over:</span>
                  {scorecard.recentBalls.map((b, i) => (
                    <span
                      key={i}
                      className={`w-6 h-6 rounded-full text-[11px] font-extrabold grid place-items-center ${
                        b === "6"
                          ? "bg-purple-600 text-white"
                          : b === "4"
                          ? "bg-blue-600 text-white"
                          : b === "W"
                          ? "bg-rose-600 text-white"
                          : "bg-white/15 text-white"
                      }`}
                    >
                      {b}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Navigation Tabs (Markets / Live TV / My Bets) */}
        <div className="px-4 flex gap-2 border-b border-white/10 pb-3">
          <button
            onClick={() => setActiveView("markets")}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
              activeView === "markets"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            📊 All Markets
          </button>
          <button
            onClick={() => setActiveView("tv")}
            className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              activeView === "tv"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            <Tv size={14} /> Live Stream
          </button>
          <button
            onClick={() => setActiveView("mybets")}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all relative ${
              activeView === "mybets"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            📜 My Bets {matchBets.length > 0 && `(${matchBets.length})`}
          </button>
        </div>

        {/* ----------------- VIEW: MARKETS ----------------- */}
        {activeView === "markets" && (
          <div className="p-4 space-y-5">
            {/* 1. MATCH ODDS (Betfair Exchange Back/Lay) */}
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-4 py-3 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                  <span className="font-bold text-sm">Match Odds (Exchange)</span>
                </div>
                <span className="text-[10px] text-white/50">Max: 🪙 5,00,000</span>
              </div>

              {/* Back / Lay Legend */}
              <div className="grid grid-cols-12 px-3 py-1.5 bg-black/40 text-[11px] font-bold text-white/70 border-b border-white/5 text-center">
                <div className="col-span-6 text-left pl-1">Teams</div>
                <div className="col-span-3 text-blue-400 bg-blue-950/40 rounded py-0.5">BACK (Lagai)</div>
                <div className="col-span-3 text-pink-400 bg-pink-950/40 rounded py-0.5">LAY (Khai)</div>
              </div>

              {/* Runners */}
              <div className="divide-y divide-white/5">
                {[
                  { name: activeMatch.team1.name, back: activeMatch.back1 || 1.62, lay: activeMatch.lay1 || 1.65, volB: "1.5L", volL: "1.2L" },
                  { name: activeMatch.team2.name, back: activeMatch.back2 || 2.54, lay: activeMatch.lay2 || 2.60, volB: "95K", volL: "1.1L" },
                ].map((runner, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2 hover:bg-white/[0.02]">
                    <div className="col-span-6 font-semibold text-sm pl-1">{runner.name}</div>
                    <button
                      onClick={() => openBet("MATCH_ODDS", "Match Odds", runner.name, "BACK", runner.back)}
                      className="col-span-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white active:scale-95 transition-all text-center shadow-md shadow-blue-600/30"
                    >
                      <div className="text-sm font-extrabold leading-none">{runner.back.toFixed(2)}</div>
                      <div className="text-[9px] text-blue-200 mt-0.5">{runner.volB}</div>
                    </button>
                    <button
                      onClick={() => openBet("MATCH_ODDS", "Match Odds", runner.name, "LAY", runner.lay)}
                      className="col-span-3 py-2 rounded-xl bg-pink-600 hover:bg-pink-500 text-white active:scale-95 transition-all text-center shadow-md shadow-pink-600/30"
                    >
                      <div className="text-sm font-extrabold leading-none">{runner.lay.toFixed(2)}</div>
                      <div className="text-[9px] text-pink-200 mt-0.5">{runner.volL}</div>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. BOOKMAKER MARKET (Fixed 100% Market) */}
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-4 py-3 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="font-bold text-sm">Bookmaker Odds (0% Comm)</span>
                </div>
                <span className="text-[10px] text-white/50">Min: 🪙 100 • Max: 🪙 2,00,000</span>
              </div>

              <div className="divide-y divide-white/5">
                {[
                  { name: activeMatch.team1.name, back: 62, lay: 65 },
                  { name: activeMatch.team2.name, back: 154, lay: 160 },
                ].map((bm, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2">
                    <div className="col-span-6 font-semibold text-sm pl-1">{bm.name}</div>
                    <button
                      onClick={() => openBet("BOOKMAKER", "Bookmaker Odds", bm.name, "BACK", (1 + bm.back / 100))}
                      className="col-span-3 py-2 rounded-xl bg-blue-700/90 hover:bg-blue-600 text-white active:scale-95 transition-all text-center"
                    >
                      <div className="text-sm font-extrabold">{bm.back}</div>
                      <div className="text-[9px] text-blue-200">100K</div>
                    </button>
                    <button
                      onClick={() => openBet("BOOKMAKER", "Bookmaker Odds", bm.name, "LAY", (1 + bm.lay / 100))}
                      className="col-span-3 py-2 rounded-xl bg-pink-700/90 hover:bg-pink-600 text-white active:scale-95 transition-all text-center"
                    >
                      <div className="text-sm font-extrabold">{bm.lay}</div>
                      <div className="text-[9px] text-pink-200">100K</div>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 3. FANCY / SESSION MARKETS */}
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-4 py-3 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-2">
                  <Flame size={16} className="text-amber-400" />
                  <span className="font-bold text-sm">Session & Fancy Markets</span>
                </div>
                <span className="text-[10px] text-amber-400 font-semibold">Live Ball by Ball</span>
              </div>

              <div className="grid grid-cols-12 px-3 py-1.5 bg-black/40 text-[11px] font-bold text-white/70 border-b border-white/5 text-center">
                <div className="col-span-6 text-left pl-1">Session / Fancy</div>
                <div className="col-span-3 text-pink-400 bg-pink-950/40 rounded py-0.5">NO (Khai)</div>
                <div className="col-span-3 text-blue-400 bg-blue-950/40 rounded py-0.5">YES (Lagai)</div>
              </div>

              <div className="divide-y divide-white/5">
                {[
                  { name: `6 Over Runs ${activeMatch.team1.short || "IND"}`, no: 46, yes: 48, rate: "100" },
                  { name: `10 Over Runs ${activeMatch.team1.short || "IND"}`, no: 84, yes: 86, rate: "100" },
                  { name: `15 Over Runs ${activeMatch.team1.short || "IND"}`, no: 132, yes: 135, rate: "100" },
                  { name: "Total Match Sixes", no: 13, yes: 14, rate: "100" },
                  { name: "Fall of Next Wicket (Runs)", no: 180, yes: 185, rate: "100" },
                  { name: "Virat Kohli 50+ Runs", no: 48, yes: 50, rate: "100" },
                ].map((fancy, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2">
                    <div className="col-span-6 font-semibold text-xs pl-1">{fancy.name}</div>
                    <button
                      onClick={() => openBet("FANCY", fancy.name, `${fancy.name} (NO: ${fancy.no})`, "LAY", 2.0, fancy.no)}
                      className="col-span-3 py-2 rounded-xl bg-pink-600/90 hover:bg-pink-500 text-white active:scale-95 transition-all text-center"
                    >
                      <div className="text-sm font-extrabold">{fancy.no}</div>
                      <div className="text-[9px] text-pink-200">{fancy.rate}</div>
                    </button>
                    <button
                      onClick={() => openBet("FANCY", fancy.name, `${fancy.name} (YES: ${fancy.yes})`, "BACK", 2.0, fancy.yes)}
                      className="col-span-3 py-2 rounded-xl bg-blue-600/90 hover:bg-blue-500 text-white active:scale-95 transition-all text-center"
                    >
                      <div className="text-sm font-extrabold">{fancy.yes}</div>
                      <div className="text-[9px] text-blue-200">{fancy.rate}</div>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ----------------- VIEW: LIVE TV ----------------- */}
        {activeView === "tv" && (
          <div className="p-4 space-y-4">
            <div className="rounded-2xl bg-black border border-white/10 aspect-video overflow-hidden relative grid place-items-center">
              {/* If DiamondExch whitelisted server is running with TV URL, iframe embeds here */}
              <iframe
                src={`/api/cricket/scorecard?eventId=${activeMatch.eventId}`}
                className="w-full h-full border-0"
                title="Live Cricket Radar & TV"
                allow="autoplay; fullscreen"
              />
            </div>
            <div className="rounded-2xl p-4 bg-emerald-950/40 border border-emerald-500/20 text-xs text-emerald-200 leading-relaxed">
              <div className="font-bold mb-1 text-sm flex items-center gap-1.5 text-emerald-300">
                <CheckCircle2 size={16} /> Whitelisted Domain Live Feed Connected
              </div>
              Live stream and radar tracking are active directly from the sports visualizer.
            </div>
          </div>
        )}

        {/* ----------------- VIEW: MY BETS ----------------- */}
        {activeView === "mybets" && (
          <div className="p-4 space-y-3">
            {matchBets.length === 0 ? (
              <div className="text-center py-12 text-white/50 text-sm">
                No active bets placed on this match yet. Tap on any Back / Lay odds to place a bet!
              </div>
            ) : (
              matchBets.map((b) => (
                <div key={b.id} className="rounded-2xl p-3.5 bg-[#0f172a] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <span
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase ${
                        b.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"
                      }`}
                    >
                      {b.betType}
                    </span>
                    <span className="text-xs text-white/50">{b.placedAt}</span>
                  </div>
                  <div className="font-bold text-sm">{b.runnerName}</div>
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-white/5">
                    <span className="text-white/60">Stake: <strong className="text-white">{inr(b.stake)}</strong></span>
                    <span className="text-white/60">Odds: <strong className="text-white">{b.odds.toFixed(2)}</strong></span>
                    <span className="text-emerald-400 font-bold">Profit: +{inr(b.profit)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ----------------- BET SLIP MODAL (BOTTOM DRAWER) ----------------- */}
        {betSlip && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center p-0 md:p-4 fadein">
            <div
              className={`w-full max-w-md rounded-t-3xl md:rounded-3xl p-5 border shadow-2xl transition-all ${
                betSlip.betType === "BACK"
                  ? "bg-[#0b1c3d] border-blue-500/40"
                  : "bg-[#2d0e23] border-pink-500/40"
              }`}
            >
              {/* Slip Header */}
              <div className="flex items-start justify-between pb-3 border-b border-white/10">
                <div>
                  <span
                    className={`inline-block px-2.5 py-0.5 rounded-lg text-[11px] font-black uppercase tracking-wider mb-1 ${
                      betSlip.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"
                    }`}
                  >
                    {betSlip.betType} • {betSlip.marketName}
                  </span>
                  <div className="font-bold text-base text-white">{betSlip.runnerName}</div>
                </div>
                <button
                  onClick={() => setBetSlip(null)}
                  className="w-8 h-8 rounded-full bg-white/10 grid place-items-center text-white/70 hover:text-white"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Odds & Stake Inputs */}
              <div className="grid grid-cols-2 gap-3 my-4">
                <div className="bg-black/40 rounded-2xl p-3 border border-white/10">
                  <div className="text-[11px] text-white/60 font-semibold uppercase">Odds Multiplier</div>
                  <div className="text-2xl font-extrabold text-white mt-1">{betSlip.odds.toFixed(2)}</div>
                </div>
                <div className="bg-black/40 rounded-2xl p-3 border border-white/10">
                  <div className="text-[11px] text-white/60 font-semibold uppercase">Stake Amount</div>
                  <div className="text-2xl font-extrabold text-emerald-400 mt-1">{inr(stake)}</div>
                </div>
              </div>

              {/* Quick Stake Chips */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                {[100, 500, 1000, 5000].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => { sfx.click(); setStake(amt); }}
                    className={`py-2 rounded-xl text-xs font-bold transition-all ${
                      stake === amt
                        ? "bg-white text-slate-900 shadow-md"
                        : "bg-white/10 text-white hover:bg-white/20"
                    }`}
                  >
                    +{amt}
                  </button>
                ))}
              </div>

              {/* Profit & Exposure Calculation */}
              <div className="bg-black/30 rounded-2xl p-3 border border-white/5 space-y-1.5 text-xs mb-4">
                <div className="flex items-center justify-between text-white/70">
                  <span>Potential Win Profit:</span>
                  <strong className="text-emerald-400 text-sm">
                    +{inr(betSlip.betType === "BACK" ? Math.round(stake * (betSlip.odds - 1)) : stake)}
                  </strong>
                </div>
                <div className="flex items-center justify-between text-white/70">
                  <span>Account Exposure / Risk:</span>
                  <strong className="text-rose-400 text-sm">
                    -{inr(betSlip.betType === "LAY" && betSlip.marketType === "MATCH_ODDS" ? Math.round(stake * (betSlip.odds - 1)) : stake)}
                  </strong>
                </div>
              </div>

              {/* Submit Button */}
              <button
                onClick={handlePlaceBet}
                className={`w-full py-4 rounded-2xl font-extrabold text-base uppercase tracking-wider text-white shadow-xl active:scale-95 transition-all ${
                  betSlip.betType === "BACK"
                    ? "bg-gradient-to-r from-blue-600 to-indigo-600 shadow-blue-600/40"
                    : "bg-gradient-to-r from-pink-600 to-rose-600 shadow-pink-600/40"
                }`}
              >
                Place Bet ({inr(stake)})
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------
  // RENDER: Match Lobby View (Match List)
  // -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
      <Header
        title="Cricket Live Exchange"
        onBack={() => nav.reset({ name: "home" })}
        right={
          <button
            onClick={loadMatches}
            className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 grid place-items-center active:scale-95 transition-transform"
            aria-label="Refresh matches"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        }
      />

      <div className="px-4 pt-2">
        {/* Banner */}
        <div
          className="rounded-3xl p-5 border border-emerald-500/30 relative overflow-hidden mb-5"
          style={{
            background: "linear-gradient(135deg, #064e3b 0%, #065f46 50%, #022c22 100%)",
            boxShadow: "0 12px 36px rgba(5,150,105,0.25)",
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-400/20 text-emerald-300 text-[11px] font-extrabold uppercase tracking-wider border border-emerald-400/30">
                ⚡ Real-time Exchange
              </span>
              <div className="text-2xl font-extrabold text-white mt-1.5 leading-tight">
                Cricket Betting & Live TV
              </div>
              <div className="text-xs text-emerald-100/75 mt-1">
                Back & Lay Odds • Bookmaker • Session Fancy • Radar Scorecard
              </div>
            </div>
            <span className="text-5xl drop-shadow-lg">🏏</span>
          </div>
        </div>

        {/* Search & Tabs */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search team or tournament…"
              className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-white/40 focus:outline-none focus:border-emerald-400"
            />
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab("inplay")}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
              tab === "inplay"
                ? "bg-rose-600 text-white shadow-lg shadow-rose-600/30"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            In-Play ({matches.filter((m) => m.isLive).length})
          </button>
          <button
            onClick={() => setTab("upcoming")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              tab === "upcoming"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            Upcoming ({matches.filter((m) => !m.isLive).length})
          </button>
          <button
            onClick={() => setTab("all")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              tab === "all"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            All ({matches.length})
          </button>
        </div>

        {/* Match List */}
        <div className="space-y-3">
          {filteredMatches.length === 0 ? (
            <div className="text-center py-12 text-white/50 text-sm">
              No matches found.
            </div>
          ) : (
            filteredMatches.map((match) => (
              <div
                key={match.eventId}
                className="rounded-2xl p-4 bg-[#0f172a] border border-white/10 hover:border-emerald-500/40 transition-all shadow-lg active:scale-[.99]"
              >
                {/* Series & Status Header */}
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    {match.isLive ? (
                      <span className="px-2 py-0.5 rounded-full bg-rose-600 text-[10px] font-extrabold uppercase tracking-wider text-white animate-pulse">
                        ● Live
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-slate-300">
                        Upcoming
                      </span>
                    )}
                    <span className="text-xs text-white/60 font-medium truncate max-w-[200px]">
                      {match.seriesName}
                    </span>
                  </div>
                  <div className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
                    <Tv size={13} /> Live TV
                  </div>
                </div>

                {/* Match Card Body (Teams + Quick Odds) */}
                <div
                  onClick={() => setSelectedMatchId(match.eventId)}
                  className="cursor-pointer"
                >
                  <div className="flex items-center justify-between my-2">
                    <div className="space-y-1.5 flex-1 pr-2">
                      <div className="flex items-center justify-between font-bold text-sm">
                        <span>{match.team1.name}</span>
                        {match.team1.score && <span className="text-emerald-400">{match.team1.score} ({match.team1.overs} ov)</span>}
                      </div>
                      <div className="flex items-center justify-between font-bold text-sm text-white/80">
                        <span>{match.team2.name}</span>
                        {match.team2.score && <span className="text-white/60">{match.team2.score}</span>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quick Back / Lay Odds Row */}
                <div className="mt-3 pt-2.5 border-t border-white/5 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSelectedMatchId(match.eventId)}
                    className="py-2 px-3 rounded-xl bg-blue-950/60 border border-blue-500/30 hover:bg-blue-900/60 flex items-center justify-between transition-all"
                  >
                    <span className="text-xs font-semibold text-blue-200 truncate">{match.team1.short || "T1"}</span>
                    <span className="text-xs font-extrabold text-blue-400">Back {match.back1?.toFixed(2) || "1.65"}</span>
                  </button>
                  <button
                    onClick={() => setSelectedMatchId(match.eventId)}
                    className="py-2 px-3 rounded-xl bg-pink-950/60 border border-pink-500/30 hover:bg-pink-900/60 flex items-center justify-between transition-all"
                  >
                    <span className="text-xs font-semibold text-pink-200 truncate">{match.team2.short || "T2"}</span>
                    <span className="text-xs font-extrabold text-pink-400">Back {match.back2?.toFixed(2) || "2.45"}</span>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
