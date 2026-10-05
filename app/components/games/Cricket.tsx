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

const SPORTS_TABS: Array<{ id: SportType; label: string; icon: string }> = [
  { id: "cricket", label: "Cricket", icon: "🏏" },
  { id: "soccer", label: "Football", icon: "⚽" },
  { id: "tennis", label: "Tennis", icon: "🎾" },
];

export function Cricket({ nav, matchId }: { nav: Nav; matchId?: string }) {
  const { total, debit, credit, showToast } = useStore();
  const [selectedSport, setSelectedSport] = useState<SportType>("cricket");
  const [matches, setMatches] = useState<CricketMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(matchId || null);
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

  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
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
  }, [matches, searchQuery]);

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
  // RENDER: Match Detail / Live Arena View
  // -------------------------------------------------------------
  if (selectedMatchId && activeMatch) {
    const matchBets = myBets.filter((b) => b.eventId === selectedMatchId);
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

        {/* Media Toggle Bar */}
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

        {/* Embedded Live Media Frame */}
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

        {/* Betting Markets */}
        <div className="px-4 space-y-4">
          {/* Match Odds Table */}
          <div className="rounded-2xl bg-[#0f172a] border border-white/10 overflow-hidden shadow-xl">
            <div className="px-4 py-2.5 bg-[#1e293b] flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                <span className="font-bold text-sm">Match Odds (Exchange)</span>
              </div>
              <span className="text-[10px] text-white/50">Max: 🪙 5,00,000</span>
            </div>

            <div className="grid grid-cols-12 px-3 py-1.5 bg-black/40 text-[11px] font-bold text-white/70 border-b border-white/5 text-center">
              <div className="col-span-6 text-left pl-1">Selection</div>
              <div className="col-span-3 text-blue-400 bg-blue-950/40 rounded py-0.5">BACK (Lagai)</div>
              <div className="col-span-3 text-pink-400 bg-pink-950/40 rounded py-0.5">LAY (Khai)</div>
            </div>

            <div className="divide-y divide-white/5">
              {[
                { name: activeMatch.team1.name, back: activeMatch.back1 || 1.85, lay: activeMatch.lay1 || 1.89, volB: "1.5L", volL: "1.2L" },
                { name: activeMatch.team2.name, back: activeMatch.back2 || 2.05, lay: activeMatch.lay2 || 2.12, volB: "95K", volL: "1.1L" },
              ].map((runner, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center p-2.5 gap-2 hover:bg-white/[0.02]">
                  <div className="col-span-6 font-semibold text-sm pl-1 truncate">{runner.name}</div>
                  <button
                    onClick={() => openBet("MATCH_ODDS", "Match Odds", runner.name, "BACK", runner.back)}
                    className="col-span-3 py-2 rounded-xl bg-[#72bbef] hover:bg-blue-400 text-slate-950 font-extrabold active:scale-95 transition-all text-center shadow-md"
                  >
                    <div className="text-sm font-black leading-none">{runner.back.toFixed(2)}</div>
                    <div className="text-[9px] text-slate-800 mt-0.5 font-bold">{runner.volB}</div>
                  </button>
                  <button
                    onClick={() => openBet("MATCH_ODDS", "Match Odds", runner.name, "LAY", runner.lay)}
                    className="col-span-3 py-2 rounded-xl bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-extrabold active:scale-95 transition-all text-center shadow-md"
                  >
                    <div className="text-sm font-black leading-none">{runner.lay.toFixed(2)}</div>
                    <div className="text-[9px] text-slate-800 mt-0.5 font-bold">{runner.volL}</div>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Bookmaker Odds */}
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
                    className="col-span-3 py-2 rounded-xl bg-[#72bbef] text-slate-950 font-extrabold active:scale-95 transition-all text-center"
                  >
                    <div className="text-sm font-black">{bm.back}</div>
                    <div className="text-[9px] text-slate-800 font-bold">100K</div>
                  </button>
                  <button
                    onClick={() => openBet("BOOKMAKER", "Bookmaker Odds", bm.name, "LAY", (1 + bm.lay / 100))}
                    className="col-span-3 py-2 rounded-xl bg-[#faa9ba] text-slate-950 font-extrabold active:scale-95 transition-all text-center"
                  >
                    <div className="text-sm font-black">{bm.lay}</div>
                    <div className="text-[9px] text-slate-800 font-bold">100K</div>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Fancy Sessions */}
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
                      className="col-span-3 py-2 rounded-xl bg-[#faa9ba] text-slate-950 font-extrabold active:scale-95 transition-all text-center"
                    >
                      <div className="text-sm font-black">{fancy.no}</div>
                      <div className="text-[9px] text-slate-800 font-bold">{fancy.rate}</div>
                    </button>
                    <button
                      onClick={() => openBet("FANCY", fancy.name, `${fancy.name} (YES: ${fancy.yes})`, "BACK", 2.0, fancy.yes)}
                      className="col-span-3 py-2 rounded-xl bg-[#72bbef] text-slate-950 font-extrabold active:scale-95 transition-all text-center"
                    >
                      <div className="text-sm font-black">{fancy.yes}</div>
                      <div className="text-[9px] text-slate-800 font-bold">{fancy.rate}</div>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Bet Slip */}
        {betSlip && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center p-0 md:p-4 fadein">
            <div
              className={`w-full max-w-md rounded-t-3xl md:rounded-3xl p-5 border shadow-2xl transition-all ${
                betSlip.betType === "BACK"
                  ? "bg-[#0b1c3d] border-blue-500/40"
                  : "bg-[#2d0e23] border-pink-500/40"
              }`}
            >
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
  // RENDER: Exchange Lobby View (Exact Standard OExch / DiamondExch 1 | X | 2 Grid Table)
  // -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#070b19] text-white pb-28 fadein">
      {/* Top Header */}
      <Header
        title="Sports Exchange"
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

      {/* 1. TOP LIVE IN-PLAY TICKER (Scrolling highlights chips like OExch) */}
      <div className="px-3 py-2 bg-[#0a0f24] border-b border-white/10 overflow-x-auto no-scrollbar flex items-center gap-2">
        {matches.filter((m) => m.inPlay || m.isLive).map((m) => (
          <button
            key={m.eventId}
            onClick={() => setSelectedMatchId(m.eventId)}
            className="px-3 py-1.5 rounded-full bg-[#1e293b] border border-white/10 hover:border-emerald-500/50 flex items-center gap-2 text-xs font-semibold whitespace-nowrap active:scale-95 transition-all shrink-0 shadow-sm"
          >
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <span className="text-white/90 truncate max-w-[180px]">{m.eventName}</span>
          </button>
        ))}
      </div>

      {/* 2. TOP SPORTS SELECTOR BAR (Cricket | Football | Tennis) */}
      <div className="px-3 pt-2.5 pb-1 flex items-center justify-between overflow-x-auto no-scrollbar border-b border-white/10 bg-[#0c122c]">
        <div className="flex items-center gap-1.5">
          {SPORTS_TABS.map((sport) => {
            const isSelected = selectedSport === sport.id;
            return (
              <button
                key={sport.id}
                onClick={() => {
                  sfx.click();
                  setSelectedSport(sport.id);
                }}
                className={`px-4 py-2.5 rounded-t-xl text-xs font-extrabold flex items-center gap-1.5 transition-all border-t border-x ${
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
            onClick={() => setMediaMode("none")} // dummy trigger to keep clean
            className="px-2.5 py-1 rounded-lg bg-rose-600/90 text-white text-[11px] font-black uppercase flex items-center gap-1 shadow-sm"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            In-Play ({matches.filter((m) => m.inPlay || m.isLive).length})
          </button>
          <span className="text-[11px] text-white/50 font-bold">
            Upcoming ({matches.filter((m) => !m.inPlay && !m.isLive).length})
          </span>
        </div>
        <div className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
          <Activity size={12} /> Auto-refresh Live
        </div>
      </div>

      {/* Search Input */}
      <div className="px-3 py-2 bg-[#0b1029]">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${selectedSport} match or tournament...`}
            className="w-full pl-8 pr-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-white/40 focus:outline-none focus:border-emerald-400"
          />
        </div>
      </div>

      {/* 3. EXCHANGE MATCHES TABLE (1 | X | 2 Back/Lay Grid) */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          {/* Table Column Headers */}
          <thead>
            <tr className="bg-[#0f172a] text-white/70 border-b border-white/10 text-[11px] font-bold">
              <th className="py-2.5 px-3 font-bold">Game</th>
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
            {filteredMatches.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-white/50 text-xs">
                  No active {selectedSport} matches found.
                </td>
              </tr>
            ) : (
              filteredMatches.map((match) => {
                const formattedDate = new Date(match.eventTime).toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                });

                return (
                  <tr key={match.eventId} className="hover:bg-white/[0.03] transition-colors">
                    {/* Game Column (Match Name + Icons + Time) */}
                    <td className="py-2 px-3 align-middle max-w-[220px]">
                      <div
                        onClick={() => setSelectedMatchId(match.eventId)}
                        className="cursor-pointer group"
                      >
                        <div className="font-bold text-white text-xs group-hover:text-emerald-300 transition-colors leading-tight">
                          {match.eventName}
                        </div>
                        <div className="text-[10px] text-white/50 mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span>/ {formattedDate}</span>
                        </div>
                        {/* Feature Badges (🟢, 📺, f, BM) */}
                        <div className="flex items-center gap-1.5 mt-1">
                          {match.inPlay || match.isLive ? (
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse inline-block" title="In-Play Live" />
                          ) : null}
                          <span title="Live TV Stream Available"><Tv size={12} className="text-blue-400 inline-block" /></span>
                          <span className="px-1 py-0.2 rounded text-[9px] font-black italic bg-purple-950 text-purple-300 border border-purple-800/40">
                            f
                          </span>
                          <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-amber-950 text-amber-300 border border-amber-800/40">
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
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team1.name, "BACK", match.back1 || 1.85)}
                        className="w-full h-9 rounded bg-[#72bbef] hover:bg-blue-300 text-slate-950 font-black text-xs grid place-items-center shadow-sm active:scale-95 transition-transform"
                      >
                        {match.back1?.toFixed(2) || "1.85"}
                      </button>
                    </td>
                    {/* 1 - Lay (Pink) */}
                    <td className="py-1 px-1 text-center w-[54px]">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team1.name, "LAY", match.lay1 || 1.89)}
                        className="w-full h-9 rounded bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-black text-xs grid place-items-center shadow-sm active:scale-95 transition-transform"
                      >
                        {match.lay1?.toFixed(2) || "1.89"}
                      </button>
                    </td>

                    {/* X - Back (Blue) */}
                    <td className="py-1 px-1 text-center w-[44px] border-l border-white/5">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", "Draw / Tie", "BACK", 3.50)}
                        className="w-full h-9 rounded bg-[#72bbef]/30 text-white/80 font-bold text-xs grid place-items-center hover:bg-[#72bbef] hover:text-slate-950 active:scale-95 transition-transform"
                      >
                        {match.sport === "soccer" ? "3.50" : "-"}
                      </button>
                    </td>
                    {/* X - Lay (Pink) */}
                    <td className="py-1 px-1 text-center w-[44px]">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", "Draw / Tie", "LAY", 3.65)}
                        className="w-full h-9 rounded bg-[#faa9ba]/30 text-white/80 font-bold text-xs grid place-items-center hover:bg-[#faa9ba] hover:text-slate-950 active:scale-95 transition-transform"
                      >
                        {match.sport === "soccer" ? "3.65" : "-"}
                      </button>
                    </td>

                    {/* 2 - Back (Blue) */}
                    <td className="py-1 px-1 text-center w-[54px] border-l border-white/5">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team2.name, "BACK", match.back2 || 2.05)}
                        className="w-full h-9 rounded bg-[#72bbef] hover:bg-blue-300 text-slate-950 font-black text-xs grid place-items-center shadow-sm active:scale-95 transition-transform"
                      >
                        {match.back2?.toFixed(2) || "2.05"}
                      </button>
                    </td>
                    {/* 2 - Lay (Pink) */}
                    <td className="py-1 px-1 text-center w-[54px]">
                      <button
                        onClick={() => openBet("MATCH_ODDS", "Match Odds", match.team2.name, "LAY", match.lay2 || 2.12)}
                        className="w-full h-9 rounded bg-[#faa9ba] hover:bg-pink-300 text-slate-950 font-black text-xs grid place-items-center shadow-sm active:scale-95 transition-transform"
                      >
                        {match.lay2?.toFixed(2) || "2.12"}
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
