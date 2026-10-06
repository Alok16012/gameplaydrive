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
  Activity,
  Calendar,
  Layers,
  Sparkles,
  PlayCircle,
  HelpCircle,
  RotateCcw,
  Check,
} from "lucide-react";
import type { Nav } from "../nav";
import { Header, Money } from "../ui";
import { useStore } from "../../lib/store";
import { inr } from "../../lib/data";
import { sfx } from "../../lib/sound";
import {
  fetchCricketMatches,
  fetchCricketOdds,
  fetchFancyResults,
  fetchMatchResults,
  getMatchDepthOdds,
  loadStoredBets,
  saveStoredBet,
  type CricketBet,
  type CricketMatch,
  type CricketOddsResponse,
  type SportType,
  type RunnerOdd,
  type MarketOdds,
} from "../../lib/cricketApi";

interface BetSlipState {
  isOpen: boolean;
  marketType: "MATCH_ODDS" | "BOOKMAKER" | "FANCY" | "TIE" | "TOSS";
  marketName: string;
  runnerName: string;
  betType: "BACK" | "LAY";
  odds: number;
  size?: number;
  min: number;
  max: number;
}

const SPORTS_TABS: Array<{ id: SportType; label: string; icon: string }> = [
  { id: "cricket", label: "Cricket", icon: "🏏" },
  { id: "soccer", label: "Football", icon: "⚽" },
  { id: "tennis", label: "Tennis", icon: "🎾" },
];

const QUICK_STAKES = [100, 500, 1000, 2000, 5000, 10000, 25000, 50000];

export function Cricket({
  nav,
  matchId,
  initialSport = "cricket",
}: {
  nav: Nav;
  matchId?: string;
  initialSport?: SportType;
}) {
  const { total, debit, credit, showToast } = useStore();
  const [selectedSport, setSelectedSport] = useState<SportType>(initialSport || "cricket");
  const [matches, setMatches] = useState<CricketMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(matchId || null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTabFilter, setActiveTabFilter] = useState<"all" | "inplay" | "upcoming">("all");
  const [loading, setLoading] = useState(true);
  const [tickCount, setTickCount] = useState(0);

  // High-frequency live tick engine (zero latency continuous price updates)
  useEffect(() => {
    const t = setInterval(() => {
      setTickCount((c) => c + 1);
    }, 1200);
    return () => clearInterval(t);
  }, []);

  // Match Arena State
  const [mediaMode, setMediaMode] = useState<"tv" | "scorecard" | "none">("scorecard");
  const [showMyBets, setShowMyBets] = useState(false);
  const [myBets, setMyBets] = useState<CricketBet[]>([]);
  const [oddsData, setOddsData] = useState<CricketOddsResponse | null>(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [activeMarketTab, setActiveMarketTab] = useState<"all" | "match_odds" | "bookmaker" | "fancy">("all");

  // Sync prop changes
  useEffect(() => {
    if (initialSport && initialSport !== selectedSport) {
      setSelectedSport(initialSport);
      setActiveTabFilter("all");
      setSearchQuery("");
      setSelectedMatchId(null);
    }
  }, [initialSport]);

  useEffect(() => {
    if (matchId !== undefined) {
      setSelectedMatchId(matchId || null);
    }
  }, [matchId]);

  // Bet Slip State
  const [betSlip, setBetSlip] = useState<BetSlipState | null>(null);
  const [stake, setStake] = useState<number>(500);

  // Load matches for selected sport (15 min cache)
  const loadMatches = async (sport = selectedSport) => {
    setLoading(true);
    const list = await fetchCricketMatches(sport);
    setMatches(list);
    setLoading(false);
  };

  useEffect(() => {
    loadMatches(selectedSport);
    setMyBets(loadStoredBets());
    const t = setInterval(() => loadMatches(selectedSport), 15000);
    return () => clearInterval(t);
  }, [selectedSport]);

  const activeMatch = useMemo(
    () => matches.find((m) => m.eventId === selectedMatchId),
    [matches, selectedMatchId]
  );

  // Poll live odds when a match arena is open (500ms for Live, 2000ms for Upcoming)
  useEffect(() => {
    if (!activeMatch) {
      setOddsData(null);
      return;
    }

    let isMounted = true;
    const fetchOdds = async () => {
      try {
        const res = await fetchCricketOdds(
          activeMatch.eventId,
          activeMatch.sport,
          activeMatch.inPlay,
          activeMatch.team1.name,
          activeMatch.team2.name
        );
        if (isMounted && res) {
          setOddsData(res);
        }
      } catch (err) {
        // silent fallback
      }
    };

    fetchOdds();
    const intervalMs = activeMatch.inPlay ? 500 : 1500;
    const intervalId = setInterval(fetchOdds, intervalMs);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [activeMatch?.eventId, activeMatch?.inPlay, activeMatch?.sport, activeMatch?.team1?.name, activeMatch?.team2?.name]);

  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
      if (activeTabFilter === "inplay" && !m.inPlay && !m.isLive) return false;
      if (activeTabFilter === "upcoming" && (m.inPlay || m.isLive)) return false;

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
  }, [matches, searchQuery, activeTabFilter]);

  // Open Bet Slip
  const openBet = (
    marketType: "MATCH_ODDS" | "BOOKMAKER" | "FANCY" | "TIE" | "TOSS",
    marketName: string,
    runnerName: string,
    betType: "BACK" | "LAY",
    odds: number,
    size?: number,
    min = 100,
    max = 500000
  ) => {
    if (odds <= 0 || isNaN(odds)) return;
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

    const ok = debit(exposure, `${activeMatch.sport.toUpperCase()}: ${activeMatch.eventName} • ${betSlip.runnerName}`);
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
      marketType: betSlip.marketType as any,
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
      sport: activeMatch.sport,
    };

    const updated = saveStoredBet(newBet);
    setMyBets(updated);
    sfx.win();
    showToast(`Bet Placed on ${betSlip.runnerName}! ⚡`);
    setBetSlip(null);
  };

  // -------------------------------------------------------------
  // RENDER: Match Detail / Live Arena View (my99exch / OExch Standard)
  // -------------------------------------------------------------
  if (selectedMatchId && activeMatch) {
    const matchBets = myBets.filter((b) => b.eventId === selectedMatchId);
    const sportApiName = activeMatch.sport === "soccer" ? "football" : activeMatch.sport;
    const tvIframeUrl = `https://apis.diamondexchapi.com/api/tv?eventId=${activeMatch.eventId}&sport=${sportApiName}`;
    const scorecardIframeUrl = `https://apis.diamondexchapi.com/api/scorecard?eventId=${activeMatch.eventId}&sport=${sportApiName}`;

    // Zero-latency dynamic depth engine
    const liveDepth = getMatchDepthOdds(activeMatch, tickCount);

    // Extract dynamic odds from API if available, else use real-time depth odds
    const matchOdds = (oddsData?.matchOdds?.[0]?.oddDatas && oddsData.matchOdds[0].oddDatas.length > 0)
      ? oddsData.matchOdds[0].oddDatas.map((r, idx) => ({
          ...r,
          rname: (!r.rname || r.rname === "Team 1" || r.rname === "Runner 1")
            ? (idx === 0 ? activeMatch.team1.name : (idx === 1 && activeMatch.sport === "soccer" ? "The Draw" : activeMatch.team2.name))
            : (!r.rname || r.rname === "Team 2" || r.rname === "Runner 2")
            ? activeMatch.team2.name
            : r.rname,
        }))
      : liveDepth.matchOdds[0].oddDatas;

    const bookMakerOdds = (oddsData?.bookMakerOdds?.[0]?.oddDatas && oddsData.bookMakerOdds[0].oddDatas.length > 0)
      ? oddsData.bookMakerOdds[0].oddDatas.map((bm, idx) => ({
          ...bm,
          rname: (!bm.rname || bm.rname === "Team 1" || bm.rname === "Team 1 (Bookmaker)")
            ? (idx === 0 ? activeMatch.team1.name : activeMatch.team2.name)
            : (!bm.rname || bm.rname === "Team 2" || bm.rname === "Team 2 (Bookmaker)")
            ? activeMatch.team2.name
            : bm.rname,
        }))
      : liveDepth.bookMakerOdds[0].oddDatas;

    const fancyOdds = (oddsData?.fancyOdds?.[0]?.oddDatas && oddsData.fancyOdds[0].oddDatas.length > 0)
      ? oddsData.fancyOdds[0].oddDatas
      : liveDepth.fancyOdds[0].oddDatas;

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
          <div className="flex items-center gap-2">
            <div className="px-2.5 py-1 rounded-xl bg-emerald-950/80 border border-emerald-500/40 text-xs font-bold text-emerald-300 flex items-center gap-1.5">
              <WalletIcon size={12} />
              <Money n={total} />
            </div>
          </div>
        </div>

        {/* Media & Action Bar */}
        <div className="px-3 py-1.5 bg-[#0a0f24] border-b border-white/5 flex items-center justify-between gap-2 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setMediaMode(mediaMode === "tv" ? "none" : "tv")}
              className={`px-3 py-1 rounded-lg text-[11px] font-extrabold flex items-center gap-1.5 transition-all ${
                mediaMode === "tv"
                  ? "bg-rose-600 text-white shadow-md shadow-rose-600/40 animate-pulse"
                  : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              <Tv size={12} /> Live TV
            </button>
            <button
              onClick={() => setMediaMode(mediaMode === "scorecard" ? "none" : "scorecard")}
              className={`px-3 py-1 rounded-lg text-[11px] font-extrabold flex items-center gap-1.5 transition-all ${
                mediaMode === "scorecard"
                  ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/30"
                  : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              <Activity size={12} /> Radar Score
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowMyBets(!showMyBets)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 transition-all ${
                showMyBets ? "bg-blue-600 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              📜 Bets {matchBets.length > 0 && `(${matchBets.length})`}
            </button>
          </div>
        </div>

        {/* Embedded Live Media Frame */}
        {mediaMode !== "none" && (
          <div className="bg-black border-b border-white/10 relative w-full aspect-video max-h-[260px] overflow-hidden">
            <iframe
              src={mediaMode === "tv" ? tvIframeUrl : scorecardIframeUrl}
              className="w-full h-full border-0"
              title={mediaMode === "tv" ? "Live TV Stream" : "Live Match Scorecard"}
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}

        {/* Match Header Score Card */}
        <div className="p-3">
          <div
            className="rounded-2xl p-3.5 border border-emerald-500/20 relative overflow-hidden shadow-lg"
            style={{
              background: "linear-gradient(135deg, #064e3b 0%, #022c22 60%, #081229 100%)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {activeMatch.inPlay || activeMatch.isLive ? (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-600 text-[10px] font-black uppercase tracking-wider text-white animate-pulse">
                    <Radio size={10} /> Live In-Play
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-slate-300">
                    Upcoming
                  </span>
                )}
                <span className="text-[11px] text-emerald-200/80 font-semibold capitalize">{activeMatch.sport} Exchange</span>
              </div>
              <div className="text-[11px] text-white/70 flex items-center gap-1">
                <Clock size={11} /> {new Date(activeMatch.eventTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>

            {/* Teams & Scores */}
            <div className="grid grid-cols-2 gap-2.5 my-1">
              <div className="bg-black/40 rounded-xl p-2.5 border border-white/5">
                <div className="text-xs text-white/80 font-bold truncate">{activeMatch.team1.name}</div>
                <div className="text-base font-black text-white mt-0.5">
                  {activeMatch.team1.score || (
                    activeMatch.inPlay
                      ? (activeMatch.sport === "soccer" ? "1" : activeMatch.sport === "tennis" ? "6 (4)" : "168/4")
                      : "-"
                  )}
                  {activeMatch.sport === "cricket" && activeMatch.team1.overs && (
                    <span className="text-xs font-normal text-white/60 ml-1">({activeMatch.team1.overs} ov)</span>
                  )}
                </div>
              </div>
              <div className="bg-black/40 rounded-xl p-2.5 border border-white/5">
                <div className="text-xs text-white/80 font-bold truncate">{activeMatch.team2.name}</div>
                <div className="text-base font-black text-white/90 mt-0.5">
                  {activeMatch.team2.score || (
                    activeMatch.inPlay
                      ? (activeMatch.sport === "soccer" ? "0" : activeMatch.sport === "tennis" ? "4 (3)" : "154/6")
                      : "-"
                  )}
                  {activeMatch.sport === "cricket" && activeMatch.team2.overs && (
                    <span className="text-xs font-normal text-white/60 ml-1">({activeMatch.team2.overs} ov)</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* My Bets Slide-Down Panel */}
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
                      <span className={`px-1.5 py-0.2 rounded text-[10px] font-black ${b.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"}`}>
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

        {/* Market Filter Tabs */}
        <div className="px-3 mb-3">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar bg-[#0a0f24] p-1 rounded-xl border border-white/5">
            {[
              { id: "all", label: "All Markets" },
              { id: "match_odds", label: "Match Odds" },
              { id: "bookmaker", label: "Bookmaker" },
              {
                id: "fancy",
                label: activeMatch.sport === "soccer" ? "Goals & Specials" : activeMatch.sport === "tennis" ? "Sets & Games" : "Fancy & Sessions"
              },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveMarketTab(tab.id as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-extrabold whitespace-nowrap transition-all ${
                  activeMarketTab === tab.id
                    ? "bg-[#1e293b] text-emerald-300 border border-emerald-500/30 shadow-sm"
                    : "text-white/60 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Betting Markets Container */}
        <div className="px-3 space-y-3.5">
          {/* 1. Match Odds Table (Standard OExch 3-Tier Back/Lay Grid) */}
          {(activeMarketTab === "all" || activeMarketTab === "match_odds") && (
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-3 py-2 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  <span className="font-extrabold text-xs text-white">MATCH ODDS (EXCHANGE)</span>
                </div>
                <span className="text-[10px] text-white/50 font-bold">Max: 🪙 5,00,000</span>
              </div>

              {/* Table Column Headers */}
              <div className="grid grid-cols-12 px-2 py-1 bg-black/50 text-[10px] font-extrabold text-white/70 border-b border-white/5 text-center">
                <div className="col-span-6 text-left pl-1">SELECTION</div>
                <div className="col-span-3 text-[#72bbef] bg-blue-950/50 rounded py-0.5">BACK (Lagai)</div>
                <div className="col-span-3 text-[#faa9ba] bg-pink-950/50 rounded py-0.5">LAY (Khai)</div>
              </div>

              <div className="divide-y divide-white/5">
                {matchOdds.map((runner, idx) => {
                  const bPrice = Number(runner.b1 || 1.85);
                  const lPrice = Number(runner.l1 || 1.89);
                  return (
                    <div key={idx} className="grid grid-cols-12 items-center p-2 gap-1.5 hover:bg-white/[0.02]">
                      <div className="col-span-6 font-bold text-xs pl-1 truncate text-white">{runner.rname}</div>
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", runner.rname, "BACK", bPrice, undefined, 100, 500000)}
                        className="col-span-3 py-1.5 rounded-lg bg-[#72bbef] hover:bg-blue-300 text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform shadow-sm"
                      >
                        <div className="text-xs font-black leading-tight">{bPrice.toFixed(2)}</div>
                        <div className="text-[9px] text-slate-800 font-bold">{runner.bs1 || "1.5L"}</div>
                      </button>
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", runner.rname, "LAY", lPrice, undefined, 100, 500000)}
                        className="col-span-3 py-1.5 rounded-lg bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform shadow-sm"
                      >
                        <div className="text-xs font-black leading-tight">{lPrice.toFixed(2)}</div>
                        <div className="text-[9px] text-slate-800 font-bold">{runner.ls1 || "1.2L"}</div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 2. Bookmaker Odds Table (0% Commission) */}
          {(activeMarketTab === "all" || activeMarketTab === "bookmaker") && (
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-3 py-2 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="font-extrabold text-xs text-white">BOOKMAKER 0% COMM</span>
                </div>
                <span className="text-[10px] text-white/50 font-bold">Min: 🪙 100 • Max: 🪙 2,00,000</span>
              </div>

              <div className="divide-y divide-white/5">
                {bookMakerOdds.map((bm, idx) => {
                  const bRate = Number(bm.b1 || 85);
                  const lRate = Number(bm.l1 || 89);
                  return (
                    <div key={idx} className="grid grid-cols-12 items-center p-2 gap-1.5">
                      <div className="col-span-6 font-bold text-xs pl-1 truncate text-white">{bm.rname}</div>
                      <button
                        onClick={() => openBet("BOOKMAKER", "Bookmaker Odds", bm.rname, "BACK", (1 + bRate / 100), undefined, 100, 200000)}
                        className="col-span-3 py-1.5 rounded-lg bg-[#72bbef] text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform"
                      >
                        <div className="text-xs font-black">{bRate}</div>
                        <div className="text-[9px] text-slate-800 font-bold">{bm.bs1 || "100K"}</div>
                      </button>
                      <button
                        onClick={() => openBet("BOOKMAKER", "Bookmaker Odds", bm.rname, "LAY", (1 + lRate / 100), undefined, 100, 200000)}
                        className="col-span-3 py-1.5 rounded-lg bg-[#faa9ba] text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform"
                      >
                        <div className="text-xs font-black">{lRate}</div>
                        <div className="text-[9px] text-slate-800 font-bold">{bm.ls1 || "100K"}</div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. Fancy, Goals & Specials Market Table */}
          {(activeMarketTab === "all" || activeMarketTab === "fancy") && fancyOdds.length > 0 && (
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-3 py-2 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-1.5">
                  <Flame size={14} className="text-amber-400 animate-pulse" />
                  <span className="font-extrabold text-xs text-white">
                    {activeMatch.sport === "soccer" ? "GOALS & SPECIAL MARKETS" : activeMatch.sport === "tennis" ? "SETS & GAMES MARKETS" : "SESSION & FANCY MARKETS"}
                  </span>
                </div>
                <span className="text-[10px] text-amber-400 font-extrabold">
                  {activeMatch.sport === "cricket" ? "Ball by Ball" : "Live Match"}
                </span>
              </div>

              <div className="grid grid-cols-12 px-2 py-1 bg-black/50 text-[10px] font-extrabold text-white/70 border-b border-white/5 text-center">
                <div className="col-span-6 text-left pl-1">MARKET</div>
                <div className="col-span-3 text-[#faa9ba] bg-pink-950/50 rounded py-0.5">NO / UNDER</div>
                <div className="col-span-3 text-[#72bbef] bg-blue-950/50 rounded py-0.5">YES / OVER</div>
              </div>

              <div className="divide-y divide-white/5">
                {fancyOdds.map((fancy, idx) => {
                  const noRuns = Number(fancy.l1 || 46);
                  const yesRuns = Number(fancy.b1 || 48);
                  return (
                    <div key={idx} className="grid grid-cols-12 items-center p-2 gap-1.5">
                      <div className="col-span-6 font-bold text-xs pl-1 truncate text-white">{fancy.rname}</div>
                      <button
                        onClick={() => openBet("FANCY", fancy.rname, `${fancy.rname} (NO: ${noRuns})`, "LAY", 2.0, noRuns, 100, 50000)}
                        className="col-span-3 py-1.5 rounded-lg bg-[#faa9ba] text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform"
                      >
                        <div className="text-xs font-black">{noRuns}</div>
                        <div className="text-[9px] text-slate-800 font-bold">{fancy.ls1 || "100"}</div>
                      </button>
                      <button
                        onClick={() => openBet("FANCY", fancy.rname, `${fancy.rname} (YES: ${yesRuns})`, "BACK", 2.0, yesRuns, 100, 50000)}
                        className="col-span-3 py-1.5 rounded-lg bg-[#72bbef] text-slate-950 font-black text-xs grid place-items-center active:scale-95 transition-transform"
                      >
                        <div className="text-xs font-black">{yesRuns}</div>
                        <div className="text-[9px] text-slate-800 font-bold">{fancy.bs1 || "100"}</div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Bet Slip (Slide-Up Bottom Sheet like my99exch) */}
        {betSlip && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end justify-center p-0 md:p-4 fadein">
            <div
              className={`w-full max-w-md rounded-t-3xl md:rounded-3xl p-4 border shadow-2xl transition-all ${
                betSlip.betType === "BACK"
                  ? "bg-[#0b1c3d] border-blue-500/50"
                  : "bg-[#2d0e23] border-pink-500/50"
              }`}
            >
              <div className="flex items-start justify-between pb-2.5 border-b border-white/10">
                <div>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider mb-1 ${
                      betSlip.betType === "BACK" ? "bg-blue-600 text-white" : "bg-pink-600 text-white"
                    }`}
                  >
                    {betSlip.betType} • {betSlip.marketName}
                  </span>
                  <div className="font-extrabold text-sm text-white">{betSlip.runnerName}</div>
                </div>
                <button
                  onClick={() => setBetSlip(null)}
                  className="w-7 h-7 rounded-full bg-white/10 grid place-items-center text-white/70 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Odds & Stake Inputs */}
              <div className="grid grid-cols-2 gap-2.5 my-3">
                <div className="bg-black/50 rounded-xl p-2.5 border border-white/10">
                  <div className="text-[10px] text-white/60 font-bold uppercase">ODDS RATE</div>
                  <div className="text-xl font-black text-white mt-0.5">{betSlip.odds.toFixed(2)}</div>
                </div>
                <div className="bg-black/50 rounded-xl p-2.5 border border-white/10">
                  <div className="text-[10px] text-white/60 font-bold uppercase">STAKE COINS</div>
                  <div className="text-xl font-black text-emerald-400 mt-0.5">{inr(stake)}</div>
                </div>
              </div>

              {/* Quick Stake Buttons (OExch Standard) */}
              <div className="grid grid-cols-4 gap-1.5 mb-3">
                {QUICK_STAKES.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => { sfx.click(); setStake(amt); }}
                    className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
                      stake === amt
                        ? "bg-white text-slate-950 font-black shadow-md"
                        : "bg-white/10 text-white/80 hover:bg-white/20"
                    }`}
                  >
                    +{amt >= 1000 ? `${amt / 1000}K` : amt}
                  </button>
                ))}
              </div>

              {/* Exposure & Profit Summary */}
              <div className="bg-black/40 rounded-xl p-2.5 border border-white/5 space-y-1 text-xs mb-3">
                <div className="flex items-center justify-between text-white/70">
                  <span>Potential Win:</span>
                  <strong className="text-emerald-400 text-xs">
                    +{inr(betSlip.betType === "BACK" ? Math.round(stake * (betSlip.odds - 1)) : stake)}
                  </strong>
                </div>
                <div className="flex items-center justify-between text-white/70">
                  <span>Account Liability:</span>
                  <strong className="text-rose-400 text-xs">
                    -{inr(betSlip.betType === "LAY" && betSlip.marketType === "MATCH_ODDS" ? Math.round(stake * (betSlip.odds - 1)) : stake)}
                  </strong>
                </div>
              </div>

              <button
                onClick={handlePlaceBet}
                className={`w-full py-3.5 rounded-xl font-black text-sm uppercase tracking-wider text-white shadow-xl active:scale-95 transition-all ${
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
  // RENDER: Exchange Lobby View (Exact Standard my99exch / OExch 1 | X | 2 Grid Table)
  // -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
      {/* Top Header */}
      <Header
        title={selectedSport === "cricket" ? "Cricket Exchange" : selectedSport === "soccer" ? "Football Exchange" : "Tennis Exchange"}
        onBack={() => nav.reset({ name: "home" })}
        right={
          <button
            onClick={() => loadMatches(selectedSport)}
            className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 grid place-items-center active:scale-95 transition-transform"
            aria-label="Refresh matches"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        }
      />

      {/* 1. TOP LIVE IN-PLAY TICKER (Scrolling highlights chips like my99exch) */}
      <div className="px-3 py-1.5 bg-[#0a0f24] border-b border-white/10 overflow-x-auto no-scrollbar flex items-center gap-2">
        {matches.filter((m) => m.inPlay || m.isLive).map((m) => (
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

      {/* 2. TOP SPORTS SELECTOR BAR (Cricket | Football | Tennis) */}
      <div className="px-3 pt-2 pb-0 flex items-center justify-between overflow-x-auto no-scrollbar border-b border-white/10 bg-[#0c122c]">
        <div className="flex items-center gap-1">
          {SPORTS_TABS.map((sport) => {
            const isSelected = selectedSport === sport.id;
            return (
              <button
                key={sport.id}
                onClick={() => {
                  sfx.click();
                  setSelectedSport(sport.id);
                  setActiveTabFilter("all");
                  setSearchQuery("");
                  setSelectedMatchId(null);
                }}
                className={`px-3.5 py-2 rounded-t-xl text-xs font-extrabold flex items-center gap-1.5 transition-all border-t border-x ${
                  isSelected
                    ? "bg-[#111c44] text-emerald-300 border-emerald-500/40 shadow-md"
                    : "bg-black/30 text-white/60 border-transparent hover:text-white"
                }`}
              >
                <span>{sport.icon}</span>
                <span>{sport.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. IN-PLAY VS UPCOMING FILTER TABS */}
      <div className="px-3 py-2 bg-[#0b1029] flex items-center justify-between gap-2 border-b border-white/5">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActiveTabFilter("all")}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition-all ${
              activeTabFilter === "all" ? "bg-white/15 text-white" : "text-white/50 hover:text-white"
            }`}
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
            In-Play ({matches.filter((m) => m.inPlay || m.isLive).length})
          </button>
          <button
            onClick={() => setActiveTabFilter("upcoming")}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition-all ${
              activeTabFilter === "upcoming" ? "bg-white/15 text-white" : "text-white/50 hover:text-white"
            }`}
          >
            Upcoming ({matches.filter((m) => !m.inPlay && !m.isLive).length})
          </button>
        </div>
        <div className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
          <Activity size={11} /> Auto 15m
        </div>
      </div>

      {/* Search Input */}
      <div className="px-3 py-2 bg-[#0b1029]">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${selectedSport === "soccer" ? "football" : selectedSport} match or series...`}
            className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-white/40 focus:outline-none focus:border-emerald-400"
          />
        </div>
      </div>

      {/* 4. EXCHANGE MATCHES TABLE (1 | X | 2 Back/Lay Grid) */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          {/* Table Column Headers */}
          <thead>
            <tr className="bg-[#0f172a] text-white/70 border-b border-white/10 text-[10px] font-extrabold">
              <th className="py-2 px-3 font-extrabold">MATCH</th>
              {/* 1 (Team 1) */}
              <th colSpan={2} className="py-1 px-1 text-center bg-blue-950/40 border-l border-white/10">
                <div className="text-[10px] text-blue-300 uppercase font-black">1</div>
                <div className="grid grid-cols-2 text-[9px] text-white/60 font-semibold">
                  <span className="text-[#72bbef]">Back</span>
                  <span className="text-[#faa9ba]">Lay</span>
                </div>
              </th>
              {/* X (Draw) */}
              <th colSpan={2} className="py-1 px-1 text-center bg-slate-900/40 border-l border-white/10">
                <div className="text-[10px] text-white/70 uppercase font-black">X</div>
                <div className="grid grid-cols-2 text-[9px] text-white/60 font-semibold">
                  <span className="text-[#72bbef]">Back</span>
                  <span className="text-[#faa9ba]">Lay</span>
                </div>
              </th>
              {/* 2 (Team 2) */}
              <th colSpan={2} className="py-1 px-1 text-center bg-blue-950/40 border-l border-white/10">
                <div className="text-[10px] text-blue-300 uppercase font-black">2</div>
                <div className="grid grid-cols-2 text-[9px] text-white/60 font-semibold">
                  <span className="text-[#72bbef]">Back</span>
                  <span className="text-[#faa9ba]">Lay</span>
                </div>
              </th>
            </tr>
          </thead>

          {/* Table Body Rows */}
          <tbody className="divide-y divide-white/5 bg-[#090e24]">
            {loading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-white/60 text-xs">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <RefreshCw size={18} className="animate-spin text-emerald-400" />
                    <span>Loading live {selectedSport === "soccer" ? "football" : selectedSport} matches...</span>
                  </div>
                </td>
              </tr>
            ) : filteredMatches.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-10 text-white/50 text-xs">
                  No {activeTabFilter !== "all" ? activeTabFilter : ""} matches found for {selectedSport === "soccer" ? "football" : selectedSport}.
                </td>
              </tr>
            ) : (
              filteredMatches.map((match) => {
                const formattedDate = new Date(match.eventTime).toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                });

                const depth = getMatchDepthOdds(match, tickCount);
                const r1 = depth.matchOdds[0]?.oddDatas[0];
                const rDraw = match.sport === "soccer" ? depth.matchOdds[0]?.oddDatas[1] : undefined;
                const r2 = match.sport === "soccer" ? depth.matchOdds[0]?.oddDatas[2] : depth.matchOdds[0]?.oddDatas[1];

                const b1Val = Number(r1?.b1 || match.back1 || 1.85);
                const l1Val = Number(r1?.l1 || match.lay1 || 1.89);
                const b2Val = Number(r2?.b1 || match.back2 || 2.05);
                const l2Val = Number(r2?.l2 || match.lay2 || 2.12);
                const drawBVal = rDraw ? Number(rDraw.b1 || 3.30) : 0;
                const drawLVal = rDraw ? Number(rDraw.l1 || 3.45) : 0;

                return (
                  <tr key={match.eventId} className="hover:bg-white/[0.03] transition-colors">
                    {/* Game Column (Match Name + Icons + Time) */}
                    <td className="py-2 px-3 align-middle max-w-[210px]">
                      <div
                        onClick={() => setSelectedMatchId(match.eventId)}
                        className="cursor-pointer group"
                      >
                        <div className="font-extrabold text-white text-xs group-hover:text-emerald-300 transition-colors leading-tight">
                          {match.eventName}
                        </div>
                        <div className="text-[10px] text-white/50 mt-0.5 flex items-center gap-1.5">
                          <span>/ {formattedDate}</span>
                        </div>
                        {/* Feature Badges (🟢, 📺, f, BM) */}
                        <div className="flex items-center gap-1 mt-1">
                          {match.inPlay || match.isLive ? (
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse inline-block" title="In-Play Live" />
                          ) : null}
                          <span title="Live TV Stream Available"><Tv size={11} className="text-blue-400 inline-block" /></span>
                          <span className="px-1 py-0.2 rounded text-[8px] font-black italic bg-purple-950 text-purple-300 border border-purple-800/40">
                            f
                          </span>
                          <span className="px-1 py-0.2 rounded text-[8px] font-bold bg-amber-950 text-amber-300 border border-amber-800/40">
                            BM
                          </span>
                          {match.team1.score && (
                            <span className="text-[10px] text-emerald-400 font-bold ml-1">
                              {match.team1.score}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* 1 - Back (Blue) */}
                    <td className="py-1 px-1 text-center w-[54px] border-l border-white/5">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team1.name, "BACK", b1Val)}
                        className="w-full h-8 rounded bg-[#72bbef] hover:bg-blue-300 text-slate-950 font-black text-xs flex flex-col items-center justify-center shadow-sm active:scale-95 transition-transform flash-back"
                      >
                        <span className="leading-none text-[11.5px] font-black">{b1Val.toFixed(2)}</span>
                        <span className="text-[8px] text-slate-800 font-bold leading-none mt-0.5">{r1?.bs1 || "1.2L"}</span>
                      </button>
                    </td>
                    {/* 1 - Lay (Pink) */}
                    <td className="py-1 px-1 text-center w-[54px]">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team1.name, "LAY", l1Val)}
                        className="w-full h-8 rounded bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-black text-xs flex flex-col items-center justify-center shadow-sm active:scale-95 transition-transform flash-lay"
                      >
                        <span className="leading-none text-[11.5px] font-black">{l1Val.toFixed(2)}</span>
                        <span className="text-[8px] text-slate-800 font-bold leading-none mt-0.5">{r1?.ls1 || "1.0L"}</span>
                      </button>
                    </td>

                    {/* X - Back (Blue) */}
                    <td className="py-1 px-1 text-center w-[48px] border-l border-white/5">
                      {drawBVal > 0 ? (
                        <button
                          onClick={() => openBet("MATCH_ODDS", "Match Odds", "The Draw", "BACK", drawBVal)}
                          className="w-full h-8 rounded bg-[#72bbef] text-slate-950 font-black text-xs flex flex-col items-center justify-center shadow-sm active:scale-95 transition-transform flash-back"
                        >
                          <span className="leading-none text-[11px] font-black">{drawBVal.toFixed(2)}</span>
                          <span className="text-[8px] text-slate-800 font-bold leading-none mt-0.5">{rDraw?.bs1 || "65K"}</span>
                        </button>
                      ) : (
                        <div className="w-full h-8 rounded bg-white/5 text-white/30 font-bold text-xs grid place-items-center">-</div>
                      )}
                    </td>
                    {/* X - Lay (Pink) */}
                    <td className="py-1 px-1 text-center w-[48px]">
                      {drawLVal > 0 ? (
                        <button
                          onClick={() => openBet("MATCH_ODDS", "Match Odds", "The Draw", "LAY", drawLVal)}
                          className="w-full h-8 rounded bg-[#faa9ba] text-slate-950 font-black text-xs flex flex-col items-center justify-center shadow-sm active:scale-95 transition-transform flash-lay"
                        >
                          <span className="leading-none text-[11px] font-black">{drawLVal.toFixed(2)}</span>
                          <span className="text-[8px] text-slate-800 font-bold leading-none mt-0.5">{rDraw?.ls1 || "80K"}</span>
                        </button>
                      ) : (
                        <div className="w-full h-8 rounded bg-white/5 text-white/30 font-bold text-xs grid place-items-center">-</div>
                      )}
                    </td>

                    {/* 2 - Back (Blue) */}
                    <td className="py-1 px-1 text-center w-[54px] border-l border-white/5">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team2.name, "BACK", b2Val)}
                        className="w-full h-8 rounded bg-[#72bbef] hover:bg-blue-300 text-slate-950 font-black text-xs flex flex-col items-center justify-center shadow-sm active:scale-95 transition-transform flash-back"
                      >
                        <span className="leading-none text-[11.5px] font-black">{b2Val.toFixed(2)}</span>
                        <span className="text-[8px] text-slate-800 font-bold leading-none mt-0.5">{r2?.bs1 || "90K"}</span>
                      </button>
                    </td>
                    {/* 2 - Lay (Pink) */}
                    <td className="py-1 px-1 text-center w-[54px]">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team2.name, "LAY", l2Val)}
                        className="w-full h-8 rounded bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-black text-xs flex flex-col items-center justify-center shadow-sm active:scale-95 transition-transform flash-lay"
                      >
                        <span className="leading-none text-[11.5px] font-black">{l2Val.toFixed(2)}</span>
                        <span className="text-[8px] text-slate-800 font-bold leading-none mt-0.5">{r2?.ls1 || "110K"}</span>
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
