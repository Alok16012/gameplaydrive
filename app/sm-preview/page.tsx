"use client";

// TEMPORARY preview harness for the Stock Market screen — fakes the sm_* database functions in the browser.
// Delete before committing.

import { StoreProvider } from "../lib/store";
import { StockMarket } from "../components/games/StockMarket";
import { Toast } from "../components/ui";

type Bet = { side: "up" | "down"; amount: number; cash_tick: number | null; payout: number };
type Round = { id: number; starts: number; ends: number; path: number[]; bets: Bet[]; settled: boolean };

if (typeof window !== "undefined" && !(window as unknown as { __sm?: boolean }).__sm) {
  (window as unknown as { __sm?: boolean }).__sm = true;
  let bal = 5000;
  const rounds: Round[] = [];
  const mk = (id: number): Round => {
    let p = 1; const path = [1];
    for (let i = 0; i < 80; i++) {
      let s = 0.035 * (0.3 + 1.4 * Math.random());
      if (Math.random() < 0.08) s *= 2.5;
      s = Math.min(s, 0.5 * p, 0.5 * (2 - p));
      p += Math.random() < 0.5 ? s : -s;
      path.push(Math.round(p * 1e4) / 1e4);
    }
    const now = Date.now();
    return { id, starts: now + 10000, ends: now + 30000, path, bets: [], settled: false };
  };
  const val = (b: Bet, p: number) => (b.side === "up" ? b.amount * p : b.amount * (2 - p));
  const cur = () => {
    const r = rounds[rounds.length - 1];
    if (!r || Date.now() > r.ends + 4000) rounds.push(mk((r?.id ?? 0) + 1));
    return rounds[rounds.length - 1];
  };
  const settle = () => rounds.forEach((r) => {
    if (r.settled || Date.now() < r.ends) return;
    r.bets.filter((b) => b.cash_tick === null).forEach((b) => { b.cash_tick = 80; b.payout = Math.floor(val(b, r.path[80]) * 0.99); bal += b.payout; });
    r.settled = true;
  });
  const tick = (r: Round) => Math.max(0, Math.min(80, Math.floor((Date.now() - r.starts) / 250)));
  const state = () => {
    settle();
    const r = cur(), now = Date.now();
    return {
      id: r.id, starts_at: new Date(r.starts).toISOString(), ends_at: new Date(r.ends).toISOString(),
      phase: now < r.starts ? "betting" : now < r.ends ? "live" : "closed",
      path: now < r.starts ? [] : now >= r.ends ? r.path : r.path.slice(0, tick(r) + 1),
      server_now: new Date(now).toISOString(), balance: bal, fee: 0.01,
      history: rounds.filter((x) => x.ends <= now && x !== r).map((x) => Math.round((x.path[80] - 1) * 100)).reverse().slice(0, 20),
      mine: r.bets, crowd: { up: 0, down: 0, up_n: 0, down_n: 0 },
    };
  };
  const fail = (m: string) => new Response(JSON.stringify({ message: m }), { status: 400, headers: { "content-type": "application/json" } });
  const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/\/rpc\/(sm_\w+)/);
    if (!m) return url.includes("/rest/v1/") || url.includes("/auth/v1/") ? ok(null) : orig(input, init);
    const args = init?.body ? JSON.parse(String(init.body)) : {};
    const r = cur();
    if (m[1] === "sm_state") return ok(state());
    if (m[1] === "sm_bet") {
      if (Date.now() >= r.starts) return fail("Bets are closed — wait for the next round");
      if (bal < args.p_amount) return fail("Not enough coins");
      bal -= args.p_amount;
      const b = r.bets.find((x) => x.side === args.p_side);
      if (b) b.amount += args.p_amount; else r.bets.push({ side: args.p_side, amount: args.p_amount, cash_tick: null, payout: 0 });
      return ok(state());
    }
    if (m[1] === "sm_clear") { r.bets.forEach((b) => (bal += b.amount)); r.bets = []; return ok(state()); }
    if (m[1] === "sm_cashout") {
      if (Date.now() < r.starts || Date.now() >= r.ends) return fail("The market is not open");
      const t = tick(r); let pay = 0;
      r.bets.filter((b) => b.cash_tick === null).forEach((b) => { b.cash_tick = t; b.payout = Math.floor(val(b, r.path[t]) * 0.99); pay += b.payout; });
      if (!pay) return fail("Nothing to cash out");
      bal += pay;
      return ok({ ...state(), cashed: { tick: t, payout: pay } });
    }
    return orig(input, init);
  };
}

export default function Page() {
  return (
    <StoreProvider>
      <div className="stage"><div className="app">
        <StockMarket nav={{ push: () => {}, back: () => {}, reset: () => {}, logout: () => {} }} />
        <Toast />
      </div></div>
    </StoreProvider>
  );
}
