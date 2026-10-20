"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, X } from "lucide-react";
import { changeMyPassword } from "../lib/hierarchy";

const inputCls = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400 transition-colors";

/**
 * Full-screen modal that forces the user to change their password.
 * Cannot be dismissed — no close button, no backdrop click.
 * Used on first login when must_change_password is true.
 */
export function ForceChangePasswordModal({ onDone }: { onDone: () => void }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!oldPw) return setErr("Enter your current password");
    if (newPw.length < 6) return setErr("New password must be at least 6 characters");
    if (newPw !== confirmPw) return setErr("Passwords do not match");
    if (oldPw === newPw) return setErr("New password must be different from the current one");

    setBusy(true);
    setErr("");
    try {
      await changeMyPassword(oldPw, newPw);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to change password");
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm grid place-items-center p-4">
        <div className="card w-full max-w-sm p-6 bg-[#0d1335] text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-neon-400/15 grid place-items-center mb-4">
            <ShieldCheck size={32} className="text-neon-400" />
          </div>
          <div className="text-xl font-semibold">Password Updated! ✅</div>
          <div className="text-sm text-white/60 mt-2">Your password has been changed successfully. Remember your new password for future logins.</div>
          <button onClick={onDone} className="btn-green w-full py-3 rounded-xl mt-6 text-sm font-medium">
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm grid place-items-center p-4">
      <div className="card w-full max-w-sm p-6 bg-[#0d1335] animate-[slideUp_0.3s_ease-out]">
        {/* Header */}
        <div className="text-center mb-5">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-400/15 grid place-items-center mb-3">
            <KeyRound size={28} className="text-amber-400" />
          </div>
          <div className="text-lg font-semibold">Update Your Password</div>
          <div className="text-xs text-white/50 mt-1">
            For your security, please change the temporary password that was given to you.
          </div>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
          {/* Old Password */}
          <label className="block text-xs text-white/60">
            Current password
            <div className="relative mt-1">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type={showOld ? "text" : "password"}
                value={oldPw}
                onChange={(e) => { setOldPw(e.target.value); setErr(""); }}
                placeholder="Enter current password"
                autoComplete="current-password"
                autoFocus
                className={`${inputCls} pl-9 pr-10`}
              />
              <button type="button" onClick={() => setShowOld(!showOld)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40" tabIndex={-1}>
                {showOld ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {/* New Password */}
          <label className="block text-xs text-white/60">
            New password <span className="text-white/40">(min 6 characters)</span>
            <div className="relative mt-1">
              <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type={showNew ? "text" : "password"}
                value={newPw}
                onChange={(e) => { setNewPw(e.target.value); setErr(""); }}
                placeholder="Enter new password"
                autoComplete="new-password"
                className={`${inputCls} pl-9 pr-10`}
              />
              <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40" tabIndex={-1}>
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {/* Confirm Password */}
          <label className="block text-xs text-white/60">
            Confirm new password
            <div className="relative mt-1">
              <ShieldCheck size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => { setConfirmPw(e.target.value); setErr(""); }}
                placeholder="Re-enter new password"
                autoComplete="new-password"
                className={`${inputCls} pl-9`}
              />
            </div>
          </label>

          {/* Password strength indicator */}
          {newPw && (
            <div className="flex gap-1 mt-1">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${
                  newPw.length >= i * 3
                    ? newPw.length >= 12 ? "bg-neon-400" : newPw.length >= 8 ? "bg-amber-400" : "bg-rose-400"
                    : "bg-white/10"
                }`} />
              ))}
              <span className="text-[10px] ml-1 text-white/40">
                {newPw.length >= 12 ? "Strong" : newPw.length >= 8 ? "Good" : newPw.length >= 6 ? "Fair" : "Weak"}
              </span>
            </div>
          )}

          {err && <div className="text-xs text-rose-300 bg-rose-400/10 rounded-lg px-3 py-2">{err}</div>}

          <button type="submit" disabled={busy} className="btn-green w-full py-3 rounded-xl text-sm font-medium !mt-5">
            {busy ? "Updating…" : "Update Password"}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Optional modal for voluntarily changing your password.
 * Has a close button. Used from Settings / Admin sidebar.
 */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!oldPw) return setErr("Enter your current password");
    if (newPw.length < 6) return setErr("New password must be at least 6 characters");
    if (newPw !== confirmPw) return setErr("Passwords do not match");
    if (oldPw === newPw) return setErr("New password must be different from the current one");

    setBusy(true);
    setErr("");
    try {
      await changeMyPassword(oldPw, newPw);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to change password");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="card w-full max-w-sm p-6 bg-[#0d1335]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-lg font-semibold flex items-center gap-2">
            <KeyRound size={20} className="text-amber-400" />
            {done ? "Password Changed" : "Change Password"}
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white/80" aria-label="Close"><X size={18} /></button>
        </div>

        {done ? (
          <>
            <div className="rounded-xl bg-neon-400/10 border border-neon-400/20 p-4 text-sm text-center">
              <ShieldCheck size={32} className="text-neon-400 mx-auto mb-2" />
              <div className="font-medium">Password updated successfully!</div>
              <div className="text-xs text-white/60 mt-1">Use your new password next time you sign in.</div>
            </div>
            <button onClick={onClose} className="btn-green w-full py-2.5 rounded-xl mt-5 text-sm">Done</button>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
            <label className="block text-xs text-white/60">
              Current password
              <div className="relative mt-1">
                <input
                  type={showOld ? "text" : "password"}
                  value={oldPw}
                  onChange={(e) => { setOldPw(e.target.value); setErr(""); }}
                  autoComplete="current-password"
                  autoFocus
                  className={`${inputCls} pr-10`}
                />
                <button type="button" onClick={() => setShowOld(!showOld)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40" tabIndex={-1}>
                  {showOld ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            <label className="block text-xs text-white/60">
              New password <span className="text-white/40">(min 6 characters)</span>
              <div className="relative mt-1">
                <input
                  type={showNew ? "text" : "password"}
                  value={newPw}
                  onChange={(e) => { setNewPw(e.target.value); setErr(""); }}
                  autoComplete="new-password"
                  className={`${inputCls} pr-10`}
                />
                <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40" tabIndex={-1}>
                  {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            <label className="block text-xs text-white/60">
              Confirm new password
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => { setConfirmPw(e.target.value); setErr(""); }}
                autoComplete="new-password"
                className={`${inputCls} mt-1`}
              />
            </label>

            {err && <div className="text-xs text-rose-300">{err}</div>}

            <button type="submit" disabled={busy} className="btn-green w-full py-2.5 rounded-xl text-sm !mt-5">
              {busy ? "Updating…" : "Update Password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Superior resets subordinate's password (e.g., Admin resets Agent/Player).
 * Forces must_change_password on the target so they change it upon first login.
 */
export function ResetSubordinatePasswordModal({
  target,
  onClose,
  onSuccess,
}: {
  target: { id: string; role: string; name: string; username?: string | null; phone?: string | null; code?: string };
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  const generateRandom = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$";
    let pw = "";
    for (let i = 0; i < 8; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
    setNewPw(pw);
    setConfirmPw(pw);
    setShowNew(true);
    setErr("");
  };

  const loginIdentifier = target.role === "player" ? (target.phone ?? target.username ?? target.code) : (target.username ?? target.phone ?? target.code);

  const submit = async () => {
    if (!newPw) return setErr("Enter a new password");
    if (newPw.length < 6) return setErr("Password must be at least 6 characters");
    if (newPw !== confirmPw) return setErr("Passwords do not match");

    setBusy(true);
    setErr("");
    try {
      const { resetSubordinatePassword } = await import("../lib/hierarchy");
      await resetSubordinatePassword(target.id, newPw);
      setDone(true);
      onSuccess?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to reset password");
    }
    setBusy(false);
  };

  const copyCreds = () => {
    const text = `🎮 Khelobaazi Credentials\nName: ${target.name}\nRole: ${target.role.toUpperCase()}\nLogin: ${loginIdentifier}\nTemporary Password: ${newPw}\n\nNote: You will be prompted to change your password immediately upon login.`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 grid place-items-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-sm p-6 bg-[#0d1335] border border-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-base font-semibold flex items-center gap-2">
            <KeyRound size={20} className="text-amber-400" />
            {done ? "Password Reset Complete" : `Reset Password`}
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white/80" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-neon-400/10 border border-neon-400/20 p-4 text-center">
              <ShieldCheck size={32} className="text-neon-400 mx-auto mb-2" />
              <div className="font-semibold text-sm">New Password Set!</div>
              <div className="text-xs text-white/60 mt-1">
                The user will be required to change this password as soon as they log in.
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-xl p-3.5 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-white/50">Account</span>
                <span className="font-medium text-white">{target.name} ({target.code})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Login {target.role === "player" ? "Mobile" : "Username"}</span>
                <span className="font-mono text-sky-300 font-bold">{loginIdentifier}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-white/50">New Password</span>
                <span className="font-mono text-amber-300 font-bold bg-amber-400/10 px-2 py-0.5 rounded">{newPw}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={copyCreds}
                className="btn-green flex-1 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                {copied ? "Copied to Clipboard! ✓" : "Copy Credentials"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/15 text-white transition"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
            {/* User info banner */}
            <div className="rounded-xl bg-white/5 border border-white/5 p-3 text-xs flex justify-between items-center">
              <div>
                <div className="font-medium text-white">{target.name}</div>
                <div className="text-[11px] text-white/50">{target.code} • {target.role.toUpperCase()}</div>
              </div>
              <span className="text-[11px] font-mono text-sky-300 bg-sky-500/10 px-2 py-1 rounded">
                {loginIdentifier}
              </span>
            </div>

            <div className="flex justify-between items-center pt-1">
              <span className="text-xs text-white/60">New Password</span>
              <button
                type="button"
                onClick={generateRandom}
                className="text-[11px] text-neon-400 hover:underline inline-flex items-center gap-1 font-medium"
              >
                ⚡ Generate random
              </button>
            </div>

            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPw}
                onChange={(e) => { setNewPw(e.target.value); setErr(""); }}
                placeholder="Enter new temporary password"
                autoComplete="new-password"
                autoFocus
                className={`${inputCls} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40"
                tabIndex={-1}
              >
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <label className="block text-xs text-white/60">
              Confirm Password
              <input
                type={showNew ? "text" : "password"}
                value={confirmPw}
                onChange={(e) => { setConfirmPw(e.target.value); setErr(""); }}
                placeholder="Re-enter new password"
                autoComplete="new-password"
                className={`${inputCls} mt-1`}
              />
            </label>

            <div className="rounded-lg bg-amber-400/10 border border-amber-400/20 p-2.5 text-[11px] text-amber-200">
              🔒 When this user logs in, they will get a popup asking them to set their own permanent password.
            </div>

            {err && <div className="text-xs text-rose-300 bg-rose-500/10 p-2 rounded-lg">{err}</div>}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 text-white transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="btn-green flex-1 py-2.5 rounded-xl text-xs font-semibold"
              >
                {busy ? "Updating…" : "Set Password"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
