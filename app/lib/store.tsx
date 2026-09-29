"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { START_TXNS, START_WALLET, type Txn, type TxnType, type Wallet } from "./data";

// In-memory wallet + ledger for the demo. Mirrors PRD §5.2:
// three buckets, debit order Bonus (capped per table) → Deposit → Winning, withdrawals from Winning only.

const BONUS_CAP = 0.1; // bonus can cover at most 10% of any single entry/bet

interface Store {
  wallet: Wallet;
  total: number;
  txns: Txn[];
  hidden: boolean;
  toggleHidden: () => void;
  debit: (amount: number, game: string) => boolean;
  credit: (amount: number, game: string, label?: string) => void;
  deposit: (amount: number, method: string, bonus: number) => void;
  withdraw: (amount: number) => boolean;
  limits: { deposit: number; loss: number; session: number };
  setLimits: (l: { deposit: number; loss: number; session: number }) => void;
  toast: string | null;
  showToast: (msg: string) => void;
}

const Ctx = createContext<Store | null>(null);

function stamp() {
  const d = new Date();
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWalletState] = useState<Wallet>(START_WALLET);
  // Ref mirror so debit/withdraw can validate against the latest balance synchronously
  // (rapid multi-chip bets — PRD WAL-3 "lock, then validate").
  const walletRef = useRef<Wallet>(START_WALLET);
  const setWallet = useCallback((fn: (w: Wallet) => Wallet) => {
    walletRef.current = fn(walletRef.current);
    setWalletState(walletRef.current);
  }, []);
  const [txns, setTxns] = useState<Txn[]>(START_TXNS);
  const [hidden, setHidden] = useState(false);
  const [limits, setLimits] = useState({ deposit: 10000, loss: 5000, session: 120 });
  const [toast, setToast] = useState<string | null>(null);

  const add = useCallback((type: TxnType, title: string, sub: string, amount: number, status: Txn["status"] = "Success") => {
    setTxns((t) => [{ id: Math.random().toString(36).slice(2), type, title, sub: `${sub} • ${stamp()}`, amount, status }, ...t]);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200);
  }, []);

  const debit = useCallback(
    (amount: number, game: string) => {
      const w = walletRef.current;
      const fromBonus = Math.min(w.bonus, Math.floor(amount * BONUS_CAP * 100) / 100);
      if (w.deposit + w.winning + fromBonus < amount) return false;
      const fromDeposit = Math.min(w.deposit, amount - fromBonus);
      const fromWinning = amount - fromBonus - fromDeposit;
      setWallet(() => ({ bonus: w.bonus - fromBonus, deposit: w.deposit - fromDeposit, winning: w.winning - fromWinning }));
      add("bet", "Bet Placed", game, -amount);
      return true;
    },
    [add, setWallet],
  );

  const credit = useCallback(
    (amount: number, game: string, label = "Game Winnings") => {
      setWallet((w) => ({ ...w, winning: w.winning + amount }));
      add("winning", label, game, amount);
    },
    [add, setWallet],
  );

  const deposit = useCallback(
    (amount: number, method: string, bonus: number) => {
      setWallet((w) => ({ ...w, deposit: w.deposit + amount, bonus: w.bonus + bonus }));
      add("deposit", "Added Cash", method, amount);
      if (bonus) add("bonus", "Deposit Bonus", "Promo", bonus);
    },
    [add, setWallet],
  );

  const withdraw = useCallback(
    (amount: number) => {
      if (amount > walletRef.current.winning) return false;
      setWallet((w) => ({ ...w, winning: w.winning - amount }));
      add("withdraw", "Withdrawal", "HDFC •••• 4821", -amount, "Pending");
      return true;
    },
    [add, setWallet],
  );

  const value = useMemo<Store>(
    () => ({
      wallet,
      total: wallet.deposit + wallet.winning + wallet.bonus,
      txns,
      hidden,
      toggleHidden: () => setHidden((h) => !h),
      debit,
      credit,
      deposit,
      withdraw,
      limits,
      setLimits,
      toast,
      showToast,
    }),
    [wallet, txns, hidden, debit, credit, deposit, withdraw, limits, toast, showToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
