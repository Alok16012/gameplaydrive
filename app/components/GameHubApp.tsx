"use client";

import { useCallback, useMemo, useState } from "react";
import { StoreProvider } from "../lib/store";
import { BottomNav, Toast, type Tab } from "./ui";
import type { Nav, Route } from "./nav";
import { Login, Splash } from "./screens/Auth";
import { Games, Home, Lobby, Notifications } from "./screens/Main";
import { AddCash, Transactions, WalletScreen, Withdraw } from "./screens/WalletScreens";
import { GameHistory, Help, Kyc, More, ResponsibleGaming, Settings } from "./screens/Account";
import { Casino } from "./games/Casino";
import { CardTable } from "./games/CardTable";
import { Rummy } from "./games/Rummy";
import { BoardGame } from "./games/Board";

const TAB_OF: Partial<Record<Route["name"], Tab>> = { home: "home", games: "games", wallet: "wallet", more: "more" };

function Shell() {
  const [auth, setAuth] = useState<"splash" | "login" | "in">("splash");
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const route = stack[stack.length - 1];

  const nav = useMemo<Nav>(
    () => ({
      push: (r) => { setStack((s) => [...s, r]); window.scrollTo(0, 0); },
      back: () => { setStack((s) => (s.length > 1 ? s.slice(0, -1) : [{ name: "home" }])); window.scrollTo(0, 0); },
      reset: (r) => { setStack([r]); window.scrollTo(0, 0); },
      logout: () => { setStack([{ name: "home" }]); setAuth("login"); },
    }),
    [],
  );

  const splashDone = useCallback(() => setAuth((a) => (a === "splash" ? "login" : a)), []);

  if (auth === "splash") return <Splash onDone={splashDone} />;
  if (auth === "login") return <Login onDone={() => setAuth("in")} />;

  const tab = TAB_OF[route.name];
  let screen: React.ReactNode;
  switch (route.name) {
    case "home": screen = <Home nav={nav} />; break;
    case "games": screen = <Games nav={nav} initial={route.category} />; break;
    case "lobby": screen = <Lobby nav={nav} gameId={route.game} />; break;
    case "casino": screen = <Casino key={route.game} nav={nav} gameId={route.game} />; break;
    case "cardtable": screen = <CardTable nav={nav} gameId={route.game} table={route.table} buyIn={route.buyIn} />; break;
    case "rummy": screen = <Rummy nav={nav} table={route.table} buyIn={route.buyIn} />; break;
    case "board": screen = <BoardGame nav={nav} gameId={route.game} table={route.table} buyIn={route.buyIn} />; break;
    case "wallet": screen = <WalletScreen nav={nav} />; break;
    case "addcash": screen = <AddCash nav={nav} />; break;
    case "withdraw": screen = <Withdraw nav={nav} />; break;
    case "txns": screen = <Transactions nav={nav} />; break;
    case "more": screen = <More nav={nav} />; break;
    case "history": screen = <GameHistory nav={nav} />; break;
    case "kyc": screen = <Kyc nav={nav} />; break;
    case "rg": screen = <ResponsibleGaming nav={nav} />; break;
    case "help": screen = <Help nav={nav} />; break;
    case "settings": screen = <Settings nav={nav} />; break;
    case "notifications": screen = <Notifications nav={nav} />; break;
  }

  return (
    <>
      <div key={stack.length + route.name}>{screen}</div>
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
