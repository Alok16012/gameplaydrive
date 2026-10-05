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
} from "lucide-react";
import type { Nav } from "../nav";
import { Header, Money } from "../ui";
import { useStore } from "../../lib/store";
import { inr } from "../../lib/data";
import { sfx } from "../../lib/sound";
import {
  fetchCricketMatches,
  fetchCricketOdds,
  loadStoredBets,
  saveStoredBet,
  type CricketBet,
  type CricketMatch,
  type CricketOddsResponse,
  type SportType,
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

const SPORTS_CONFIG: Array<{ id: SportType; label: string; icon: string; name: string }> = [
  { id: "cricket", label: "Cricket", icon: "🏏", name: "Cricket Live Exchange" },
  { id: "tennis", label: "Tennis", icon: "🎾", name: "Tennis Exchange" },
  { id: "soccer", label: "Football", icon: "⚽", name: "Football Exchange" },
];

export function Cricket({ nav, matchId }: { nav: Nav; matchId?: string }) {
  const { total, debit, credit, showToast } = useStore();
  const [selectedSport, setSelectedSport] = useState<SportType>("cricket");
  const [matches, setMatches] = useState<CricketMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(matchId || null);
  const [statusTab, setStatusTab] = useState<"inplay" | "upcoming" | "all">("inplay");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  // Match Media Mode: 'tv' | 'scorecard' | 'none'
  const [mediaMode, setMediaMode] = useState<"tv" | "scorecard" | "none">("scorecard");
  const [showMyBets, setShowMyBets] = useState(false);
  const [myBets, setMyBets] = useState<CricketBet[]>([]);

  // Bet Slip State
  const [betSlip, setBetSlip] = useState<BetSlipState | null>(null);
  const [stake, setStake] = useState<number>(500);

  // Load matches for selected sport
  const loadMatches = async (sport = selectedSport) => {
    setLoading(true);
    const list = await fetchCricketMatches(sport);
    setMatches(list);
    setLoading(false);
  };

  useEffect(() => {
    loadMatches(selectedSport);
    setMyBets(loadStoredBets());
    const t = setInterval(() => loadMatches(selectedSport), 10000);
    return () => clearInterval(t);
  }, [selectedSport]);

  const activeMatch = useMemo(
    () => matches.find((m) => m.eventId === selectedMatchId),
    [matches, selectedMatchId]
  );

  const inPlayMatches = useMemo(() => matches.filter((m) => m.inPlay || m.isLive), [matches]);
  const upcomingMatches = useMemo(() => matches.filter((m) => !m.inPlay && !m.isLive), [matches]);

  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
      const isLive = m.inPlay || m.isLive;
      if (statusTab === "inplay" && !isLive) return false;
      if (statusTab === "upcoming" && isLive) return false;
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
  }, [matches, statusTab, searchQuery]);

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
      sport: activeMatch.sport,
    };

    const updated = saveStoredBet(newBet);
    setMyBets(updated);
    sfx.win();
    showToast(`Bet Placed on ${betSlip.runnerName}! ⚡`);
    setBetSlip(null);
  };

  // -------------------------------------------------------------
  // RENDER: Match Detail / Live Arena View (Like My99Exch / DiamondExch)
  // -------------------------------------------------------------
  if (selectedMatchId && activeMatch) {
    const matchBets = myBets.filter((b) => b.eventId === selectedMatchId);

    // Direct DiamondExch Iframe URLs
    const sportApiName = activeMatch.sport === "soccer" ? "football" : activeMatch.sport;
    const tvIframeUrl = `https://apis.diamondexchapi.com/api/tv?eventId=${activeMatch.eventId}&sport=${sportApiName}`;
    const scorecardIframeUrl = `https://apis.diamondexchapi.com/api/scorecard?eventId=${activeMatch.eventId}&sport=${sportApiName}`;

    return (
      <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
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
              <div className="text-[11px] font-semibold text-emerald-400 truncate">{activeMatch.seriesName}</div>
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

        {/* Media Toggle Bar (Live TV / Scorecard Radar / My Bets) */}
        <div className="px-4 py-2 bg-[#0a0f24] border-b border-white/5 flex items-center justify-between gap-2 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMediaMode(mediaMode === "tv" ? "none" : "tv")}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
                mediaMode === "tv"
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-600/30"
                  : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              <Tv size={13} /> Live TV
            </button>
            <button
              onClick={() => setMediaMode(mediaMode === "scorecard" ? "none" : "scorecard")}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
                mediaMode === "scorecard"
                  ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                  : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              <Activity size={13} /> Live Scorecard
            </button>
          </div>

          <button
            onClick={() => setShowMyBets(!showMyBets)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
              showMyBets
                ? "bg-blue-600 text-white"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            📜 My Bets {matchBets.length > 0 && `(${matchBets.length})`}
          </button>
        </div>

        {/* Embedded Live Media Frame (16:9 Iframe Container) */}
        {mediaMode !== "none" && (
          <div className="bg-black border-b border-white/10 relative w-full aspect-video max-h-[300px] overflow-hidden">
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
                {activeMatch.inPlay || activeMatch.isLive ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-600 text-[10px] font-extrabold uppercase tracking-wider text-white shadow-sm animate-pulse">
                    <Radio size={12} /> Live In-Play
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-slate-300">
                    Upcoming
                  </span>
                )}
                <span className="text-xs text-emerald-200/80 font-medium capitalize">{activeMatch.sport} Match</span>
              </div>
              <div className="text-xs text-white/60 flex items-center gap-1">
                <Clock size={12} /> {new Date(activeMatch.eventTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>

            {/* Teams & Scores */}
            <div className="grid grid-cols-2 gap-3 my-2">
              <div className="bg-black/35 rounded-xl p-2.5 border border-white/5">
                <div className="text-xs text-white/70 font-semibold">{activeMatch.team1.name}</div>
                <div className="text-lg font-extrabold text-white mt-0.5">
                  {activeMatch.team1.score || (activeMatch.inPlay ? "168/4" : "-")}
                  {activeMatch.team1.overs && <span className="text-xs font-normal text-white/60 ml-1.5">({activeMatch.team1.overs} ov)</span>}
                </div>
              </div>
              <div className="bg-black/35 rounded-xl p-2.5 border border-white/5">
                <div className="text-xs text-white/70 font-semibold">{activeMatch.team2.name}</div>
                <div className="text-lg font-extrabold text-white/80 mt-0.5">
                  {activeMatch.team2.score || (activeMatch.inPlay ? "182/6" : "-")}
                  {activeMatch.team2.overs && <span className="text-xs font-normal text-white/60 ml-1.5">({activeMatch.team2.overs} ov)</span>}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* My Bets Slide-Down Panel */}
        {showMyBets && (
          <div className="px-4 mb-4 fadein">
            <div className="rounded-2xl p-4 bg-[#0f172a] border border-blue-500/30 shadow-xl space-y-3">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <div className="font-bold text-sm text-blue-300">Open Bets on this Match ({matchBets.length})</div>
                <button onClick={() => setShowMyBets(false)} className="text-white/60 hover:text-white"><X size={16} /></button>
              </div>
              {matchBets.length === 0 ? (
                <div className="text-center py-4 text-xs text-white/50">No bets placed yet on this match.</div>
              ) : (
                matchBets.map((b) => (
                  <div key={b.id} className="rounded-xl p-2.5 bg-black/40 border border-white/5 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-black ${b.betType === "BACK" ? "bg-blue-600" : "bg-pink-600"}`}>
                        {b.betType}
                      </span>
                      <span className="text-white/50">{b.placedAt}</span>
                    </div>
                    <div className="font-semibold text-white">{b.runnerName}</div>
                    <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[11px]">
                      <span>Stake: <strong>{inr(b.stake)}</strong></span>
                      <span>Odds: <strong>{b.odds.toFixed(2)}</strong></span>
                      <span className="text-emerald-400 font-bold">Profit: +{inr(b.profit)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ----------------- BETTING MARKETS (SAME PAGE FLOW) ----------------- */}
        <div className="px-4 space-y-4">
          {/* 1. MATCH ODDS (Betfair Back / Lay Table) */}
          <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
            <div className="px-4 py-2.5 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                <span className="font-bold text-sm">Match Odds (Exchange)</span>
              </div>
              <span className="text-[10px] text-white/50">Max: 🪙 5,00,000</span>
            </div>

            {/* Back / Lay Legend Header */}
            <div className="grid grid-cols-12 px-3 py-1.5 bg-black/40 text-[11px] font-bold text-white/70 border-b border-white/5 text-center">
              <div className="col-span-6 text-left pl-1">Selection</div>
              <div className="col-span-3 text-blue-400 bg-blue-950/40 rounded py-0.5">BACK (Lagai)</div>
              <div className="col-span-3 text-pink-400 bg-pink-950/40 rounded py-0.5">LAY (Khai)</div>
            </div>

            {/* Runners */}
            <div className="divide-y divide-white/5">
              {[
                { name: activeMatch.team1.name, back: activeMatch.back1 || 1.85, lay: activeMatch.lay1 || 1.89, volB: "1.5L", volL: "1.2L" },
                { name: activeMatch.team2.name, back: activeMatch.back2 || 2.05, lay: activeMatch.lay2 || 2.12, volB: "95K", volL: "1.1L" },
              ].map((runner, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2 hover:bg-white/[0.02]">
                  <div className="col-span-6 font-semibold text-sm pl-1 truncate">{runner.name}</div>
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
            <div className="px-4 py-2.5 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="font-bold text-sm">Bookmaker Odds (0% Comm)</span>
              </div>
              <span className="text-[10px] text-white/50">Min: 🪙 100 • Max: 🪙 2,00,000</span>
            </div>

            <div className="divide-y divide-white/5">
              {[
                { name: activeMatch.team1.name, back: 85, lay: 89 },
                { name: activeMatch.team2.name, back: 105, lay: 112 },
              ].map((bm, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2">
                  <div className="col-span-6 font-semibold text-sm pl-1 truncate">{bm.name}</div>
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

          {/* 3. FANCY / SESSION MARKETS (If Cricket) */}
          {activeMatch.sport === "cricket" && (
            <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
              <div className="px-4 py-2.5 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
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
                  { name: `6 Over Runs ${activeMatch.team1.short || "T1"}`, no: 46, yes: 48, rate: "100" },
                  { name: `10 Over Runs ${activeMatch.team1.short || "T1"}`, no: 84, yes: 86, rate: "100" },
                  { name: `15 Over Runs ${activeMatch.team1.short || "T1"}`, no: 132, yes: 135, rate: "100" },
                  { name: "Total Match Sixes", no: 13, yes: 14, rate: "100" },
                  { name: "Fall of Next Wicket (Runs)", no: 180, yes: 185, rate: "100" },
                ].map((fancy, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2">
                    <div className="col-span-6 font-semibold text-xs pl-1 truncate">{fancy.name}</div>
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
          )}
        </div>

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
  // RENDER: Match Lobby View (Match List with Cricket / Tennis / Football Selector)
  // -------------------------------------------------------------
  const activeSportConfig = SPORTS_CONFIG.find((s) => s.id === selectedSport) || SPORTS_CONFIG[0];

  return (
    <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
      <Header
        title="Sports Live Exchange"
        onBack={() => nav.reset({ name: "home" })}
        right={
          <button
            onClick={() => loadMatches(selectedSport)}
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
          className="rounded-3xl p-5 border border-emerald-500/30 relative overflow-hidden mb-4"
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
                {activeSportConfig.name}
              </div>
              <div className="text-xs text-emerald-100/75 mt-1">
                Back & Lay Odds • Bookmaker • Live TV • Scorecard
              </div>
            </div>
            <span className="text-5xl drop-shadow-lg">{activeSportConfig.icon}</span>
          </div>
        </div>

        {/* 1. TOP SPORTS SELECTOR: Cricket | Tennis | Football */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {SPORTS_CONFIG.map((sport) => {
            const isSelected = selectedSport === sport.id;
            return (
              <button
                key={sport.id}
                onClick={() => {
                  sfx.click();
                  setSelectedSport(sport.id);
                }}
                className={`py-3 px-2 rounded-2xl font-extrabold text-xs flex flex-col items-center gap-1.5 transition-all active:scale-95 border ${
                  isSelected
                    ? "bg-gradient-to-b from-emerald-500 to-teal-700 text-white border-emerald-400 shadow-lg shadow-emerald-500/30"
                    : "bg-[#0f172a] text-white/70 border-white/10 hover:bg-white/5"
                }`}
              >
                <span className="text-2xl">{sport.icon}</span>
                <span>{sport.label}</span>
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${activeSportConfig.label} team or tournament…`}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-white/40 focus:outline-none focus:border-emerald-400"
          />
        </div>

        {/* 2. MATCH STATUS TABS: In-Play | Upcoming | All */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setStatusTab("inplay")}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              statusTab === "inplay"
                ? "bg-rose-600 text-white shadow-lg shadow-rose-600/30"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            In-Play ({inPlayMatches.length})
          </button>
          <button
            onClick={() => setStatusTab("upcoming")}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              statusTab === "upcoming"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            <Calendar size={13} />
            Upcoming ({upcomingMatches.length})
          </button>
          <button
            onClick={() => setStatusTab("all")}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${
              statusTab === "all"
                ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            All ({matches.length})
          </button>
        </div>

        {/* 3. MATCH LISTING CARDS */}
        <div className="space-y-3">
          {filteredMatches.length === 0 ? (
            <div className="text-center py-12 text-white/50 text-sm bg-[#0f172a] rounded-2xl border border-white/5">
              No {statusTab === "inplay" ? "live in-play" : statusTab === "upcoming" ? "upcoming" : ""} {activeSportConfig.label} matches found right now.
            </div>
          ) : (
            filteredMatches.map((match) => (
              <div
                key={match.eventId}
                className="rounded-2xl p-4 bg-[#0f172a] border border-white/10 hover:border-emerald-500/40 transition-all shadow-lg active:scale-[.99]"
              >
                {/* Series & Status Header */}
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/5">
                  <div className="flex items-center gap-2 min-w-0">
                    {match.inPlay || match.isLive ? (
                      <span className="px-2 py-0.5 rounded-full bg-rose-600 text-[10px] font-extrabold uppercase tracking-wider text-white animate-pulse shrink-0">
                        ● Live
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-slate-300 shrink-0">
                        Upcoming
                      </span>
                    )}
                    <span className="text-xs text-white/60 font-medium truncate">
                      {match.seriesName}
                    </span>
                  </div>
                  <div className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1 shrink-0">
                    <Tv size={13} /> Live TV
                  </div>
                </div>

                {/* Match Card Body (Teams + Scores / Schedule Time) */}
                <div
                  onClick={() => setSelectedMatchId(match.eventId)}
                  className="cursor-pointer"
                >
                  <div className="flex items-center justify-between my-2">
                    <div className="space-y-1.5 flex-1 pr-2">
                      <div className="flex items-center justify-between font-bold text-sm">
                        <span>{match.team1.name}</span>
                        {match.team1.score && (
                          <span className="text-emerald-400 font-extrabold">
                            {match.team1.score} {match.team1.overs ? `(${match.team1.overs} ov)` : ""}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between font-bold text-sm text-white/80">
                        <span>{match.team2.name}</span>
                        {match.team2.score && (
                          <span className="text-white/60 font-extrabold">
                            {match.team2.score} {match.team2.overs ? `(${match.team2.overs} ov)` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Scheduled Match Time if Upcoming */}
                  {(!match.inPlay && !match.isLive) && (
                    <div className="text-[11px] text-amber-300/90 flex items-center gap-1.5 mt-1 font-medium">
                      <Clock size={12} />
                      Starts: {new Date(match.eventTime).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  )}
                </div>

                {/* Quick Back / Lay Odds Row */}
                <div className="mt-3 pt-2.5 border-t border-white/5 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSelectedMatchId(match.eventId)}
                    className="py-2 px-3 rounded-xl bg-blue-950/60 border border-blue-500/30 hover:bg-blue-900/60 flex items-center justify-between transition-all"
                  >
                    <span className="text-xs font-semibold text-blue-200 truncate">{match.team1.short || "T1"}</span>
                    <span className="text-xs font-extrabold text-blue-400">Back {match.back1?.toFixed(2) || "1.85"}</span>
                  </button>
                  <button
                    onClick={() => setSelectedMatchId(match.eventId)}
                    className="py-2 px-3 rounded-xl bg-pink-950/60 border border-pink-500/30 hover:bg-pink-900/60 flex items-center justify-between transition-all"
                  >
                    <span className="text-xs font-semibold text-pink-200 truncate">{match.team2.short || "T2"}</span>
                    <span className="text-xs font-extrabold text-pink-400">Back {match.back2?.toFixed(2) || "2.05"}</span>
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
