"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ShieldCheck } from "lucide-react";
import { fmtPhone, useAccounts, type Account } from "../../lib/hierarchy";

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
  const { accounts } = useAccounts();
  const [err, setErr] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [agree, setAgree] = useState(true);
  const [secs, setSecs] = useState(30);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (step !== "otp" || secs <= 0) return;
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [step, secs]);

  const setDigit = (i: number, v: string) => {
    const d = v.replace(/\D/g, "").slice(-1);
    const next = [...otp];
    next[i] = d;
    setOtp(next);
    if (d && i < 5) refs.current[i + 1]?.focus();
  };

  const complete = otp.every((d) => d);
  const found = accounts.find((a) => a.role === "player" && a.phone === phone);

  // Players are created by an agent, admin or super admin — there is no self sign-up.
  const getOtp = () => {
    if (!found) return setErr("No player account for this number. Ask your agent to create one.");
    if (found.status !== "Active") return setErr("This account is frozen. Contact your agent.");
    setStep("otp");
    setSecs(30);
  };

  return (
    <div className="min-h-dvh flex flex-col px-6 pt-6 pb-10">
      {step === "otp" ? (
        <button onClick={() => setStep("phone")} className="w-9 h-9 -ml-2 grid place-items-center"><ChevronLeft /></button>
      ) : (
        <div className="h-9" />
      )}
      <div className="mt-6 mb-10"><Logo size={0.8} /></div>

      {step === "phone" ? (
        <div className="fadein">
          <h1 className="text-2xl font-semibold">Login</h1>
          <p className="text-sm text-[var(--ink-soft)] mt-1">Enter the mobile number your agent registered</p>
          <div className="mt-6 flex items-center gap-3 card px-4 h-14">
            <span className="text-white/80 font-medium">🇮🇳 +91</span>
            <div className="w-px h-6 bg-white/10" />
            <input
              inputMode="numeric"
              value={phone}
              onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 10)); setErr(""); }}
              placeholder="98765 43210"
              className="flex-1 bg-transparent outline-none text-lg tracking-wide placeholder:text-white/25"
            />
          </div>
          {err && <div className="mt-3 text-xs text-rose-300">{err}</div>}
          <label className="mt-4 flex items-start gap-2.5 text-xs text-[var(--ink-soft)]">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-green-400" />
            I confirm I am 18+ years old, not from a restricted state, and agree to the Terms & Privacy Policy.
          </label>
          <button disabled={phone.length !== 10 || !agree} onClick={getOtp} className="btn-green w-full h-13 py-3.5 rounded-2xl mt-6 text-base">
            Get OTP
          </button>
          <button onClick={() => setPhone("9876543210")} className="w-full text-center text-xs text-white/40 mt-3 border border-dashed border-white/15 rounded-xl py-2">
            Demo: fill sample number
          </button>
          <div className="mt-8 text-center text-xs text-white/40">New here? Player accounts are created by your agent.</div>
        </div>
      ) : (
        <div className="fadein">
          <h1 className="text-2xl font-semibold">Verify OTP</h1>
          <p className="text-sm text-[var(--ink-soft)] mt-1">Sent via SMS & WhatsApp to +91 {fmtPhone(phone)}</p>
          <div className="mt-6 flex justify-between gap-2">
            {otp.map((d, i) => (
              <input
                key={i}
                ref={(el) => { refs.current[i] = el; }}
                value={d}
                inputMode="numeric"
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Backspace" && !otp[i] && i > 0) refs.current[i - 1]?.focus(); }}
                className={`w-12 h-14 text-center text-xl font-semibold rounded-xl bg-white/5 border outline-none ${d ? "border-neon-400" : "border-white/10"} focus:border-neon-400`}
              />
            ))}
          </div>
          <div className="mt-4 text-xs text-[var(--ink-soft)]">
            {secs > 0 ? <>Resend OTP in <span className="text-white">00:{String(secs).padStart(2, "0")}</span></> : <button onClick={() => setSecs(30)} className="text-neon-400 font-medium">Resend OTP</button>}
          </div>
          <button disabled={!complete || !found} onClick={() => found && onDone(found)} className="btn-green w-full py-3.5 rounded-2xl mt-8 text-base">Verify & Continue</button>
          <button onClick={() => setOtp("123456".split(""))} className="w-full text-center text-xs text-white/40 mt-3 border border-dashed border-white/15 rounded-xl py-2">
            Demo: auto-fill OTP (any 6 digits work)
          </button>
          <div className="mt-8 flex items-center gap-2 text-[11px] text-white/40 justify-center"><ShieldCheck size={14} /> One account per verified mobile number</div>
        </div>
      )}
    </div>
  );
}
