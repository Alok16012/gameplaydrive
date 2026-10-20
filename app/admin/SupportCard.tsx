"use client";

import { useEffect, useState } from "react";
import { MessageCircle, Check, Copy, ExternalLink, RefreshCw, Sparkles, ShieldCheck } from "lucide-react";
import { errText, supabase } from "../lib/supabase";
import { DEFAULT_ID_MESSAGE, loadSupport, prettyNumber, whatsappLink } from "../lib/support";
import type { Account } from "../lib/hierarchy";

interface SupportCardProps {
  me?: Account;
}

/** Admin & Super Admin: update the WhatsApp number and message for "Contact for ID" & Help Support */
export function SupportCard({ me }: SupportCardProps) {
  const [num, setNum] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState(DEFAULT_ID_MESSAGE);
  const [msg, setMsg] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadSupport(true).then((s) => {
      setNum(s.whatsapp ? prettyNumber(s.whatsapp) : "");
      setNote(s.note ?? "24x7 Instant ID & Quick Support");
      setMessage(s.message || DEFAULT_ID_MESSAGE);
    });
  }, []);

  const cleanNum = num.replace(/\D/g, "");
  const formattedForLink = cleanNum.length === 10 ? `91${cleanNum}` : cleanNum;
  const previewLink = whatsappLink(formattedForLink || "919876543210", message);

  const save = async () => {
    setBusy(true);
    setMsg("");
    setIsSuccess(false);

    try {
      // 1. Try server API with authorization token
      const { data: s } = await supabase().auth.getSession();
      const token = s?.session?.access_token;

      let apiSuccess = false;
      if (token) {
        const res = await fetch("/api/support-contact", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            whatsapp: num,
            note,
            message,
          }),
        });

        if (res.ok) {
          const json = await res.json();
          if (json.success) {
            apiSuccess = true;
            setNum(json.support.whatsapp ? prettyNumber(json.support.whatsapp) : "");
            setNote(json.support.note ?? "");
            setMessage(json.support.message || DEFAULT_ID_MESSAGE);
          }
        }
      }

      // 2. Fallback to direct RPC if API was not used or failed
      if (!apiSuccess) {
        const { data, error } = await supabase().rpc("set_support_contact", {
          p_whatsapp: num,
          p_note: note,
          p_message: message,
        } as any);

        if (error) {
          // If RPC doesn't accept p_message, try with 2 params
          const fallback = await supabase().rpc("set_support_contact", {
            p_whatsapp: num,
            p_note: note,
          });
          if (fallback.error) {
            setBusy(false);
            return setMsg(errText(fallback.error));
          }
        }
      }

      await loadSupport(true);
      setBusy(false);
      setIsSuccess(true);
      setMsg(
        num.trim()
          ? `✓ Saved! Players will now be redirected to WhatsApp (${num}) to get their ID.`
          : "✓ Support number cleared."
      );
    } catch (e) {
      setBusy(false);
      setMsg(e instanceof Error ? e.message : "Failed to save settings");
    }
  };

  return (
    <div className="card p-5 bg-[#0b102e] border border-white/10 rounded-2xl space-y-5 shadow-xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#25d366]/15 border border-[#25d366]/30 flex items-center justify-center text-[#25d366] shadow-sm">
            <MessageCircle size={22} className="fill-[#25d366]/20" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              Contact for ID — WhatsApp Configuration
            </h2>
            <p className="text-xs text-white/50">
              Update the WhatsApp number where players are redirected when clicking &quot;Contact for ID&quot; on the login page.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="px-3 py-1 rounded-full text-[11px] font-semibold bg-[#25d366]/10 text-[#25d366] border border-[#25d366]/20 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#25d366] animate-pulse" />
            Live on Login Screen
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Form Controls */}
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-white/80 uppercase tracking-wider mb-1.5">
              WhatsApp Support Mobile Number <span className="text-rose-400">*</span>
            </label>
            <div className="relative">
              <input
                value={num}
                onChange={(e) => {
                  setNum(e.target.value);
                  setMsg("");
                  setIsSuccess(false);
                }}
                placeholder="e.g. 9876543210 or +91 98765 43210"
                inputMode="tel"
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-sm text-white font-mono outline-none focus:border-[#25d366]/60 transition"
              />
            </div>
            <p className="text-[11px] text-white/40 mt-1">
              Enter 10-digit Indian number or full international number. 🇮🇳 +91 is auto-added if 10 digits.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-white/80 uppercase tracking-wider">
                Pre-Filled Message for Players
              </label>
              <button
                type="button"
                onClick={() => setMessage(DEFAULT_ID_MESSAGE)}
                className="text-[11px] text-sky-400 hover:text-sky-300 underline"
              >
                Reset to Default
              </button>
            </div>
            <textarea
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setMsg("");
                setIsSuccess(false);
              }}
              rows={3}
              placeholder="Message sent by player when clicking Contact for ID"
              className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[#25d366]/60 transition resize-none"
            />
            <p className="text-[11px] text-white/40 mt-1">
              This message will automatically open in the player&apos;s WhatsApp chat.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-white/80 uppercase tracking-wider mb-1.5">
              Optional Note / Tagline
            </label>
            <input
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setMsg("");
                setIsSuccess(false);
              }}
              placeholder="e.g. 24x7 Instant ID & Quick Support"
              maxLength={140}
              className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[#25d366]/60 transition"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="px-6 py-2.5 rounded-xl text-sm font-bold bg-[#25d366] hover:bg-[#20ba59] text-slate-950 shadow-[0_4px_16px_rgba(37,211,102,0.3)] transition flex items-center gap-2 active:scale-95 disabled:opacity-50"
            >
              {busy ? (
                <>
                  <RefreshCw size={15} className="animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Check size={16} /> Save WhatsApp Number
                </>
              )}
            </button>

            <a
              href={previewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 text-white/80 hover:text-white border border-white/10 transition flex items-center gap-1.5"
            >
              <ExternalLink size={14} /> Test on WhatsApp
            </a>
          </div>

          {msg && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                isSuccess
                  ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium"
                  : "bg-rose-500/15 border border-rose-500/30 text-rose-300"
              }`}
            >
              {msg}
            </div>
          )}
        </div>

        {/* Live Preview Card */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-4">
          <div className="text-xs font-bold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles size={14} className="text-amber-400" /> Player Login Screen Preview
          </div>

          <div className="rounded-xl border border-white/10 bg-[#070b22] p-4 space-y-3">
            <div className="text-[11px] text-white/40">1. Header Mode Button:</div>
            <div className="flex p-1 rounded-2xl bg-white/[0.06] border border-white/10">
              <div className="flex-1 py-2 text-center text-xs font-semibold text-white/60">
                Sign In
              </div>
              <div className="flex-1 py-2 rounded-xl text-xs font-semibold text-[#25d366] bg-[#25d366]/20 border border-[#25d366]/30 flex items-center justify-center gap-1.5">
                <MessageCircle size={14} className="fill-[#25d366]" /> Contact for ID
              </div>
            </div>

            <div className="text-[11px] text-white/40 pt-2">2. Bottom ID Request Button:</div>
            <div className="text-center">
              <div className="text-xs text-white/50 mb-1.5">
                New player? Don&apos;t have an ID yet?
              </div>
              <div className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-emerald-500 to-green-600 inline-flex items-center gap-1.5 shadow-md">
                <MessageCircle size={15} /> Contact on WhatsApp for ID
              </div>
            </div>

            <div className="text-[11px] text-white/40 pt-2">3. Pre-filled Message that WhatsApp opens:</div>
            <div className="p-3 rounded-xl bg-white/5 border border-white/10 text-xs font-mono text-emerald-300/90 break-words leading-relaxed">
              &ldquo;{message}&rdquo;
            </div>

            <div className="text-[11px] text-white/40 pt-1 flex items-center justify-between">
              <span>Target Phone: <b className="text-white font-mono">{cleanNum ? prettyNumber(cleanNum) : "(No number set yet)"}</b></span>
              <span className="text-emerald-400 font-semibold">Active</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { SupportCard as WhatsAppContactSettings };
