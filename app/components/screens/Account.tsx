"use client";

import { useState } from "react";
import { BadgeCheck, ChevronRight, CircleHelp, Clock3, FileCheck2, Globe, HeartHandshake, History, LogOut, Mail, MessageCircle, Settings as SettingsIcon, ShieldCheck, Wallet as WalletIcon, ChevronDown, Phone, Landmark, IdCard } from "lucide-react";
import { FAQS, GAME_HISTORY, USER, gameById, inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import { GameThumb } from "../GameArt";
import { Avatar, Header, Toggle } from "../ui";
import type { Nav } from "../nav";

export function More({ nav }: { nav: Nav }) {
  const items: { icon: React.ReactNode; label: string; right?: React.ReactNode; go: () => void; danger?: boolean }[] = [
    { icon: <WalletIcon size={19} />, label: "Wallet", go: () => nav.reset({ name: "wallet" }) },
    { icon: <History size={19} />, label: "Game History", go: () => nav.push({ name: "history" }) },
    { icon: <FileCheck2 size={19} />, label: "KYC Verification", right: <span className="text-xs text-neon-400">Verified</span>, go: () => nav.push({ name: "kyc" }) },
    { icon: <CircleHelp size={19} />, label: "Help & Support", go: () => nav.push({ name: "help" }) },
    { icon: <SettingsIcon size={19} />, label: "Settings", go: () => nav.push({ name: "settings" }) },
    { icon: <HeartHandshake size={19} />, label: "Responsible Gaming", right: <ChevronRight size={18} className="text-white/40" />, go: () => nav.push({ name: "rg" }) },
    { icon: <LogOut size={19} className="text-rose-400" />, label: "Logout", go: nav.logout },
  ];
  return (
    <div className="pb-28 fadein">
      <div className="px-4 pt-7 flex items-center gap-3.5">
        <Avatar size={58} />
        <div className="flex-1">
          <div className="text-lg font-semibold">{USER.name}</div>
          <div className="text-[11px] text-[var(--ink-soft)]">ID: {USER.id}</div>
          <span className="inline-flex items-center gap-1 mt-1 pill px-2 py-0.5 text-[10px] bg-neon-400/15 text-neon-400"><BadgeCheck size={12} /> Verified</span>
        </div>
        <button onClick={() => nav.push({ name: "settings" })} aria-label="Settings"><SettingsIcon size={22} /></button>
      </div>

      <div className="px-4 mt-5 grid grid-cols-3 gap-2.5">
        {[["142", "Games played"], ["58%", "Win rate"], ["₹6,420", "Total won"]].map(([v, l]) => (
          <div key={l} className="card py-3 text-center"><div className="font-semibold">{v}</div><div className="text-[10px] text-[var(--ink-soft)]">{l}</div></div>
        ))}
      </div>

      <div className="px-4 mt-4">
        <div className="card divide-y divide-white/5">
          {items.map((it) => (
            <button key={it.label} onClick={it.go} className="w-full flex items-center gap-3.5 px-4 py-4 text-left text-sm">
              <span className="text-white/80">{it.icon}</span>
              <span className="flex-1">{it.label}</span>
              {it.right}
            </button>
          ))}
        </div>
        <div className="text-center text-[10px] text-white/30 mt-6">GameHub v1.0.0 (demo) • 18+ only • Play responsibly</div>
      </div>
    </div>
  );
}

export function GameHistory({ nav }: { nav: Nav }) {
  return (
    <div className="pb-10 fadein">
      <Header title="Game History" onBack={nav.back} />
      <div className="px-4 space-y-2.5">
        {GAME_HISTORY.map((h, i) => {
          const g = gameById(h.game);
          return (
            <div key={i} className="card p-2.5 flex items-center gap-3">
              <GameThumb game={g} className="w-14 h-14 shrink-0 [&>*]:scale-[.55]" />
              <div className="flex-1">
                <div className="text-sm font-medium">{g.name}</div>
                <div className="text-[11px] text-[var(--ink-soft)]">{h.table} • {h.when}</div>
              </div>
              <div className="text-right pr-1">
                <div className={`text-[10px] pill px-2 py-0.5 inline-block ${h.result === "Won" ? "bg-neon-400/15 text-neon-400" : h.result === "Lost" ? "bg-rose-500/15 text-rose-400" : "bg-white/10 text-white/70"}`}>{h.result}</div>
                <div className={`text-sm font-semibold mt-1 ${h.amount > 0 ? "text-neon-400" : h.amount < 0 ? "text-rose-400" : "text-white/60"}`}>{h.amount > 0 ? "+" : h.amount < 0 ? "-" : ""}{inr(h.amount)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Kyc({ nav }: { nav: Nav }) {
  const steps = [
    { icon: <Phone size={18} />, t: "Mobile Number", s: USER.phone },
    { icon: <Mail size={18} />, t: "Email", s: USER.email },
    { icon: <IdCard size={18} />, t: "PAN Card", s: "ABCPS••••K" },
    { icon: <IdCard size={18} />, t: "Aadhaar (Age 18+)", s: "•••• •••• 7712" },
    { icon: <Landmark size={18} />, t: "Bank Account", s: USER.bank },
  ];
  return (
    <div className="pb-10 fadein">
      <Header title="KYC Verification" onBack={nav.back} />
      <div className="px-4">
        <div className="balance-card p-5 flex items-center gap-4">
          <ShieldCheck size={44} className="text-neon-400" />
          <div><div className="font-semibold text-lg">You're fully verified</div><div className="text-xs text-white/70">Withdrawals are unlocked for your account.</div></div>
        </div>
        <div className="card mt-4 divide-y divide-white/5">
          {steps.map((st) => (
            <div key={st.t} className="flex items-center gap-3 p-4">
              <span className="w-9 h-9 rounded-xl bg-white/5 grid place-items-center text-white/80">{st.icon}</span>
              <div className="flex-1"><div className="text-sm font-medium">{st.t}</div><div className="text-[11px] text-[var(--ink-soft)]">{st.s}</div></div>
              <BadgeCheck size={20} className="text-neon-400" />
            </div>
          ))}
        </div>
        <div className="text-[11px] text-white/40 mt-4 px-1">Your documents are encrypted (AES-256) and used only for identity, age and payout verification.</div>
      </div>
    </div>
  );
}

function LimitSlider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: "₹" | "min"; onChange: (v: number) => void }) {
  return (
    <div className="p-4">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="font-semibold text-neon-400">{unit === "₹" ? inr(value) : `${value} min`}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full mt-3 accent-green-400" />
    </div>
  );
}

export function ResponsibleGaming({ nav }: { nav: Nav }) {
  const { limits, setLimits, showToast } = useStore();
  const [l, setL] = useState(limits);
  const [brk, setBrk] = useState<string | null>(null);
  return (
    <div className="pb-10 fadein">
      <Header title="Responsible Gaming" onBack={nav.back} />
      <div className="px-4">
        <div className="text-sm text-[var(--ink-soft)]">Set limits that keep gaming fun. Lower limits apply instantly; higher limits take effect after 24 hours.</div>
        <div className="card mt-4 divide-y divide-white/5">
          <LimitSlider label="Daily deposit limit" value={l.deposit} min={500} max={50000} step={500} unit="₹" onChange={(v) => setL({ ...l, deposit: v })} />
          <LimitSlider label="Daily loss limit" value={l.loss} min={500} max={25000} step={500} unit="₹" onChange={(v) => setL({ ...l, loss: v })} />
          <LimitSlider label="Session time limit" value={l.session} min={15} max={480} step={15} unit="min" onChange={(v) => setL({ ...l, session: v })} />
        </div>
        <button onClick={() => { setLimits(l); showToast("Limits saved"); }} className="btn-green w-full py-3 rounded-2xl mt-4">Save Limits</button>

        <div className="text-sm font-semibold mt-7 mb-2">Take a break</div>
        <div className="grid grid-cols-3 gap-2">
          {["24 hours", "7 days", "30 days"].map((d) => (
            <button key={d} onClick={() => setBrk(d)} className={`card py-3 text-sm ${brk === d ? "!border-neon-400 text-neon-400" : ""}`}>{d}</button>
          ))}
        </div>
        <button disabled={!brk} onClick={() => showToast(`Self-exclusion for ${brk} (demo)`)} className="btn-ghost w-full py-3 rounded-2xl mt-3 text-sm disabled:opacity-40">Self-exclude {brk ? `for ${brk}` : ""}</button>
        <div className="card mt-6 p-4 flex gap-3 text-xs text-[var(--ink-soft)]">
          <Clock3 size={18} className="shrink-0 text-gold-400" />
          Need to talk? Reach out to our support team anytime, or contact a professional counselling helpline.
        </div>
      </div>
    </div>
  );
}

export function Help({ nav }: { nav: Nav }) {
  const [open, setOpen] = useState<number | null>(0);
  const { showToast } = useStore();
  return (
    <div className="pb-10 fadein">
      <Header title="Help & Support" onBack={nav.back} />
      <div className="px-4">
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => showToast("Chat support (demo)")} className="card p-4 text-left"><MessageCircle className="text-neon-400" /><div className="text-sm font-medium mt-2">Live Chat</div><div className="text-[11px] text-[var(--ink-soft)]">24×7 • ~2 min reply</div></button>
          <button onClick={() => showToast("support@gamehub.demo")} className="card p-4 text-left"><Mail className="text-sky-300" /><div className="text-sm font-medium mt-2">Email us</div><div className="text-[11px] text-[var(--ink-soft)]">Reply within 24 hrs</div></button>
        </div>
        <div className="text-sm font-semibold mt-6 mb-2">FAQs</div>
        <div className="card divide-y divide-white/5">
          {FAQS.map((f, i) => (
            <div key={i}>
              <button onClick={() => setOpen(open === i ? null : i)} className="w-full flex items-center gap-3 p-4 text-left text-sm">
                <span className="flex-1">{f.q}</span>
                <ChevronDown size={18} className={`transition-transform text-white/50 ${open === i ? "rotate-180" : ""}`} />
              </button>
              {open === i && <div className="px-4 pb-4 -mt-1 text-xs text-[var(--ink-soft)] leading-relaxed fadein">{f.a}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Settings({ nav }: { nav: Nav }) {
  const [s, setS] = useState({ sound: true, music: false, vibration: true, push: true, whatsapp: true });
  const rows: [keyof typeof s, string][] = [["sound", "Sound effects"], ["music", "Background music"], ["vibration", "Vibration"], ["push", "Push notifications"], ["whatsapp", "WhatsApp updates"]];
  return (
    <div className="pb-10 fadein">
      <Header title="Settings" onBack={nav.back} />
      <div className="px-4">
        <div className="card divide-y divide-white/5">
          {rows.map(([k, label]) => (
            <div key={k} className="flex items-center justify-between p-4 text-sm">{label}<Toggle on={s[k]} onChange={(v) => setS({ ...s, [k]: v })} /></div>
          ))}
        </div>
        <div className="card mt-4 divide-y divide-white/5 text-sm">
          <div className="flex items-center gap-3 p-4"><Globe size={18} className="text-white/70" /><span className="flex-1">Language</span><span className="text-white/60">English</span></div>
          <div className="flex items-center gap-3 p-4"><FileCheck2 size={18} className="text-white/70" /><span className="flex-1">Terms & Conditions</span><ChevronRight size={18} className="text-white/40" /></div>
          <div className="flex items-center gap-3 p-4"><ShieldCheck size={18} className="text-white/70" /><span className="flex-1">Privacy Policy</span><ChevronRight size={18} className="text-white/40" /></div>
          <div className="flex items-center gap-3 p-4"><Globe size={18} className="text-white/70" /><span className="flex-1">Fair Play Policy</span><ChevronRight size={18} className="text-white/40" /></div>
        </div>
      </div>
    </div>
  );
}
