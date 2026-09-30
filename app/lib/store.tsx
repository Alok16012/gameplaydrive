"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { Txn, TxnType } from "./data";
import { errText, supabase } from "./supabase";

// Player wallet: one virtual-coin balance stored in Supabase (public.wallets), with every change in public.ledger.
// Games need a synchronous answer to "can I place this bet?", so debits are checked and applied locally first
// (ref mirror, PRD WAL-3 "lock, then validate") and then confirmed by the database; if the database refuses,
// the balance is reloaded from the server.

export interface Player { id: string; code: string; name: string; first: string; phone: string; agent: string | null }

interface Store {
  total: number;
  txns: Txn[];
  hidden: boolean;
  toggleHidden: () => void;
  debit: (amount: number, game: string) => boolean;
  credit: (amount: number, game: string, label?: string) => void;
  limits: { deposit: number; loss: number; session: number };
  setLimits: (l: { deposit: number; loss: number; session: number }) => void;
  toast: string | null;
  showToast: (msg: string) => void;
  player: Player | null;
  signIn: (p: Player) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Take a balance computed by the game server (and reload history shortly after). */
  applyBalance: (coins: number) => void;
}

const Ctx = createContext<Store | null>(null);

interface LedgerRow { id: number; amount: number; kind: string; note: string | null; created_at: string }

const KIND: Record<string, { type: TxnType; title: string }> = {
  mint: { type: "deposit", title: "Coins received" },
  transfer_in: { type: "deposit", title: "Coins received" },
  burn: { type: "withdraw", title: "Coins removed" },
  transfer_out: { type: "withdraw", title: "Coins taken back" },
  bet: { type: "bet", title: "Bet placed" },
  win: { type: "winning", title: "Winnings" },
  refund: { type: "bonus", title: "Refund" },
};

const toTxn = (r: LedgerRow): Txn => ({
  id: String(r.id),
  type: KIND[r.kind]?.type ?? "bet",
  title: KIND[r.kind]?.title ?? r.kind,
  sub: `${r.note ?? ""} • ${new Date(r.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
  amount: r.amount,
  status: "Success",
});

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [total, setTotal] = useState(0);
  const balRef = useRef(0);
  const setBal = useCallback((n: number) => { balRef.current = n; setTotal(n); }, []);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [hidden, setHidden] = useState(false);
  const [limits, setLimits] = useState({ deposit: 10000, loss: 5000, session: 120 });
  const [toast, setToast] = useState<string | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200);
  }, []);

  const refresh = useCallback(async () => {
    const sb = supabase();
    const { data: s } = await sb.auth.getSession();
    const uid = s.session?.user.id;
    if (!uid) return;
    const [{ data: w }, { data: l }] = await Promise.all([
      sb.from("wallets").select("coins").eq("user_id", uid).maybeSingle(),
      sb.from("ledger").select("id, amount, kind, note, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(100),
    ]);
    if (w) setBal(w.coins);
    setTxns(((l ?? []) as LedgerRow[]).map(toTxn));
  }, [setBal]);

  // Batch history reloads while a game fires several bets in a row.
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(refresh, 1200);
  }, [refresh]);

  const applyBalance = useCallback((n: number) => {
    if (n === balRef.current) return;
    setBal(n);
    refreshSoon();
  }, [setBal, refreshSoon]);

  const signIn = useCallback(async (p: Player) => {
    setPlayer(p);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await supabase().auth.signOut();
    setPlayer(null);
    setBal(0);
    setTxns([]);
  }, [setBal]);

  const debit = useCallback(
    (amount: number, game: string) => {
      const amt = Math.round(amount);
      if (amt <= 0) return true;
      if (balRef.current < amt) return false;
      setBal(balRef.current - amt);
      supabase().rpc("game_bet", { amount: amt, p_note: game }).then(({ data, error }) => {
        if (error) {
          showToast(errText(error));
          refresh();
        } else if (typeof data === "number") refreshSoon();
      });
      return true;
    },
    [setBal, showToast, refresh, refreshSoon],
  );

  const credit = useCallback(
    (amount: number, game: string, label = "Game Winnings") => {
      const amt = Math.round(amount);
      if (amt <= 0) return;
      setBal(balRef.current + amt);
      const kind = /refund/i.test(label) ? "refund" : "win";
      supabase().rpc("game_payout", { amount: amt, p_note: game, p_kind: kind }).then(({ error }) => {
        if (error) {
          showToast(errText(error));
          refresh();
        } else refreshSoon();
      });
    },
    [setBal, showToast, refresh, refreshSoon],
  );

  const value = useMemo<Store>(
    () => ({
      total, txns, hidden,
      toggleHidden: () => setHidden((h) => !h),
      debit, credit, limits, setLimits, toast, showToast, player, signIn, signOut, refresh, applyBalance,
    }),
    [total, txns, hidden, debit, credit, limits, toast, showToast, player, signIn, signOut, refresh, applyBalance],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
