"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  Crown,
  Flame,
  Gamepad2,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  Sliders,
  Trash2,
  UserCheck,
  UserX,
  Users,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { GAMES, type GameId } from "../lib/data";
import { GameIcon } from "../components/GameArt";
import { ROLE_LABEL, coins, type Account, type Role } from "../lib/hierarchy";
import { errText, supabase } from "../lib/supabase";

export type OutcomeMode = "fair" | "force_win" | "force_loss";

interface OutcomeControlData {
  global_mode: OutcomeMode;
  games: Record<string, OutcomeMode>;
  players: Record<string, OutcomeMode>;
  agents?: Record<string, OutcomeMode>;
  admins?: Record<string, OutcomeMode>;
}

interface TargetAccountInfo {
  name: string;
  code: string;
  phone: string | null;
  username?: string | null;
  role: string;
  mode: OutcomeMode;
}

const GAME_CONTROL_DETAILS: Record<string, { lossNote: string; winNote: string }> = {
  aviator: {
    lossNote: "Plane crashes instantly at 1.00x – 1.04x (all player bets lost)",
    winNote: "Plane flies high to 15x – 45x for big player wins",
  },
  "dragon-tiger": {
    lossNote: "Cards drawn to yield 0 payout against player's bets",
    winNote: "Player's chosen side (Dragon/Tiger) wins with high rank",
  },
  "andar-bahar": {
    lossNote: "Matching card lands on opposite side (100% house win)",
    winNote: "Matching card lands on player's chosen side (100% player win)",
  },
  "lucky-7": {
    lossNote: "Card drawn yields 0 payout across all low/high/side bets",
    winNote: "Card drawn yields maximum positive return to player",
  },
  roulette: {
    lossNote: "Wheel lands on number giving 0 payout for all placed chips",
    winNote: "Wheel lands on player's straight or outside winning bets",
  },
  blackjack: {
    lossNote: "Dealer dealt Natural 21 or 20; player dealt stiff hand (16)",
    winNote: "Player dealt Natural Blackjack (Ace + King) for instant 2.5x payout",
  },
  plinko: {
    lossNote: "Ball guided straight into lowest 0.2x center slot",
    winNote: "Ball guided into high-multiplier outer edge slots (5x – 29x)",
  },
  "teen-patti": {
    lossNote: "Bots/house get winning Trail or Sequence; player gets low cards",
    winNote: "Player dealt Trio (AAA) or Pure Sequence; bots fold/lose",
  },
  rummy: {
    lossNote: "Bot difficulty maximized; player gets uncoordinated hand",
    winNote: "Player dealt clean sequences/sets for easy early declaration",
  },
  ludo: {
    lossNote: "AI bots roll strategically; win claim rejected on force loss",
    winNote: "AI bots blunder; player receives favorable dice rolls",
  },
  chess: {
    lossNote: "AI bot plays Grandmaster depth; win claim rejected on loss",
    winNote: "AI bot plays at beginner depth with blunder openings",
  },
  poker: {
    lossNote: "AI opponents dealt top pairs and flushes; win claim rejected",
    winNote: "Player dealt premium pocket pairs and nuts on the river",
  },
};

export function OutcomeControlView({ me, accounts }: { me: Account; accounts: Account[] }) {
  const [data, setData] = useState<OutcomeControlData>({
    global_mode: "fair",
    games: {},
    players: {},
    agents: {},
    admins: {},
  });
  const [targetsInfo, setTargetsInfo] = useState<Record<string, TargetAccountInfo>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Tab filter for targeted list
  const [targetTab, setTargetTab] = useState<"all" | "player" | "agent" | "admin">("all");

  // Account search & targeting modal
  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [modalRoleFilter, setModalRoleFilter] = useState<"all" | "player" | "agent" | "admin">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const showToast = (text: string, type: "success" | "error" = "success") => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), 4000);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: s } = await supabase().auth.getSession();
      const token = s.session?.access_token;
      if (!token) throw new Error("Please sign in again");

      const res = await fetch("/api/outcome-control", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load outcome settings");

      if (json.outcome_control) {
        setData(json.outcome_control);
      }
      if (json.targets_info || json.players_info) {
        setTargetsInfo(json.targets_info || json.players_info);
      }
    } catch (e) {
      console.error("Load error:", e);
      const { data: row } = await supabase().from("app_settings").select("value").eq("key", "outcome_control").maybeSingle();
      if (row?.value) {
        setData(row.value as OutcomeControlData);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const updateOutcome = async (payload: {
    global_mode?: OutcomeMode;
    game?: string;
    game_mode?: OutcomeMode;
    account_id?: string;
    player_id?: string;
    account_mode?: OutcomeMode;
    player_mode?: OutcomeMode;
    role?: "player" | "agent" | "admin";
    clear_account_id?: string;
    clear_player_id?: string;
  }, keyIdentifier: string) => {
    setSavingKey(keyIdentifier);
    try {
      const { data: s } = await supabase().auth.getSession();
      const token = s.session?.access_token;
      if (!token) throw new Error("Please sign in again");

      const res = await fetch("/api/outcome-control", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update outcome control");

      if (json.outcome_control) {
        setData(json.outcome_control);
      }

      if (payload.global_mode) {
        showToast(
          payload.global_mode === "force_loss"
            ? "🔴 Global Command: 100% House Win (All Players Lose) is now ACTIVE!"
            : payload.global_mode === "force_win"
            ? "🟢 Global Command: Player Win Mode is now ACTIVE!"
            : "⚖️ Global Command: Fair RNG Mode restored!",
          "success"
        );
      } else if (payload.game && payload.game_mode) {
        const gName = GAMES.find((x) => x.id === payload.game)?.name || payload.game;
        showToast(
          payload.game_mode === "force_loss"
            ? `🔴 ${gName}: Force Loss (House Win) ACTIVE!`
            : payload.game_mode === "force_win"
            ? `🟢 ${gName}: Force Win ACTIVE!`
            : `⚖️ ${gName}: Set to Fair RNG`,
          "success"
        );
      } else if ((payload.account_id || payload.player_id) && (payload.account_mode || payload.player_mode)) {
        const accName = selectedAccount?.name || "Account";
        const roleLbl = selectedAccount ? ROLE_LABEL[selectedAccount.role] : "Account";
        const targetMode = payload.account_mode || payload.player_mode;
        showToast(`Target updated for ${roleLbl} "${accName}": ${targetMode === "force_loss" ? "🔴 Always Lose" : targetMode === "force_win" ? "🟢 Always Win" : "⚖️ Normal"}`, "success");
        loadData();
      } else if (payload.clear_account_id || payload.clear_player_id) {
        showToast("Target override removed", "success");
        loadData();
      }
    } catch (e) {
      showToast(errText(e), "error");
    } finally {
      setSavingKey(null);
    }
  };

  const handleGlobalChange = (mode: OutcomeMode) => {
    updateOutcome({ global_mode: mode }, "global");
  };

  const handleGameChange = (gameId: string, mode: OutcomeMode) => {
    updateOutcome({ game: gameId, game_mode: mode }, `game_${gameId}`);
  };

  const handleApplyPreset = (mode: OutcomeMode) => {
    updateOutcome({ global_mode: mode }, "preset");
    GAMES.forEach((g) => {
      updateOutcome({ game: g.id, game_mode: mode }, `game_${g.id}`);
    });
  };

  // Build full targeted accounts list
  const targetedList = useMemo(() => {
    const list: {
      id: string;
      name: string;
      code: string;
      phone: string | null;
      username?: string | null;
      role: Role;
      mode: OutcomeMode;
      downlineCount?: number;
    }[] = [];

    const pKeys = Object.keys(data.players || {});
    for (const pid of pKeys) {
      const mode = data.players[pid];
      const acc = accounts.find((a) => a.id === pid);
      const info = targetsInfo[pid];
      list.push({
        id: pid,
        name: acc?.name || info?.name || "Player " + pid.slice(0, 6),
        code: acc?.code || info?.code || pid.slice(0, 6),
        phone: acc?.phone || info?.phone || null,
        username: acc?.username || info?.username || null,
        role: "player",
        mode,
      });
    }

    const agKeys = Object.keys(data.agents || {});
    for (const agId of agKeys) {
      const mode = data.agents![agId];
      const acc = accounts.find((a) => a.id === agId);
      const info = targetsInfo[agId];
      const downlinePlayers = accounts.filter((a) => a.parentId === agId && a.role === "player").length;
      list.push({
        id: agId,
        name: acc?.name || info?.name || "Agent " + agId.slice(0, 6),
        code: acc?.code || info?.code || agId.slice(0, 6),
        phone: acc?.phone || info?.phone || null,
        username: acc?.username || info?.username || null,
        role: "agent",
        mode,
        downlineCount: downlinePlayers,
      });
    }

    const adKeys = Object.keys(data.admins || {});
    for (const adId of adKeys) {
      const mode = data.admins![adId];
      const acc = accounts.find((a) => a.id === adId);
      const info = targetsInfo[adId];
      const downlineCount = accounts.filter((a) => a.parentId === adId).length;
      list.push({
        id: adId,
        name: acc?.name || info?.name || "Admin " + adId.slice(0, 6),
        code: acc?.code || info?.code || adId.slice(0, 6),
        phone: acc?.phone || info?.phone || null,
        username: acc?.username || info?.username || null,
        role: "admin",
        mode,
        downlineCount,
      });
    }

    return list;
  }, [data.players, data.agents, data.admins, accounts, targetsInfo]);

  // Filtered targets by tab
  const displayedTargets = useMemo(() => {
    if (targetTab === "all") return targetedList;
    return targetedList.filter((t) => t.role === targetTab);
  }, [targetedList, targetTab]);

  // Filter search accounts in modal
  const filteredSearchAccounts = useMemo(() => {
    if (!searchQuery.trim() && modalRoleFilter === "all") return accounts.slice(0, 8);
    const q = searchQuery.toLowerCase().trim();
    return accounts
      .filter((a) => a.role !== "superadmin")
      .filter((a) => modalRoleFilter === "all" || a.role === modalRoleFilter)
      .filter((a) =>
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.code.toLowerCase().includes(q) ||
        (a.phone && a.phone.includes(q)) ||
        (a.username && a.username.toLowerCase().includes(q))
      )
      .slice(0, 10);
  }, [accounts, searchQuery, modalRoleFilter]);

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMsg && (
        <div
          className={`fixed top-4 right-4 z-50 px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-md border animate-in slide-in-from-top-4 ${
            toastMsg.type === "success"
              ? "bg-emerald-950/90 border-emerald-500/50 text-emerald-200"
              : "bg-rose-950/90 border-rose-500/50 text-rose-200"
          }`}
        >
          {toastMsg.type === "success" ? <CheckCircle2 size={18} className="text-emerald-400" /> : <AlertTriangle size={18} className="text-rose-400" />}
          <span className="text-sm font-medium">{toastMsg.text}</span>
          <button onClick={() => setToastMsg(null)} className="ml-2 text-white/50 hover:text-white"><X size={14} /></button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-gradient-to-br from-amber-400 to-rose-500 text-black">
              <Sliders size={22} />
            </span>
            <h1 className="text-2xl font-bold tracking-tight">Game Win / Loss Control</h1>
            <span className="rounded-full bg-neon-400/10 border border-neon-400/30 text-neon-400 text-[11px] font-semibold px-2.5 py-0.5 uppercase tracking-wider">
              Super Admin Master Command
            </span>
          </div>
          <p className="text-sm text-white/60 mt-1">
            Poora command aapke haath me hai — kisi bhi game, player, agent ya admin ko 100% jeet (Win) ya haar (Loss) par set karein.
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="btn-ghost rounded-xl px-3 py-2 text-xs inline-flex items-center gap-2 self-start sm:self-auto"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* SECTION 1: MASTER GLOBAL OUTCOME COMMAND */}
      <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#111740] to-[#0a0f2c] p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-neon-500/5 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-white/10">
          <div>
            <div className="text-xs uppercase font-bold tracking-wider text-neon-400 flex items-center gap-1.5">
              <Crown size={14} /> Master Global Switch
            </div>
            <div className="text-lg font-bold text-white mt-1">Global Game Outcome Command</div>
            <div className="text-xs text-white/60 mt-0.5">
              Affects all games instantly unless a game or target account (Player/Agent/Admin) has an individual override.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-white/50">Current Status:</span>
            <span
              className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 ${
                data.global_mode === "force_loss"
                  ? "bg-rose-500/20 border-rose-500 text-rose-400 animate-pulse"
                  : data.global_mode === "force_win"
                  ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                  : "bg-blue-500/20 border-blue-500/40 text-blue-300"
              }`}
            >
              {data.global_mode === "force_loss" && "🔴 100% House Win (Force Player Loss)"}
              {data.global_mode === "force_win" && "🟢 Player Win Mode (Favor Players)"}
              {data.global_mode === "fair" && "⚖️ Fair Play (Normal RNG)"}
            </span>
          </div>
        </div>

        {/* 3 Master Switches */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-5">
          {/* Force Loss (House Win) */}
          <button
            onClick={() => handleGlobalChange("force_loss")}
            disabled={savingKey === "global"}
            className={`text-left p-5 rounded-xl border transition-all relative overflow-hidden group ${
              data.global_mode === "force_loss"
                ? "bg-rose-950/40 border-rose-500 shadow-[0_0_25px_rgba(244,63,94,0.35)]"
                : "bg-white/[0.03] border-white/10 hover:border-rose-500/50 hover:bg-rose-950/20"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 grid place-items-center text-rose-400">
                <ShieldAlert size={20} />
              </span>
              {data.global_mode === "force_loss" && (
                <span className="bg-rose-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Active
                </span>
              )}
            </div>
            <div className="font-bold text-white text-base mt-3 group-hover:text-rose-400 transition-colors">
              🔴 Force Player Loss (House Win)
            </div>
            <div className="text-xs text-white/60 mt-1.5 leading-relaxed">
              Sabhi games me players haarenge. Aviator 1.00x par crash hoga, Roulette/Casino me 0 payout milega. Paisa house ke paas rahega.
            </div>
          </button>

          {/* Fair RNG */}
          <button
            onClick={() => handleGlobalChange("fair")}
            disabled={savingKey === "global"}
            className={`text-left p-5 rounded-xl border transition-all relative overflow-hidden group ${
              data.global_mode === "fair"
                ? "bg-blue-950/40 border-blue-400 shadow-[0_0_25px_rgba(96,165,250,0.3)]"
                : "bg-white/[0.03] border-white/10 hover:border-blue-400/50 hover:bg-blue-950/20"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/40 grid place-items-center text-blue-400">
                <Sliders size={20} />
              </span>
              {data.global_mode === "fair" && (
                <span className="bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Active
                </span>
              )}
            </div>
            <div className="font-bold text-white text-base mt-3 group-hover:text-blue-400 transition-colors">
              ⚖️ Fair Mode (Normal RNG)
            </div>
            <div className="text-xs text-white/60 mt-1.5 leading-relaxed">
              Standard mathematical probability and normal house edge. Koi outcome rigging nahi hogi, standard random gameplay chalega.
            </div>
          </button>

          {/* Force Player Win */}
          <button
            onClick={() => handleGlobalChange("force_win")}
            disabled={savingKey === "global"}
            className={`text-left p-5 rounded-xl border transition-all relative overflow-hidden group ${
              data.global_mode === "force_win"
                ? "bg-emerald-950/40 border-emerald-500 shadow-[0_0_25px_rgba(16,185,129,0.35)]"
                : "bg-white/[0.03] border-white/10 hover:border-emerald-500/50 hover:bg-emerald-950/20"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 grid place-items-center text-emerald-400">
                <Zap size={20} />
              </span>
              {data.global_mode === "force_win" && (
                <span className="bg-emerald-500 text-black text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Active
                </span>
              )}
            </div>
            <div className="font-bold text-white text-base mt-3 group-hover:text-emerald-400 transition-colors">
              🟢 Force Player Win (Favor Players)
            </div>
            <div className="text-xs text-white/60 mt-1.5 leading-relaxed">
              Players ko high payouts milenge. Aviator 15x–45x udhega, Dragon Tiger aur Roulette me winning bets aayengi.
            </div>
          </button>
        </div>

        {/* Quick Batch Presets */}
        <div className="mt-5 pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-white/50 flex items-center gap-1.5">
            <Flame size={14} className="text-amber-400" /> One-Click Batch Presets:
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleApplyPreset("force_loss")}
              className="px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/20 font-medium"
            >
              Set All Games to 🔴 Force Loss
            </button>
            <button
              onClick={() => handleApplyPreset("fair")}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/80 border border-white/10 font-medium"
            >
              Reset All to ⚖️ Fair RNG
            </button>
            <button
              onClick={() => handleApplyPreset("force_win")}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 font-medium"
            >
              Set All Games to 🟢 Force Win
            </button>
          </div>
        </div>
      </div>

      {/* SECTION 2: TARGETED ACCOUNTS (PLAYERS, AGENTS & ADMINS) */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1335] p-6 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-white/10">
          <div>
            <div className="text-xs uppercase font-bold tracking-wider text-amber-400 flex items-center gap-1.5">
              <Users size={14} /> Targeted Accounts Control (Player, Agent & Admin)
            </div>
            <div className="text-base font-bold text-white mt-1">Specific Player, Agent & Admin Win / Loss Control</div>
            <div className="text-xs text-white/60">
              Kisi specific Player, Agent ya Admin par Win ya Loss lock karein. Agent ya Admin par set karne se unke downline ke sabhi players par ye command apply hoga.
            </div>
          </div>
          <button
            onClick={() => setTargetModalOpen(true)}
            className="btn-green rounded-xl px-4 py-2 text-xs inline-flex items-center gap-1.5 self-start sm:self-auto shadow-lg"
          >
            <Wand2 size={14} /> + Add Target (Player / Agent / Admin)
          </button>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-2 mt-4 overflow-x-auto no-scrollbar pb-1">
          <button
            onClick={() => setTargetTab("all")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
              targetTab === "all" ? "bg-white/20 text-white font-bold" : "bg-white/5 text-white/60 hover:text-white"
            }`}
          >
            All Targets ({targetedList.length})
          </button>
          <button
            onClick={() => setTargetTab("player")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              targetTab === "player" ? "bg-white/20 text-white font-bold" : "bg-white/5 text-white/60 hover:text-white"
            }`}
          >
            <Users size={13} /> Players ({targetedList.filter((t) => t.role === "player").length})
          </button>
          <button
            onClick={() => setTargetTab("agent")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              targetTab === "agent" ? "bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30" : "bg-white/5 text-white/60 hover:text-white"
            }`}
          >
            <Briefcase size={13} /> Agents ({targetedList.filter((t) => t.role === "agent").length})
          </button>
          <button
            onClick={() => setTargetTab("admin")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              targetTab === "admin" ? "bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30" : "bg-white/5 text-white/60 hover:text-white"
            }`}
          >
            <Crown size={13} /> Admins ({targetedList.filter((t) => t.role === "admin").length})
          </button>
        </div>

        {/* Active targeted accounts list */}
        {displayedTargets.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
            {displayedTargets.map((tp) => (
              <div
                key={tp.id}
                className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${
                  tp.mode === "force_loss"
                    ? "bg-rose-950/20 border-rose-500/40"
                    : "bg-emerald-950/20 border-emerald-500/40"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
                        tp.role === "admin"
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                          : tp.role === "agent"
                          ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                          : "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                      }`}
                    >
                      {tp.role === "admin" ? "👑 Admin" : tp.role === "agent" ? "💼 Agent" : "🧑 Player"}
                    </span>
                    <span className="font-semibold text-sm truncate text-white">
                      {tp.name}
                    </span>
                  </div>

                  <div className="text-xs text-white/50 mt-1 flex items-center gap-2">
                    <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded text-[11px]">{tp.code}</span>
                    <span>{tp.phone || tp.username || "—"}</span>
                  </div>

                  {tp.role !== "player" && typeof tp.downlineCount === "number" && (
                    <div className="text-[11px] text-amber-400/90 mt-1 font-medium">
                      Downline: {tp.downlineCount} accounts affected
                    </div>
                  )}

                  <div className="mt-2 flex items-center gap-1.5">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                        tp.mode === "force_loss"
                          ? "bg-rose-500/20 border-rose-500 text-rose-300"
                          : "bg-emerald-500/20 border-emerald-500 text-emerald-300"
                      }`}
                    >
                      {tp.mode === "force_loss"
                        ? tp.role === "player"
                          ? "🔴 Always Loses (House Beats Player)"
                          : "🔴 Downline Always Loses"
                        : tp.role === "player"
                        ? "🟢 Always Wins (Rigged to Win)"
                        : "🟢 Downline Always Wins"}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() =>
                      updateOutcome(
                        {
                          account_id: tp.id,
                          account_mode: tp.mode === "force_loss" ? "force_win" : "force_loss",
                          role: tp.role as "player" | "agent" | "admin",
                        },
                        `toggle_${tp.id}`
                      )
                    }
                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white text-xs"
                    title="Toggle Win/Loss"
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    onClick={() => updateOutcome({ clear_account_id: tp.id }, `del_${tp.id}`)}
                    className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs"
                    title="Remove Override (Reset to Normal)"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-white/40 text-xs mt-2 border border-dashed border-white/10 rounded-xl">
            {targetTab === "all"
              ? "Abhi koi Player, Agent ya Admin target control me nahi hai. Sabhi accounts Global/Game settings follow kar rahe hain."
              : `Abhi koi ${targetTab === "admin" ? "Admin" : targetTab === "agent" ? "Agent" : "Player"} target control me nahi hai.`}
            <div className="mt-2">
              <button
                onClick={() => {
                  setModalRoleFilter(targetTab);
                  setTargetModalOpen(true);
                }}
                className="text-neon-400 hover:underline font-medium"
              >
                + Add target {targetTab === "all" ? "account" : targetTab} now
              </button>
            </div>
          </div>
        )}
      </div>

      {/* SECTION 3: PER-GAME OUTCOME CONTROL MATRIX */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-bold text-white flex items-center gap-2">
              <Gamepad2 size={18} className="text-neon-400" /> Per-Game Outcome Matrix
            </div>
            <div className="text-xs text-white/60">
              Each game can be set independently. If set to &quot;Fair&quot;, it follows the Master Global setting.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {GAMES.map((g) => {
            const specificMode = data.games[g.id];
            const effectiveMode = specificMode || data.global_mode;
            const details = GAME_CONTROL_DETAILS[g.id] || {
              lossNote: "Rigged to favor the house (0 payout or bot dominance)",
              winNote: "Rigged to reward player with maximum payouts",
            };
            const isSaving = savingKey === `game_${g.id}`;

            return (
              <div
                key={g.id}
                className={`card p-5 relative overflow-hidden transition-all border ${
                  effectiveMode === "force_loss"
                    ? "border-rose-500/40 bg-gradient-to-br from-[#120a1f] to-[#150d26]"
                    : effectiveMode === "force_win"
                    ? "border-emerald-500/40 bg-gradient-to-br from-[#0a171d] to-[#0c1c24]"
                    : "border-white/10 bg-[#0d1335]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-11 h-11 rounded-xl grid place-items-center overflow-hidden shrink-0 shadow"
                    style={{ background: `linear-gradient(160deg,${g.from},${g.to})` }}
                  >
                    <div className="scale-75"><GameIcon id={g.id} /></div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm text-white truncate">{g.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          effectiveMode === "force_loss"
                            ? "bg-rose-500/20 border-rose-500 text-rose-300"
                            : effectiveMode === "force_win"
                            ? "bg-emerald-500/20 border-emerald-500 text-emerald-300"
                            : "bg-blue-500/20 border-blue-500/40 text-blue-300"
                        }`}
                      >
                        {effectiveMode === "force_loss" && "🔴 Force Loss"}
                        {effectiveMode === "force_win" && "🟢 Force Win"}
                        {effectiveMode === "fair" && "⚖️ Fair (RNG)"}
                      </span>
                      {specificMode && (
                        <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">
                          Override
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Outcome note */}
                <div className="text-[11px] text-white/50 mt-3 h-8 line-clamp-2 leading-relaxed">
                  {effectiveMode === "force_loss"
                    ? details.lossNote
                    : effectiveMode === "force_win"
                    ? details.winNote
                    : "Standard mathematical odds and random outcomes."}
                </div>

                {/* 3 Segmented Command Buttons */}
                <div className="grid grid-cols-3 gap-1.5 mt-4 p-1 rounded-xl bg-black/40 border border-white/5">
                  <button
                    onClick={() => handleGameChange(g.id, "fair")}
                    disabled={isSaving}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium transition-colors text-center ${
                      specificMode === "fair" || (!specificMode && data.global_mode === "fair")
                        ? "bg-blue-500 text-white shadow"
                        : "text-white/60 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    ⚖️ Fair
                  </button>
                  <button
                    onClick={() => handleGameChange(g.id, "force_win")}
                    disabled={isSaving}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium transition-colors text-center ${
                      specificMode === "force_win"
                        ? "bg-emerald-500 text-black font-bold shadow"
                        : "text-white/60 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    🟢 Win
                  </button>
                  <button
                    onClick={() => handleGameChange(g.id, "force_loss")}
                    disabled={isSaving}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium transition-colors text-center ${
                      specificMode === "force_loss"
                        ? "bg-rose-500 text-white font-bold shadow"
                        : "text-white/60 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    🔴 Loss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* MODAL: ADD / EDIT TARGET (PLAYER / AGENT / ADMIN) */}
      {targetModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-4"
          onClick={() => setTargetModalOpen(false)}
        >
          <div
            className="card w-full max-w-lg p-6 bg-[#0e1438] border border-white/15 rounded-2xl shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-amber-500/20 text-amber-400">
                  <Wand2 size={18} />
                </span>
                <div>
                  <div className="font-bold text-base text-white">Target Account Win / Loss</div>
                  <div className="text-xs text-white/50">Select a Player, Agent or Admin to command their game outcomes</div>
                </div>
              </div>
              <button
                onClick={() => setTargetModalOpen(false)}
                className="text-white/50 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Role filter chips */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/50">Filter Role:</span>
              <button
                type="button"
                onClick={() => setModalRoleFilter("all")}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                  modalRoleFilter === "all" ? "bg-white/20 text-white font-bold" : "bg-white/5 text-white/50 hover:text-white"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setModalRoleFilter("player")}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                  modalRoleFilter === "player" ? "bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30" : "bg-white/5 text-white/50 hover:text-white"
                }`}
              >
                🧑 Players
              </button>
              <button
                type="button"
                onClick={() => setModalRoleFilter("agent")}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                  modalRoleFilter === "agent" ? "bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30" : "bg-white/5 text-white/50 hover:text-white"
                }`}
              >
                💼 Agents
              </button>
              <button
                type="button"
                onClick={() => setModalRoleFilter("admin")}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                  modalRoleFilter === "admin" ? "bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30" : "bg-white/5 text-white/50 hover:text-white"
                }`}
              >
                👑 Admins
              </button>
            </div>

            {/* Search Input */}
            <div>
              <label className="text-xs font-medium text-white/70">Search Name, Code, Phone or Username:</label>
              <div className="relative mt-1">
                <Search size={16} className="absolute left-3.5 top-3 text-white/40" />
                <input
                  type="text"
                  placeholder="e.g. Rahul, AGT1001, 9876543210, admin_delhi..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm outline-none focus:border-neon-400"
                />
              </div>
            </div>

            {/* Search Results */}
            {filteredSearchAccounts.length > 0 && !selectedAccount && (
              <div className="max-h-52 overflow-y-auto space-y-1.5 border border-white/10 rounded-xl p-2 bg-black/20">
                {filteredSearchAccounts.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedAccount(p);
                      setSearchQuery("");
                    }}
                    className="w-full text-left p-2.5 rounded-lg hover:bg-white/10 flex items-center justify-between transition-colors"
                  >
                    <div>
                      <div className="font-medium text-sm text-white flex items-center gap-1.5">
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.2 rounded uppercase ${
                            p.role === "admin"
                              ? "bg-purple-500/20 text-purple-300"
                              : p.role === "agent"
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-blue-500/20 text-blue-300"
                          }`}
                        >
                          {p.role}
                        </span>
                        {p.name}
                      </div>
                      <div className="text-xs text-white/50 font-mono mt-0.5">
                        {p.code} • {p.phone || p.username || "No login name"} • {coins(p.coins)}
                      </div>
                    </div>
                    <span className="text-xs text-neon-400 font-medium">Select →</span>
                  </button>
                ))}
              </div>
            )}

            {/* Selected Account Card */}
            {selectedAccount && (
              <div className="p-4 rounded-xl bg-neon-400/5 border border-neon-400/30 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-bold text-white text-sm flex items-center gap-1.5">
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                          selectedAccount.role === "admin"
                            ? "bg-purple-500/20 text-purple-300"
                            : selectedAccount.role === "agent"
                            ? "bg-amber-500/20 text-amber-300"
                            : "bg-blue-500/20 text-blue-300"
                        }`}
                      >
                        {ROLE_LABEL[selectedAccount.role]}
                      </span>
                      {selectedAccount.name}
                    </div>
                    <div className="text-xs text-white/60 font-mono mt-0.5">
                      Code: {selectedAccount.code} | {selectedAccount.phone || selectedAccount.username || "—"}
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedAccount(null)}
                    className="text-xs text-white/40 hover:text-white underline"
                  >
                    Change
                  </button>
                </div>

                {selectedAccount.role !== "player" && (
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300 leading-relaxed">
                    ⚠️ <b>Downline Impact:</b> Is {ROLE_LABEL[selectedAccount.role]} ke downline ke sabhi players par ye win/loss outcome command automatically apply hoga (jab tak kisi player ka apna individual override na ho).
                  </div>
                )}

                <div className="text-xs font-medium text-white/70 pt-1">
                  Select Outcome Command for this {ROLE_LABEL[selectedAccount.role]}:
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      updateOutcome(
                        {
                          account_id: selectedAccount.id,
                          account_mode: "force_loss",
                          role: selectedAccount.role as "player" | "agent" | "admin",
                        },
                        "save_acc"
                      );
                      setSelectedAccount(null);
                      setTargetModalOpen(false);
                    }}
                    className="p-3 rounded-xl bg-rose-500/20 border border-rose-500 hover:bg-rose-500/30 text-rose-300 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    <UserX size={15} /> 🔴 Always Lose ({selectedAccount.role === "player" ? "Player Loses" : "Downline Loses"})
                  </button>

                  <button
                    onClick={() => {
                      updateOutcome(
                        {
                          account_id: selectedAccount.id,
                          account_mode: "force_win",
                          role: selectedAccount.role as "player" | "agent" | "admin",
                        },
                        "save_acc"
                      );
                      setSelectedAccount(null);
                      setTargetModalOpen(false);
                    }}
                    className="p-3 rounded-xl bg-emerald-500/20 border border-emerald-500 hover:bg-emerald-500/30 text-emerald-300 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    <UserCheck size={15} /> 🟢 Always Win ({selectedAccount.role === "player" ? "Player Wins" : "Downline Wins"})
                  </button>
                </div>
              </div>
            )}

            <div className="pt-2 text-right">
              <button
                onClick={() => {
                  setSelectedAccount(null);
                  setTargetModalOpen(false);
                }}
                className="btn-ghost rounded-xl px-4 py-2 text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
