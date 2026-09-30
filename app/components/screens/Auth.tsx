"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { loadMe, type Account } from "../../lib/hierarchy";
import { playerEmail } from "../../lib/loginEmail";
import { supabase } from "../../lib/supabase";

export function Logo({ size = 1 }: { size?: number }) {
  return (
    <div className="flex flex-col items-center" style={{ transform: `scale(${size})` }}>
      <svg width="92" height="92" viewBox="0 0 100 100" className="drop-shadow-[0_8px_24px_rgba(251,191,36,.45)]">
        <defs>
          <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fde68a" />
            <stop offset=".5" stopColor="#fbbf24" />
            <stop offset="1" stopColor="#d97706" />
          </linearGradient>
        </defs>
        <path d="M50 6 C62 26 88 40 88 62 C88 76 76 84 64 84 C58 84 54 81 52 78 L56 94 H44 L48 78 C46 81 42 84 36 84 C24 84 12 76 12 62 C12 40 38 26 50 6 Z" fill="none" stroke="url(#gold)" strokeWidth="7" strokeLinejoin="round" />
        <path d="M50 30 C56 40 70 48 70 60 C70 67 64 71 58 71 C54 71 51 68 50 65 C49 68 46 71 42 71 C36 71 30 67 30 60 C30 48 44 40 50 30 Z" fill="url(#gold)" />
        <path d="M50 2 l3 6 h-6 z" fill="url(#gold)" />
      </svg>
      <div className="mt-2 text-[40px] font-bold tracking-tight leading-none">
        <span className="text-white">Game</span>
        <span className="gold-text">Hub</span>
      </div>
      <div className="mt-2 text-[15px] tracking-[0.25em] text-white/75">Play • Win • Together</div>
    </div>
  );
}

function Floaty({ children, className, r = "0deg", delay = "0s" }: { children: React.ReactNode; className: string; r?: string; delay?: string }) {
  return (
    <div className={`absolute float ${className}`} style={{ ["--r" as string]: r, animationDelay: delay } as React.CSSProperties}>
      {children}
    </div>
  );
}

function Die({ size = 56, pips = 5 }: { size?: number; pips?: number }) {
  const spots: Record<number, number[]> = { 3: [0, 4, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  return (
    <div className="grid grid-cols-3 p-2 gap-0.5 rounded-xl" style={{ width: size, height: size, background: "linear-gradient(145deg,#f87171,#b91c1c)", boxShadow: "inset -4px -4px 8px rgba(0,0,0,.35), 0 10px 20px rgba(0,0,0,.5)" }}>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="grid place-items-center">{spots[pips].includes(i) && <div className="w-2 h-2 rounded-full bg-white" />}</div>
      ))}
    </div>
  );
}

export function Splash({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="relative min-h-dvh overflow-hidden" onClick={onDone}>
      <Floaty className="top-16 right-10" r="20deg"><Die size={54} pips={5} /></Floaty>
      <Floaty className="top-28 left-3" r="-18deg" delay="1s">
        <div className="w-20 h-28 bg-white rounded-lg shadow-2xl p-1.5 text-slate-900 font-bold text-xl leading-none">A<br />♠</div>
      </Floaty>
      <Floaty className="bottom-56 -left-4" r="12deg" delay=".5s">
        <div className="w-16 h-16 rounded-full" style={{ background: "radial-gradient(circle,#dc2626 50%,transparent 51%),repeating-conic-gradient(#fff 0 12deg,#dc2626 12deg 30deg)", boxShadow: "0 10px 20px rgba(0,0,0,.5)" }} />
      </Floaty>
      <Floaty className="bottom-40 right-6" r="-10deg" delay="1.5s"><Die size={50} pips={3} /></Floaty>
      <Floaty className="bottom-24 left-16 opacity-40" r="30deg" delay="2s">
        <div className="w-12 h-12 rounded-full" style={{ background: "radial-gradient(circle,#1f2937 50%,transparent 51%),repeating-conic-gradient(#6b7280 0 12deg,#1f2937 12deg 30deg)" }} />
      </Floaty>

      <div className="relative z-10 flex flex-col items-center pt-[30dvh] px-6 text-center">
        <Logo />
        <div className="mt-10 text-[15px] text-white/85">9 Games &nbsp;|&nbsp; 1 Account &nbsp;|&nbsp; 1 Wallet</div>
      </div>
      <div className="absolute bottom-20 inset-x-0 flex flex-col items-center gap-4">
        <div className="w-16 h-1 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full loadbar rounded-full" style={{ background: "linear-gradient(90deg,#fbbf24,#f59e0b)" }} />
        </div>
        <div className="text-xs text-white/60">Loading your gaming world...</div>
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: (player: Account) => void }) {
  const [phone, setPhone] = useState("");
  const [pw, setPw] = useState("");
  const [agree, setAgree] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Players are created by an agent, admin or super admin, who also sets their password. No self sign-up.
  const submit = async () => {
    setBusy(true);
    setErr("");
    const sb = supabase();
    const { error } = await sb.auth.signInWithPassword({ email: playerEmail(phone), password: pw });
    if (error) {
      setBusy(false);
      return setErr(/invalid/i.test(error.message) ? "Wrong mobile number or password. New here? Ask your agent to create your account." : error.message);
    }
    const me = await loadMe();
    setBusy(false);
    if (!me || me.role !== "player") {
      await sb.auth.signOut();
      return setErr("This number isn't registered as a player.");
    }
    if (me.status !== "Active") {
      await sb.auth.signOut();
      return setErr("This account is frozen. Contact your agent.");
    }
    onDone(me);
  };

  return (
    <div className="min-h-dvh flex flex-col px-6 pt-6 pb-10">
      <div className="h-9" />
      <div className="mt-6 mb-10"><Logo size={0.8} /></div>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="fadein">
        <h1 className="text-2xl font-semibold">Login</h1>
        <p className="text-sm text-[var(--ink-soft)] mt-1">Use the mobile number and password your agent gave you</p>
        <div className="mt-6 flex items-center gap-3 card px-4 h-14">
          <span className="text-white/80 font-medium">🇮🇳 +91</span>
          <div className="w-px h-6 bg-white/10" />
          <input
            inputMode="numeric"
            autoComplete="username"
            value={phone}
            onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 10)); setErr(""); }}
            placeholder="98765 43210"
            className="flex-1 bg-transparent outline-none text-lg tracking-wide placeholder:text-white/25"
          />
        </div>
        <div className="mt-3 card px-4 h-14 flex items-center">
          <input type="password" autoComplete="current-password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} placeholder="Password" className="flex-1 bg-transparent outline-none text-lg placeholder:text-white/25" />
        </div>
        {err && <div className="mt-3 text-xs text-rose-300">{err}</div>}
        <label className="mt-4 flex items-start gap-2.5 text-xs text-[var(--ink-soft)]">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-green-400" />
          I confirm I am 18+ years old and agree to the Terms & Privacy Policy. Coins are virtual and have no cash value.
        </label>
        <button type="submit" disabled={phone.length !== 10 || !pw || !agree || busy} className="btn-green w-full py-3.5 rounded-2xl mt-6 text-base">
          {busy ? "Signing in…" : "Login"}
        </button>
        <div className="mt-8 text-center text-xs text-white/40">New here? Player accounts are created by your agent.</div>
        <div className="mt-8 flex items-center gap-2 text-[11px] text-white/40 justify-center"><ShieldCheck size={14} /> One account per mobile number</div>
      </form>
    </div>
  );
}
