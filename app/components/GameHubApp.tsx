"use client";

import { LudoOnline } from "./games/LudoOnline";
import { REJOIN_MS, markActive, touchActive } from "../lib/rejoin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StoreProvider, useStore } from "../lib/store";
import { fmtPhone, loadMe, type Account } from "../lib/hierarchy";
import { refreshBotConfig } from "../lib/botpool";
import { supabase } from "../lib/supabase";
import { sfx, unlockAudio } from "../lib/sound";
import { BottomNav, ScreenBoundary, Toast, type Tab } from "./ui";
import type { Nav, Route } from "./nav";
import { Login, Splash } from "./screens/Auth";
import { Games, Home, Lobby, Notifications } from "./screens/Main";
import { AddCash, Transactions, WalletScreen } from "./screens/WalletScreens";
import { GameHistory, Help, More, ResponsibleGaming, Settings } from "./screens/Account";
import { Casino } from "./games/Casino";
import { LuckySeven } from "./games/LuckySeven";
import { CardTable } from "./games/CardTable";
import { TeenPattiOnline } from "./games/TeenPattiOnline";
import { TeenPattiSupabase } from "./games/TeenPattiSupabase";
import { gameServerUp } from "../lib/gameServer";
import { RummyOnline } from "./games/RummyOnline";
import { BoardGame } from "./games/Board";
import { Aviator } from "./games/Aviator";
import { Roulette } from "./games/Roulette";
import { Blackjack } from "./games/Blackjack";
import { Plinko } from "./games/Plinko";
import { StockMarket } from "./games/StockMarket";
import { Cricket } from "./games/Cricket";

const TAB_OF: Partial<Record<Route["name"], Tab>> = { home: "home", games: "games", wallet: "wallet", more: "more" };

function Shell() {
  const [auth, setAuth] = useState<"splash" | "login" | "in">("splash");
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const route = stack[stack.length - 1];
  const { signIn, signOut } = useStore();

  const enter = useCallback(async (p: Account) => {
    const { data: agent } = await supabase().from("profiles").select("name").eq("id", p.parentId ?? "").maybeSingle();
    await Promise.all([
      signIn({ id: p.id, code: p.code, name: p.name, first: p.name.split(" ")[0], phone: `+91 ${fmtPhone(p.phone)}`, agent: agent?.name ?? null }),
      refreshBotConfig(),
    ]);
    setAuth("in");
  }, [signIn]);

  const nav = useMemo<Nav>(
    () => ({
      push: (r) => { setStack((s) => [...s, r]); window.scrollTo(0, 0); },
      back: () => { setStack((s) => (s.length > 1 ? s.slice(0, -1) : [{ name: "home" }])); window.scrollTo(0, 0); },
      reset: (r) => { setStack([r]); window.scrollTo(0, 0); },
      logout: () => { setStack([{ name: "home" }]); setAuth("login"); signOut(); },
    }),
    [signOut],
  );

  // Rejoin: server tables keep your seat when the screen closes, so remember the one you're at and offer it on
  // Home. (Ludo, Chess, Poker and Blackjack mark themselves when a game is actually under way.)
  useEffect(() => {
    if (route.name === "rummy") markActive(route, `${route.cards === 21 ? "21 Card Rummy" : "Rummy"} • Table #${route.table}`, REJOIN_MS.rummy);
    else if (route.name === "cardtable" && route.game === "teen-patti") markActive(route, `Teen Patti • Boot 🪙 ${route.buyIn}`, REJOIN_MS.teenPatti);
    // While the table is open the rejoin window keeps resetting; it starts counting once you leave the screen.
    const t = setInterval(() => touchActive(route), 5000);
    return () => { touchActive(route); clearInterval(t); };
  }, [route]);

  // Sound: phones only allow audio after a touch, so wake the engine (and the music) on the first tap; every
  // button gives a soft click unless it plays its own sound (data-sfx="off").
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      unlockAudio();
      const b = (e.target as Element | null)?.closest?.("button");
      if (b && !(b as HTMLButtonElement).disabled && !b.closest("[data-sfx='off']")) sfx.click();
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  // The phone's back button / back gesture: the screens live in our own stack, not in the browser history, so
  // without this the browser would leave the site. Keep one extra history entry while signed in; each back press
  // pops a screen and puts the entry back. On the home screen the press is let through and the site closes.
  const stackRef = useRef(stack);
  stackRef.current = stack;
  useEffect(() => {
    if (auth !== "in") return;
    window.history.pushState({ gamehub: true }, "");
    const onPop = () => {
      const s = stackRef.current;
      if (s.length === 1 && s[0].name === "home") return void window.history.back();
      window.history.pushState({ gamehub: true }, "");
      setStack(s.length > 1 ? s.slice(0, -1) : [{ name: "home" }]);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [auth]);

  // If the session ends while playing (expired, or signed out elsewhere), go back to the login screen
  // instead of leaving the player on a table whose requests would all be rejected.
  useEffect(() => {
    if (auth !== "in") return;
    const { data } = supabase().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        setStack([{ name: "home" }]);
        setAuth("login");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [auth]);

  // After the splash, resume a saved session if it belongs to an active player.
  const splashDone = useCallback(async () => {
    const me = await loadMe().catch(() => null);
    if (me && me.role === "player" && me.status === "Active") return enter(me);
    if (me) await supabase().auth.signOut();
    setAuth((a) => (a === "splash" ? "login" : a));
  }, [enter]);

  if (auth === "splash") return <Splash onDone={splashDone} />;
  if (auth === "login") return <Login onDone={enter} />;

  const tab = TAB_OF[route.name];
  let screen: React.ReactNode;
  switch (route.name) {
    case "home": screen = <Home nav={nav} />; break;
    case "games": screen = <Games nav={nav} initial={route.category} />; break;
    case "lobby": screen = <Lobby nav={nav} gameId={route.game} />; break;
    case "aviator": screen = <Aviator nav={nav} />; break;
    case "cricket": screen = <Cricket nav={nav} matchId={route.matchId} initialSport={route.sport} />; break;
    case "roulette": screen = <Roulette nav={nav} />; break;
    case "blackjack": screen = <Blackjack nav={nav} />; break;
    case "plinko": screen = <Plinko nav={nav} />; break;
    case "stockmarket": screen = <StockMarket nav={nav} />; break;
    case "casino": screen = route.game === "lucky-7" ? <LuckySeven nav={nav} /> : <Casino key={route.game} nav={nav} gameId={route.game} />; break;
    case "cardtable": screen = route.game === "teen-patti"
      ? <TeenPattiAuto key={route.table + route.buyIn} nav={nav} buyIn={route.buyIn} code={route.table.startsWith("P-") ? route.table.slice(2) : undefined} />
      : <CardTable nav={nav} gameId={route.game} table={route.table} buyIn={route.buyIn} />; break;
    case "rummy": screen = <RummyOnline key={route.table + route.mode + route.buyIn + (route.cards ?? 13)} nav={nav} mode={route.mode} stake={route.buyIn} deals={route.deals ?? 2} cards={route.cards ?? 13} code={route.table.startsWith("P-") ? route.table.slice(2) : undefined} avoid={route.avoid} />; break;
    case "board": screen = route.game === "ludo" && route.table.startsWith("P-")
      ? <LudoOnline key={route.table} nav={nav} code={route.table.slice(2)} entry={route.buyIn} />
      : <BoardGame key={route.table + route.buyIn + (route.players ?? 4)} nav={nav} gameId={route.game} table={route.table} buyIn={route.buyIn} players={route.players} />; break;
    case "wallet": screen = <WalletScreen nav={nav} />; break;
    case "addcash": screen = <AddCash nav={nav} defaultWithdraw={route.withdraw} />; break;
    case "txns": screen = <Transactions nav={nav} />; break;
    case "more": screen = <More nav={nav} />; break;
    case "history": screen = <GameHistory nav={nav} />; break;
    case "rg": screen = <ResponsibleGaming nav={nav} />; break;
    case "help": screen = <Help nav={nav} />; break;
    case "settings": screen = <Settings nav={nav} />; break;
    case "notifications": screen = <Notifications nav={nav} />; break;
  }

  return (
    <>
      <ScreenBoundary key={stack.length + route.name}><div>{screen}</div></ScreenBoundary>
      {tab && <BottomNav tab={tab} onTab={(t) => nav.reset({ name: t })} />}
    </>
  );
}

export default function GameHubApp() {
  return (
    <StoreProvider>
      <div className="stage">
        <div className="app">
          <Shell />
          <Toast />
        </div>
      </div>
    </StoreProvider>
  );
}

/** Teen Patti on the realtime game server when it's up; otherwise the Supabase engine, so the game never stops. */
function TeenPattiAuto(props: { nav: Nav; buyIn: number; code?: string }) {
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(() => { gameServerUp().then(setUp); }, []);
  if (up === null) return <div className="min-h-dvh grid place-items-center text-sm text-white/60">Connecting to the table…</div>;
  return up ? <TeenPattiOnline {...props} /> : <TeenPattiSupabase {...props} />;
}
