"use client";

import { prettyNumber, useSupport, whatsappLink } from "../../lib/support";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Gift,
  Lock,
  LogIn,
  MapPin,
  MessageCircle,
  Phone,
  ShieldCheck,
  Sparkles,
  User,
  UserPlus,
} from "lucide-react";
import { loadMe, type Account } from "../../lib/hierarchy";
import { playerEmail } from "../../lib/loginEmail";
import { supabase } from "../../lib/supabase";

const INDIAN_STATES = [
  "Maharashtra",
  "Karnataka",
  "Delhi",
  "Tamil Nadu",
  "Punjab",
  "Gujarat",
  "Kerala",
  "Uttar Pradesh",
  "West Bengal",
  "Rajasthan",
  "Madhya Pradesh",
  "Bihar",
  "Haryana",
  "Goa",
  "Telangana",
  "Andhra Pradesh",
  "Odisha",
  "Assam",
  "Jharkhand",
  "Chhattisgarh",
  "Uttarakhand",
  "Himachal Pradesh",
];

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
        <span className="text-white">Khelo</span>
        <span className="gold-text">baazi</span>
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

      <div className="relative z-10 flex flex-col items-center pt-[22dvh] px-6 text-center">
        <Logo />
        <div className="mt-7 flex flex-col items-center gap-2 max-w-[360px]">
          <div className="text-[13px] sm:text-[14px] font-medium tracking-wide text-amber-300/90 leading-snug">
            Sports Betting • Cricket • Football • Tennis
          </div>
          <div className="text-[13px] sm:text-[14px] font-medium tracking-wide text-white/85 leading-snug">
            Rummy • Teen Patti • Poker • Ludo • Casino &amp; More
          </div>
          <div className="mt-1 text-[14px] sm:text-[15px] font-semibold tracking-wider text-white">
            1 Account • 1 Wallet
          </div>
        </div>
      </div>
      <div className="absolute bottom-16 inset-x-0 flex flex-col items-center gap-4">
        <div className="w-16 h-1 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full loadbar rounded-full" style={{ background: "linear-gradient(90deg,#fbbf24,#f59e0b)" }} />
        </div>
        <div className="text-xs text-white/60">Loading your gaming world…</div>
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: (player: Account) => void }) {
  const support = useSupport();
  const [mode, setMode] = useState<"login" | "register">("login");

  // Login states
  const [phone, setPhone] = useState("");
  const [pw, setPw] = useState("");
  const [showLoginPw, setShowLoginPw] = useState(false);

  // Registration states
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regPw, setRegPw] = useState("");
  const [regConfirmPw, setRegConfirmPw] = useState("");
  const [regState, setRegState] = useState("");
  const [regReferral, setRegReferral] = useState("");
  const [showRegPw, setShowRegPw] = useState(false);

  const [agree, setAgree] = useState(true);
  const [err, setErr] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // Check URL parameters for referral code or direct register intent
  useEffect(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const ref = p.get("ref") || p.get("agent") || p.get("code");
      if (ref) {
        setRegReferral(ref.trim());
        setMode("register");
      }
      if (p.get("register") === "true" || p.get("signup") === "true") {
        setMode("register");
      }
    }
  }, []);

  // Player login submit
  const submitLogin = async () => {
    setBusy(true);
    setErr("");
    setSuccessMsg("");
    const sb = supabase();
    const { error } = await sb.auth.signInWithPassword({ email: playerEmail(phone), password: pw });
    if (error) {
      setBusy(false);
      return setErr(
        /invalid/i.test(error.message)
          ? "Wrong mobile number or password. Not registered yet? Switch to Register above."
          : error.message
      );
    }
    const me = await loadMe();
    setBusy(false);
    if (!me || me.role !== "player") {
      await sb.auth.signOut();
      return setErr("This number is not registered as a player.");
    }
    if (me.status !== "Active") {
      await sb.auth.signOut();
      return setErr("This account is frozen. Contact support or your agent.");
    }
    onDone(me);
  };

  // Player self-registration submit
  const submitRegister = async () => {
    const trimmedName = regName.trim();
    if (trimmedName.length < 2) {
      return setErr("Please enter your full name (at least 2 letters)");
    }
    if (regPhone.length !== 10) {
      return setErr("Please enter a valid 10-digit mobile number");
    }
    if (regPw.length < 6) {
      return setErr("Password must be at least 6 characters");
    }
    if (regPw !== regConfirmPw) {
      return setErr("Passwords do not match");
    }

    setBusy(true);
    setErr("");
    setSuccessMsg("");

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          phone: regPhone,
          password: regPw,
          state: regState || null,
          referralCode: regReferral.trim() || null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setBusy(false);
        if (data.exists) {
          setErr("This mobile number is already registered! Please switch to Login.");
        } else {
          setErr(data.error || "Registration failed. Please try again.");
        }
        return;
      }

      // Automatically sign in the freshly registered player
      setSuccessMsg("Account created successfully! Logging you in…");
      const sb = supabase();
      const { error: signInErr } = await sb.auth.signInWithPassword({
        email: playerEmail(regPhone),
        password: regPw,
      });

      if (signInErr) {
        setBusy(false);
        // Fallback to login tab with prefilled credentials
        setPhone(regPhone);
        setPw(regPw);
        setMode("login");
        setSuccessMsg("Registration complete! Please enter your password to sign in.");
        return;
      }

      const me = await loadMe();
      setBusy(false);
      if (!me || me.role !== "player") {
        await sb.auth.signOut();
        return setErr("Registration complete, but failed to load player profile.");
      }
      onDone(me);
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : "Network error. Please try again.");
    }
  };

  return (
    <div className="min-h-dvh flex flex-col px-5 sm:px-6 pt-5 pb-10 max-w-[480px] mx-auto w-full">
      <div className="mt-4 mb-6">
        <Logo size={0.75} />
      </div>

      {/* Segmented Mode Selector */}
      <div className="flex p-1 rounded-2xl bg-white/[0.06] border border-white/10 mb-6 backdrop-blur-md">
        <button
          type="button"
          onClick={() => {
            setMode("login");
            setErr("");
            setSuccessMsg("");
          }}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 ${
            mode === "login"
              ? "bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 shadow-[0_2px_12px_rgba(245,158,11,0.35)]"
              : "text-white/60 hover:text-white"
          }`}
        >
          <LogIn size={16} /> Sign In
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("register");
            setErr("");
            setSuccessMsg("");
          }}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 ${
            mode === "register"
              ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-[0_2px_12px_rgba(16,185,129,0.35)]"
              : "text-white/60 hover:text-white"
          }`}
        >
          <UserPlus size={16} /> Register (Sign Up)
        </button>
      </div>

      {/* LOGIN MODE */}
      {mode === "login" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitLogin();
          }}
          className="fadein flex flex-col"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Welcome Back</h1>
            <p className="text-xs sm:text-sm text-[var(--ink-soft)] mt-1">
              Sign in with your mobile number &amp; password to play
            </p>
          </div>

          <div className="mt-5 flex items-center gap-3 card px-4 h-14">
            <span className="text-white/80 font-medium text-sm flex items-center gap-1.5">
              <span>🇮🇳</span> +91
            </span>
            <div className="w-px h-6 bg-white/10" />
            <input
              inputMode="numeric"
              autoComplete="username"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                setErr("");
                setSuccessMsg("");
              }}
              placeholder="10-digit Mobile Number"
              className="flex-1 bg-transparent outline-none text-base sm:text-lg tracking-wide placeholder:text-white/25"
            />
          </div>

          <div className="mt-3 card px-4 h-14 flex items-center gap-3">
            <Lock size={18} className="text-white/40 flex-shrink-0" />
            <input
              type={showLoginPw ? "text" : "password"}
              autoComplete="current-password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setErr("");
                setSuccessMsg("");
              }}
              placeholder="Password"
              className="flex-1 bg-transparent outline-none text-base sm:text-lg placeholder:text-white/25"
            />
            <button
              type="button"
              onClick={() => setShowLoginPw(!showLoginPw)}
              className="text-white/40 hover:text-white/80 transition-colors p-1"
            >
              {showLoginPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {err && (
            <div className="mt-3.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed">
              {err}
              {err.toLowerCase().includes("not registered") && (
                <button
                  type="button"
                  onClick={() => {
                    setRegPhone(phone);
                    setMode("register");
                    setErr("");
                  }}
                  className="block mt-1 font-semibold text-amber-300 underline underline-offset-2"
                >
                  Click here to Register Now →
                </button>
              )}
            </div>
          )}

          {successMsg && (
            <div className="mt-3.5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <label className="mt-4 flex items-start gap-2.5 text-xs text-[var(--ink-soft)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="mt-0.5 accent-amber-500 rounded"
            />
            <span>
              I confirm I am 18+ years old and agree to Khelobaazi Terms &amp; Rules.
            </span>
          </label>

          <button
            type="submit"
            disabled={phone.length !== 10 || !pw || !agree || busy}
            className="btn-gold w-full py-3.5 rounded-2xl mt-5 text-base font-bold shadow-[0_4px_20px_rgba(245,158,11,0.25)] flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
                Signing in…
              </span>
            ) : (
              <>
                <LogIn size={18} /> Sign In to Play
              </>
            )}
          </button>

          <div className="mt-6 pt-5 border-t border-white/10 text-center">
            <p className="text-xs text-white/50">
              New player? Don&apos;t have an account yet?
            </p>
            <button
              type="button"
              onClick={() => {
                setRegPhone(phone);
                setMode("register");
                setErr("");
                setSuccessMsg("");
              }}
              className="mt-2 text-sm font-semibold text-emerald-400 hover:text-emerald-300 transition-colors inline-flex items-center gap-1.5"
            >
              <UserPlus size={16} /> Create Free Account / Register Now
            </button>
          </div>
        </form>
      )}

      {/* REGISTER MODE */}
      {mode === "register" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitRegister();
          }}
          className="fadein flex flex-col"
        >
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-white">Player Self-Registration</h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 uppercase tracking-wider">
                Instant
              </span>
            </div>
            <p className="text-xs sm:text-sm text-[var(--ink-soft)] mt-1">
              Create your account in 30 seconds &amp; start playing
            </p>
          </div>

          {/* Full Name */}
          <div className="mt-5 card px-4 h-13 sm:h-14 flex items-center gap-3">
            <User size={18} className="text-white/40 flex-shrink-0" />
            <input
              type="text"
              autoComplete="name"
              value={regName}
              onChange={(e) => {
                setRegName(e.target.value);
                setErr("");
              }}
              placeholder="Full Name (e.g. Rahul Sharma)"
              className="flex-1 bg-transparent outline-none text-base placeholder:text-white/25"
            />
          </div>

          {/* Phone */}
          <div className="mt-3 flex items-center gap-3 card px-4 h-13 sm:h-14">
            <span className="text-white/80 font-medium text-sm flex items-center gap-1.5">
              <span>🇮🇳</span> +91
            </span>
            <div className="w-px h-6 bg-white/10" />
            <input
              inputMode="numeric"
              autoComplete="tel"
              value={regPhone}
              onChange={(e) => {
                setRegPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                setErr("");
              }}
              placeholder="10-digit Mobile Number"
              className="flex-1 bg-transparent outline-none text-base sm:text-lg tracking-wide placeholder:text-white/25"
            />
          </div>

          {/* State Selection */}
          <div className="mt-3 card px-4 h-13 sm:h-14 flex items-center gap-3">
            <MapPin size={18} className="text-white/40 flex-shrink-0" />
            <select
              value={regState}
              onChange={(e) => setRegState(e.target.value)}
              className="flex-1 bg-transparent outline-none text-base text-white/90 [&>option]:bg-slate-900 [&>option]:text-white cursor-pointer"
            >
              <option value="">Select State (Optional)</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Password */}
          <div className="mt-3 card px-4 h-13 sm:h-14 flex items-center gap-3">
            <Lock size={18} className="text-white/40 flex-shrink-0" />
            <input
              type={showRegPw ? "text" : "password"}
              autoComplete="new-password"
              value={regPw}
              onChange={(e) => {
                setRegPw(e.target.value);
                setErr("");
              }}
              placeholder="Set Password (min 6 chars)"
              className="flex-1 bg-transparent outline-none text-base placeholder:text-white/25"
            />
            <button
              type="button"
              onClick={() => setShowRegPw(!showRegPw)}
              className="text-white/40 hover:text-white/80 transition-colors p-1"
            >
              {showRegPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {/* Confirm Password */}
          <div className="mt-3 card px-4 h-13 sm:h-14 flex items-center gap-3">
            <Lock size={18} className="text-white/40 flex-shrink-0" />
            <input
              type={showRegPw ? "text" : "password"}
              autoComplete="new-password"
              value={regConfirmPw}
              onChange={(e) => {
                setRegConfirmPw(e.target.value);
                setErr("");
              }}
              placeholder="Confirm Password"
              className="flex-1 bg-transparent outline-none text-base placeholder:text-white/25"
            />
          </div>

          {/* Optional Referral Code / Agent */}
          <div className="mt-3 card px-4 h-13 sm:h-14 flex items-center gap-3">
            <Gift size={18} className="text-amber-400/70 flex-shrink-0" />
            <input
              type="text"
              value={regReferral}
              onChange={(e) => {
                setRegReferral(e.target.value.toUpperCase());
                setErr("");
              }}
              placeholder="Agent / Referral Code (Optional)"
              className="flex-1 bg-transparent outline-none text-base uppercase tracking-wider placeholder:text-white/25 placeholder:normal-case placeholder:tracking-normal"
            />
            {regReferral && (
              <span className="text-[10px] font-semibold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20">
                Applied
              </span>
            )}
          </div>

          {err && (
            <div className="mt-3.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed">
              {err}
            </div>
          )}

          {successMsg && (
            <div className="mt-3.5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <label className="mt-4 flex items-start gap-2.5 text-xs text-[var(--ink-soft)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="mt-0.5 accent-emerald-500 rounded"
            />
            <span>
              I confirm I am 18+ years old, accept the Terms &amp; Conditions, and agree that gaming chips are for entertainment.
            </span>
          </label>

          <button
            type="submit"
            disabled={
              regName.trim().length < 2 ||
              regPhone.length !== 10 ||
              regPw.length < 6 ||
              regPw !== regConfirmPw ||
              !agree ||
              busy
            }
            className="btn-green w-full py-3.5 rounded-2xl mt-5 text-base font-bold shadow-[0_4px_20px_rgba(16,185,129,0.25)] flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Registering Account…
              </span>
            ) : (
              <>
                <Sparkles size={18} /> Register &amp; Start Playing
              </>
            )}
          </button>

          <div className="mt-6 pt-5 border-t border-white/10 text-center">
            <p className="text-xs text-white/50">
              Already have a player account?
            </p>
            <button
              type="button"
              onClick={() => {
                setPhone(regPhone);
                setMode("login");
                setErr("");
                setSuccessMsg("");
              }}
              className="mt-2 text-sm font-semibold text-amber-400 hover:text-amber-300 transition-colors inline-flex items-center gap-1.5"
            >
              <LogIn size={16} /> Sign In with Existing Mobile Number
            </button>
          </div>
        </form>
      )}

      {/* Support on WhatsApp */}
      {support?.whatsapp && (
        <a
          href={whatsappLink(
            support.whatsapp,
            mode === "register"
              ? "Hi, I need assistance registering my account on Khelobaazi."
              : "Hi, I need help logging into Khelobaazi."
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 flex items-center justify-center gap-1.5 text-xs text-[#25d366] hover:underline"
        >
          <MessageCircle size={15} /> 24x7 Support WhatsApp: {prettyNumber(support.whatsapp)}
        </a>
      )}

      {/* Trust Badges */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-[11px] text-white/40">
        <span className="flex items-center gap-1">
          <ShieldCheck size={14} className="text-emerald-400" /> 100% Verified Gaming
        </span>
        <span className="w-1 h-1 rounded-full bg-white/20" />
        <span>One account per mobile number</span>
      </div>
    </div>
  );
}

export { Login as Auth };
