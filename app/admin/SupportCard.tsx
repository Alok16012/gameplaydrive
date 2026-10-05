"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { errText, supabase } from "../lib/supabase";
import { loadSupport, prettyNumber } from "../lib/support";

/** Super Admin: the WhatsApp number every player sees under Help & Support (and on the login page). */
export function SupportCard() {
  const [num, setNum] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadSupport(true).then((s) => { setNum(s.whatsapp ? prettyNumber(s.whatsapp) : ""); setNote(s.note ?? ""); });
  }, []);
  const save = async () => {
    setBusy(true);
    const { data, error } = await supabase().rpc("set_support_contact", { p_whatsapp: num, p_note: note });
    setBusy(false);
    if (error) return setMsg(/set_support_contact/.test(errText(error)) ? "Run migration 021_support_contact.sql first" : errText(error));
    const s = (data ?? {}) as { whatsapp?: string };
    setNum(s.whatsapp ? prettyNumber(s.whatsapp) : "");
    loadSupport(true);
    setMsg(s.whatsapp ? "Saved — players see this number under Help & Support" : "Removed — no support number is shown");
  };
  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center gap-2 font-semibold"><MessageCircle size={18} className="text-[#25d366]" />Help & Support — WhatsApp</div>
      <div className="text-xs text-white/50 mt-1">Shown to every player on the Help screen and the login page. Leave empty to hide it.</div>
      <div className="grid sm:grid-cols-[1fr_1.4fr_auto] gap-2 mt-3">
        <input value={num} onChange={(e) => { setNum(e.target.value); setMsg(""); }} placeholder="+91 98765 43210" inputMode="tel" className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-white/30" />
        <input value={note} onChange={(e) => { setNote(e.target.value); setMsg(""); }} placeholder="Note (optional), e.g. Mon–Sat, 10am–8pm" maxLength={140} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-white/30" />
        <button disabled={busy} onClick={save} className="btn-green rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
      </div>
      {msg && <div className="text-xs text-white/70 mt-2">{msg}</div>}
    </div>
  );
}
