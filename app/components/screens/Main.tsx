"use client";

import { useEffect, useState } from "react";
import { Bell, ChevronRight, Plus, Search, Trophy, Users, X, Copy, Wallet as WalletIcon, Gift, Star } from "lucide-react";
import { GAMES, NOTIFICATIONS, RUMMY_TABLES, TABLES, gameById, inr, type Game, type GameId, type Stake } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { GameThumb, GameTile, GameIcon } from "../GameArt";
import { Avatar, Header, Money, Sheet } from "../ui";
import type { Nav, RummyMode } from "../nav";

const SERVER_GAMES: GameId[] = ["teen-patti", "rummy"];

export function openGame(nav: Nav, game: Game) {
  if (game.kind === "casino") nav.push({ name: "casino", game: game.id });
  else nav.push({ name: "lobby", game: game.id });
}

export function BalanceSummary({ onAdd }: { onAdd: () => void }) {
  const { total } = useStore();
  return (
    <div
      className="rounded-[20px] p-4 border border-white/10"
      style={{ background: "radial-gradient(120% 100% at 100% 0%, rgba(74,222,128,.14), transparent 50%), linear-gradient(135deg,#18225a,#101743)" }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm text-white/75">Coin Balance</div>
          <Money n={total} className="block text-[26px] font-semibold mt-0.5" />
        </div>
        <button onClick={onAdd} className="btn-green pill px-4 py-2 text-sm flex items-center gap-1.5">
          <Plus size={16} strokeWidth={3} /> Get Coins
        </button>
      </div>
      <div className="text-[11px] text-white/50 mt-2">Virtual coins • no cash value</div>
    </div>
  );
}

export function Home({ nav }: { nav: Nav }) {
  const { player } = useStore();
  // Real players seated at Teen Patti / Rummy tables right now.
  const [live, setLive] = useState<Record<string, number>>({});
  useEffect(() => {
    supabase().rpc("lobby_counts").then(({ data }) => {
      if (!data) return;
      const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
      const d = data as Record<string, Record<string, number>>;
      setLive({ "teen-patti": sum(d["teen-patti"]), rummy: sum(d.rummy) });
    });
  }, []);
  const unread = NOTIFICATIONS.filter((n) => n.unread).length;
  return (
    <div className="px-4 pt-6 pb-28 fadein">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[22px] font-semibold">Hello, {player?.first} 👋</div>
          <div className="text-sm text-[var(--ink-soft)]">Ready to play?</div>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => nav.push({ name: "notifications" })} className="relative" aria-label="Notifications">
            <Bell size={24} />
            {unread > 0 && <span className="absolute -top-0.5 right-0 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-[#0c1234]" />}
          </button>
          <button onClick={() => nav.reset({ name: "more" })}><Avatar size={40} /></button>
        </div>
      </div>

      <div className="mt-5"><BalanceSummary onAdd={() => nav.push({ name: "addcash" })} /></div>

      <div className="grid grid-cols-3 gap-2.5 mt-5">
        {GAMES.map((g) => <GameTile key={g.id} game={g} onClick={() => openGame(nav, g)} />)}
      </div>

      <button
        onClick={() => nav.push({ name: "casino", game: "dragon-tiger" })}
        className="w-full mt-5 rounded-2xl p-4 flex items-center gap-4 text-left border border-white/10 active:scale-[.98] transition-transform"
        style={{ background: "linear-gradient(90deg,#3b2ad6 0%,#5b21b6 55%,#a21caf 100%)", boxShadow: "0 10px 30px rgba(91,33,182,.4)" }}
      >
        <span className="text-5xl drop-shadow-lg">🏆</span>
        <div className="flex-1 text-lg font-semibold leading-tight">Play More<br />Win Bigger</div>
        <ChevronRight />
      </button>

      <div className="mt-6 flex items-center justify-between">
        <div className="font-semibold">Live multiplayer</div>
        <button onClick={() => nav.reset({ name: "games" })} className="text-xs text-neon-400">See all</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {SERVER_GAMES.map((id) => gameById(id)).map((g) => (
          <button key={g.id} onClick={() => openGame(nav, g)} className="card p-2.5 text-left">
            <GameThumb game={g} className="h-20" />
            <div className="mt-2 text-sm font-medium">{g.name}</div>
            <div className="text-[11px] text-neon-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-neon-400" />
              {live[g.id] ? `${live[g.id]} playing now` : "Real players + labelled bots"}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Games({ nav, initial = "card" }: { nav: Nav; initial?: "card" | "casino" | "board" }) {
  const [cat, setCat] = useState(initial);
  const [q, setQ] = useState<string | null>(null);
  const list = GAMES.filter((g) => (q ? g.name.toLowerCase().includes(q.toLowerCase()) : g.category === cat));
  return (
    <div className="pb-28 fadein">
      <Header
        title="All Games"
        onBack={() => nav.reset({ name: "home" })}
        right={
          <button onClick={() => setQ(q === null ? "" : null)} aria-label="Search">{q === null ? <Search size={22} /> : <X size={22} />}</button>
        }
      />
      <div className="px-4">
        {q !== null ? (
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 9 games…" className="w-full card px-4 py-3 outline-none bg-transparent text-sm" />
        ) : (
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {([["card", "Card Games"], ["casino", "Casino Games"], ["board", "Board Games"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setCat(id)} className={`pill px-3.5 py-2 text-[12.5px] font-medium whitespace-nowrap transition-colors ${cat === id ? "btn-green" : "bg-white/5 text-white/80"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 space-y-3">
          {list.map((g) => (
            <div key={g.id} onClick={() => openGame(nav, g)} className="card p-2.5 flex items-center gap-3.5 cursor-pointer active:scale-[.99] transition-transform">
              <GameThumb game={g} className="w-28 h-[84px] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{g.name}</div>
                <div className="text-xs text-[var(--ink-soft)]">{g.meta}</div>
                <button className="btn-green pill px-4 py-1.5 text-xs mt-2.5">Play Now</button>
              </div>
              <ChevronRight className="text-white/60 mr-1" />
            </div>
          ))}
          {list.length === 0 && <div className="text-center text-sm text-white/40 py-10">No games match “{q}”</div>}
        </div>
      </div>
    </div>
  );
}

// Rummy formats and their stake ladders (one value per lobby table row).
const RUMMY_MODES: Record<RummyMode, { short: string; about: string }> = {
  points: { short: "Points", about: "One deal. Losers pay their points × the point value to the winner. Max 80 points." },
  pool101: { short: "Pool 101", about: "Play deal after deal. Reach 101 points and you're out — last player standing takes the prize pool." },
  pool201: { short: "Pool 201", about: "Like Pool 101 with a 201-point limit, so matches last longer. Drops cost 25 / 50." },
  deals: { short: "Deals", about: "A fixed number of deals. Each deal's winner collects the others' points as chips; most chips wins." },
};
const RUMMY_STAKES: Record<RummyMode, number[]> = {
  points: [1, 2, 5, 10, 20, 50, 100],
  pool101: [10, 25, 50, 100, 250, 500, 1000],
  pool201: [10, 25, 50, 100, 250, 500, 1000],
  deals: [10, 25, 50, 100, 250, 500, 1000],
};

const MULT: Partial<Record<GameId, number>> = { ludo: 1, carrom: 1, chess: 2, poker: 2, "teen-patti": 1, rummy: 1 };

export function Lobby({ nav, gameId }: { nav: Nav; gameId: GameId }) {
  const game = gameById(gameId);
  const { showToast } = useStore();
  const [stake, setStake] = useState<"All" | Stake>("All");
  const [priv, setPriv] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [privStake, setPrivStake] = useState(1);
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [localCode] = useState(() => Math.random().toString(36).slice(2, 8).toUpperCase());
  const m = MULT[gameId] ?? 1;
  const rummy = gameId === "rummy";
  const online = SERVER_GAMES.includes(gameId);
  const [mode, setMode] = useState<RummyMode>("points");
  const seats = game.id === "ludo" || game.id === "carrom" ? 4 : game.id === "chess" ? 2 : 6;
  const privEntries = rummy ? RUMMY_STAKES[mode].slice(0, 3) : [10 * m, 50 * m, 100 * m];
  const base = rummy ? RUMMY_TABLES : TABLES;
  const tables = base
    .map((t, i) => ({ ...t, seats, seated: Math.min(t.seated, seats), buyIn: rummy ? RUMMY_STAKES[mode][i] : t.buyIn * m, deals: rummy && mode === "deals" ? (i % 2 ? 3 : 2) : 0 }))
    .filter((t) => stake === "All" || t.stake === stake);
  const countKey = (buyIn: number, deals: number) => (rummy ? `${mode}:${buyIn}:${deals}` : String(buyIn));

  // Real players seated right now, per table type (server games only).
  useEffect(() => {
    if (!online) return;
    const load = () => supabase().rpc("lobby_counts").then(({ data }) => data && setCounts((data as Record<string, Record<string, number>>)[gameId] ?? {}));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [online, gameId]);

  const join = (table: string, buyIn: number, deals?: number) => {
    if (game.kind === "rummy") nav.push({ name: "rummy", table, buyIn, mode, deals });
    else if (game.kind === "board") nav.push({ name: "board", game: game.id, table, buyIn });
    else nav.push({ name: "cardtable", game: game.id, table, buyIn });
  };

  // Private tables on the server: create one (you get an invite code) or join a friend's by code.
  const createPrivate = async () => {
    setBusy(true);
    const { data, error } = rummy
      ? await supabase().rpc("rm_create_private", { p_mode: mode, p_stake: privEntries[privStake], p_deals: mode === "deals" ? 2 : 0 })
      : await supabase().rpc("tp_create_private", { p_boot: privEntries[privStake] });
    setBusy(false);
    if (error) return showToast(errText(error));
    setPriv(false);
    join(`P-${data}`, privEntries[privStake], mode === "deals" ? 2 : 0);
  };
  const joinPrivate = () => {
    const c = joinCode.trim().toUpperCase();
    if (c.length !== 6) return showToast("Enter the 6-character code");
    setPriv(false);
    join(`P-${c}`, 0, 0);
  };

  return (
    <div className="pb-28 fadein">
      <Header
        title={game.name}
        sub={game.meta}
        onBack={nav.back}
        icon={<div className="w-11 h-11 rounded-xl grid place-items-center overflow-hidden scale-90" style={{ background: `linear-gradient(160deg,${game.from},${game.to})` }}><div className="scale-[.6]"><GameIcon id={game.id} /></div></div>}
        right={online
          ? <div className="text-[11px] text-neon-400 flex items-center gap-1"><Users size={14} />{Object.values(counts).reduce((a, b) => a + b, 0)} online</div>
          : <div className="text-[11px] text-white/50">Practice vs bots</div>}
      />
      <div className="px-4">
        {rummy && (
          <>
            <div className="grid grid-cols-4 gap-1 p-1 rounded-2xl bg-white/5 mb-2">
              {(Object.keys(RUMMY_MODES) as RummyMode[]).map((k) => (
                <button key={k} onClick={() => { setMode(k); setPrivStake(1); }} className={`rounded-xl py-2 text-xs font-medium ${mode === k ? "btn-green" : "text-white/70"}`}>{RUMMY_MODES[k].short}</button>
              ))}
            </div>
            <div className="text-[11px] text-[var(--ink-soft)] mb-3 px-1">{RUMMY_MODES[mode].about}</div>
          </>
        )}
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {(["All", "Low", "Mid", "High"] as const).map((s) => (
            <button key={s} onClick={() => setStake(s)} className={`pill px-3.5 py-1.5 text-xs font-medium whitespace-nowrap ${stake === s ? "btn-green" : "bg-white/5 text-white/80"}`}>
              {s === "All" ? "All Tables" : `${s} Stakes`}
            </button>
          ))}
        </div>
        <div className="mt-4 card divide-y divide-white/5">
          {tables.map((t, i) => {
            const real = counts[countKey(t.buyIn, t.deals)] ?? 0;
            const full = !online && t.seated >= t.seats;
            return (
              <div key={t.id} className="flex items-center gap-3 p-3.5">
                <Avatar size={36} emoji={["👨🏽", "🧔🏾", "👩🏻", "👨🏻‍🦱", "👩🏽‍🦱", "🧑🏼", "👨🏽"][i]} />
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {rummy ? (mode === "points" ? `${inr(t.buyIn)} per point` : `${inr(t.buyIn)} entry`) : online ? `Boot ${inr(t.buyIn)}` : `Table ${t.id}`}
                    {rummy && <span className="text-white/50 font-normal"> • {mode === "deals" ? `Best of ${t.deals}` : RUMMY_MODES[mode].short}</span>}
                  </div>
                  <div className="text-[11px] text-[var(--ink-soft)]">
                    {online
                      ? <>{real > 0 ? <span className="text-neon-400">{real} playing now</span> : "Be the first"}{rummy && mode === "points" ? ` • buy-in ${inr(t.buyIn * 80)}` : ""}</>
                      : <>{t.seated}/{t.seats} Players • {inr(t.buyIn)} Entry</>}
                  </div>
                </div>
                <button disabled={full} onClick={() => join(online ? `S-${t.buyIn}` : t.id, t.buyIn, t.deals)} className={`pill px-5 py-2 text-xs ${full ? "bg-white/10 text-white/60" : "btn-green"}`}>
                  {full ? "Full" : online ? "Play" : "Join"}
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[11px] text-white/40 text-center">
          {online ? "Real players at the same stake sit together. Cards are dealt by the server; bots are always labelled." : "Practice table: you play against bots on this device."}
        </div>
      </div>
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] p-4 bg-gradient-to-t from-[#080c26] via-[#080c26] to-transparent">
        <button onClick={() => setPriv(true)} className="btn-green w-full py-3.5 rounded-2xl flex items-center justify-center gap-2"><Users size={18} /> Private Table</button>
      </div>
      <Sheet open={priv} onClose={() => setPriv(false)} title="Private Table">
        {online ? (
          <>
            <div className="text-sm text-[var(--ink-soft)]">Play with friends only — no bots. A game starts when at least 2 players are in.</div>
            <div className="text-xs text-white/60 mt-4">{rummy ? `${RUMMY_MODES[mode].short} • ` : ""}{rummy && mode === "points" ? "Coins per point" : rummy ? "Entry" : "Boot"}</div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {privEntries.map((b, i) => (
                <button key={b} onClick={() => setPrivStake(i)} className={`card py-3 text-center text-sm ${privStake === i ? "ring-2 ring-neon-400" : ""}`}>{inr(b)}</button>
              ))}
            </div>
            <button disabled={busy} onClick={createPrivate} className="btn-green w-full py-3.5 rounded-2xl mt-4">{busy ? "Creating…" : "Create & get invite code"}</button>
            <div className="flex items-center gap-3 my-5 text-xs text-white/40"><div className="flex-1 h-px bg-white/10" />or join a friend<div className="flex-1 h-px bg-white/10" /></div>
            <div className="flex gap-2">
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} placeholder="INVITE CODE" className="flex-1 card px-4 py-3 bg-transparent outline-none tracking-[0.3em] font-semibold placeholder:tracking-normal placeholder:font-normal" />
              <button onClick={joinPrivate} className="btn-ghost rounded-2xl px-5 text-sm">Join</button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-[var(--ink-soft)]">Practice table code. Invite-only multiplayer for {game.name} arrives when it moves to the server.</div>
            <div className="mt-4 card p-4 flex items-center justify-between">
              <div className="text-2xl font-bold tracking-[0.3em]">{localCode}</div>
              <button onClick={() => navigator.clipboard?.writeText(localCode)} className="btn-ghost pill px-3 py-1.5 text-xs flex items-center gap-1"><Copy size={14} /> Copy</button>
            </div>
            <button onClick={() => { setPriv(false); join("P-" + localCode, privEntries[1]); }} className="btn-green w-full py-3.5 rounded-2xl mt-5">Start Table</button>
          </>
        )}
      </Sheet>
    </div>
  );
}

export function Notifications({ nav }: { nav: Nav }) {
  return (
    <div className="pb-10 fadein">
      <Header title="Notifications" onBack={nav.back} />
      <div className="px-4 space-y-2.5">
        {NOTIFICATIONS.map((n, i) => (
          <div key={i} className="card p-3.5 flex gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 grid place-items-center shrink-0">{i === 1 ? <Star size={18} className="text-gold-400" /> : <Bell size={18} className="text-neon-400" />}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">{n.title}{n.unread && <span className="w-2 h-2 rounded-full bg-rose-500" />}</div>
              <div className="text-xs text-[var(--ink-soft)] mt-0.5">{n.body}</div>
              <div className="text-[10px] text-white/40 mt-1">{n.when}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
