"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  MessageCircle,
  QrCode,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import type { Account } from "../lib/hierarchy";
import { supabase } from "../lib/supabase";

interface PaymentState {
  upiId: string;
  payeeName: string;
  phone: string;
  paymentNote: string;
  qrCodeUrl: string;
  isActive: boolean;
}

const UPI_HANDLES = ["@okhdfcbank", "@okaxis", "@oksbi", "@paytm", "@ybl", "@ibl", "@kotak"];

export function AgentPaymentView({ me }: { me: Account }) {
  const [data, setData] = useState<PaymentState>({
    upiId: "",
    payeeName: me.name,
    phone: me.phone ?? "",
    paymentNote: "After making payment, please send screenshot along with your Player ID on WhatsApp to get coins added.",
    qrCodeUrl: "",
    isActive: true,
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [qrMode, setQrMode] = useState<"auto" | "custom">("auto");
  const [generatedQr, setGeneratedQr] = useState<string>("");
  const [customQrImage, setCustomQrImage] = useState<string>("");
  const [copiedPreview, setCopiedPreview] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing payment settings
  useEffect(() => {
    let active = true;
    async function fetchSettings() {
      try {
        const { data: s } = await supabase().auth.getSession();
        const token = s.session?.access_token;
        if (!token) return;

        const res = await fetch("/api/agent-payment", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (active && res.ok && json.details) {
          const d = json.details;
          setData({
            upiId: d.upiId || "",
            payeeName: d.payeeName || me.name,
            phone: d.phone || me.phone || "",
            paymentNote: d.paymentNote || "After making payment, please send screenshot along with your Player ID on WhatsApp to get coins added.",
            qrCodeUrl: d.qrCodeUrl || "",
            isActive: d.isActive !== false,
          });

          if (d.qrCodeUrl) {
            setCustomQrImage(d.qrCodeUrl);
            setQrMode("custom");
          }
        }
      } catch (e) {
        console.error("Error loading agent payment settings:", e);
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchSettings();
    return () => {
      active = false;
    };
  }, [me]);

  // Generate QR preview automatically whenever upiId or payeeName changes
  useEffect(() => {
    const upi = data.upiId.trim();
    if (!upi) {
      setGeneratedQr("");
      return;
    }

    const uri = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(data.payeeName.trim() || me.name)}&cu=INR`;
    QRCode.toDataURL(uri, {
      width: 480,
      margin: 2,
      color: { dark: "#0a0f2c", light: "#ffffff" },
      errorCorrectionLevel: "H",
    })
      .then((url) => setGeneratedQr(url))
      .catch((err) => console.error("QR generation failed:", err));
  }, [data.upiId, data.payeeName, me.name]);

  // Handle image upload from computer / phone
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setMsg({ type: "error", text: "Please upload an image file (PNG, JPG, WEBP)" });
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setMsg({ type: "error", text: "Image size should be less than 2 MB" });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setCustomQrImage(result);
      setQrMode("custom");
      setData((prev) => ({ ...prev, qrCodeUrl: result }));
      setMsg(null);
    };
    reader.readAsDataURL(file);
  };

  // Quick append UPI handle
  const appendHandle = (handle: string) => {
    const current = data.upiId.trim();
    if (!current) {
      setData((d) => ({ ...d, upiId: `user${handle}` }));
      return;
    }
    const base = current.split("@")[0];
    setData((d) => ({ ...d, upiId: `${base}${handle}` }));
  };

  // Save settings
  const handleSave = async () => {
    setSaving(true);
    setMsg(null);

    const upi = data.upiId.trim();
    if (data.isActive && !upi && !customQrImage) {
      setMsg({ type: "error", text: "Please provide either a UPI ID or upload a QR Code image." });
      setSaving(false);
      return;
    }

    if (upi && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upi)) {
      setMsg({ type: "error", text: "Invalid UPI ID format. Example: yourname@oksbi, 9876543210@paytm" });
      setSaving(false);
      return;
    }

    const finalQr = qrMode === "custom" ? customQrImage : (generatedQr || "");

    try {
      const { data: s } = await supabase().auth.getSession();
      const token = s.session?.access_token;
      if (!token) throw new Error("Please sign in again");

      const res = await fetch("/api/agent-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          upiId: upi,
          payeeName: data.payeeName.trim() || me.name,
          phone: data.phone.trim(),
          paymentNote: data.paymentNote.trim(),
          qrCodeUrl: finalQr,
          isActive: data.isActive,
          generateQr: qrMode === "auto",
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to save payment details");
      }

      setMsg({ type: "success", text: "Payment details saved successfully! Your players can now see these details in their wallet." });
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : "Error saving payment settings";
      setMsg({ type: "error", text: err });
    } finally {
      setSaving(false);
    }
  };

  const activeQr = qrMode === "custom" && customQrImage ? customQrImage : generatedQr;
  const cleanPhone = data.phone.replace(/\D/g, "").slice(-10);

  if (loading) {
    return (
      <div className="card p-8 text-center text-white/50 animate-pulse">
        <QrCode className="mx-auto mb-3 text-neon-400" size={32} />
        Loading your payment settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Title Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-neon-400/10 text-neon-400">
              <QrCode size={22} />
            </span>
            Agent UPI & QR Code Settings
          </h1>
          <p className="text-sm text-white/50 mt-1">
            Add your UPI ID and QR code so your players can pay you directly for coins. Only players created by you can see these details.
          </p>
        </div>

        {/* Status Toggle */}
        <div className="flex items-center gap-3 bg-white/5 border border-white/10 px-4 py-2.5 rounded-2xl shrink-0 self-start sm:self-auto">
          <span className="text-xs font-medium text-white/80">Accept Online Deposits:</span>
          <button
            type="button"
            onClick={() => setData((d) => ({ ...d, isActive: !d.isActive }))}
            className={`w-12 h-6 rounded-full p-0.5 transition-colors ${data.isActive ? "bg-neon-500" : "bg-white/15"}`}
            aria-label="Toggle active status"
          >
            <div className={`w-5 h-5 rounded-full bg-white transition-transform ${data.isActive ? "translate-x-6" : ""}`} />
          </button>
          <span className={`text-xs font-semibold ${data.isActive ? "text-neon-400" : "text-white/40"}`}>
            {data.isActive ? "Active" : "Disabled"}
          </span>
        </div>
      </div>

      {msg && (
        <div
          className={`card p-4 flex items-center gap-3 text-sm ${
            msg.type === "success"
              ? "bg-neon-500/15 border-neon-500/30 text-neon-300"
              : "bg-rose-500/15 border-rose-500/30 text-rose-300"
          }`}
        >
          {msg.type === "success" ? <Check size={18} className="shrink-0" /> : <AlertCircle size={18} className="shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* Main Grid: Form on Left, Player Live Preview on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Form: 7 cols */}
        <div className="lg:col-span-7 space-y-5">
          {/* Card: Basic Details */}
          <div className="card p-5 space-y-4">
            <div className="text-sm font-semibold flex items-center gap-2 text-white/90">
              <Sparkles size={16} className="text-gold-400" />
              UPI & Account Information
            </div>

            {/* UPI ID */}
            <div>
              <label className="block text-xs text-white/70 mb-1.5 font-medium">
                Your UPI ID (VPA) <span className="text-neon-400">*</span>
              </label>
              <input
                type="text"
                value={data.upiId}
                onChange={(e) => setData((d) => ({ ...d, upiId: e.target.value.trim() }))}
                placeholder="e.g. 9876543210@paytm or agent@okhdfcbank"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400 font-mono tracking-wide"
              />
              {/* Quick Handle Chips */}
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-[11px] text-white/40 mr-1">Quick handle:</span>
                {UPI_HANDLES.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => appendHandle(h)}
                    className="text-[11px] px-2 py-0.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 border border-white/5 transition"
                  >
                    {h}
                  </button>
                ))}
              </div>
            </div>

            {/* Payee Name */}
            <div>
              <label className="block text-xs text-white/70 mb-1.5 font-medium">
                Payee / Display Name
              </label>
              <input
                type="text"
                value={data.payeeName}
                onChange={(e) => setData((d) => ({ ...d, payeeName: e.target.value }))}
                placeholder="e.g. Karan (GameHub Agent)"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400"
              />
              <span className="text-[11px] text-white/40 mt-1 block">
                Shown to players when they scan or tap your UPI ID.
              </span>
            </div>

            {/* WhatsApp / Calling Number */}
            <div>
              <label className="block text-xs text-white/70 mb-1.5 font-medium">
                WhatsApp Number for Payment Proofs
              </label>
              <div className="flex items-center gap-2">
                <div className="px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-xs text-white/60">
                  🇮🇳 +91
                </div>
                <input
                  type="text"
                  maxLength={10}
                  value={data.phone}
                  onChange={(e) => setData((d) => ({ ...d, phone: e.target.value.replace(/\D/g, "").slice(0, 10) }))}
                  placeholder="9876543210"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400 font-mono"
                />
              </div>
              <span className="text-[11px] text-white/40 mt-1 block">
                Players will have a direct 1-tap &ldquo;Send Screenshot on WhatsApp&rdquo; button pointing to this number.
              </span>
            </div>

            {/* Instructions / Payment Note */}
            <div>
              <label className="block text-xs text-white/70 mb-1.5 font-medium">
                Deposit Note / Instructions for Players
              </label>
              <textarea
                rows={3}
                value={data.paymentNote}
                onChange={(e) => setData((d) => ({ ...d, paymentNote: e.target.value }))}
                placeholder="e.g. Min deposit 100 coins. Send screenshot on WhatsApp with your Player ID for instant credit."
                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-neon-400 resize-none"
              />
            </div>
          </div>

          {/* Card: QR Code Mode */}
          <div className="card p-5 space-y-4">
            <div className="text-sm font-semibold flex items-center justify-between">
              <span className="flex items-center gap-2 text-white/90">
                <QrCode size={16} className="text-neon-400" />
                QR Code Choice
              </span>
              <div className="flex p-0.5 bg-white/5 rounded-xl border border-white/10 text-xs">
                <button
                  type="button"
                  onClick={() => setQrMode("auto")}
                  className={`px-3 py-1 rounded-lg transition ${
                    qrMode === "auto" ? "btn-green text-xs" : "text-white/60 hover:text-white"
                  }`}
                >
                  Auto-Generate
                </button>
                <button
                  type="button"
                  onClick={() => setQrMode("custom")}
                  className={`px-3 py-1 rounded-lg transition ${
                    qrMode === "custom" ? "btn-green text-xs" : "text-white/60 hover:text-white"
                  }`}
                >
                  Upload Custom QR
                </button>
              </div>
            </div>

            {qrMode === "auto" ? (
              <div className="rounded-xl bg-white/5 p-4 border border-white/5 text-xs text-white/70 space-y-2">
                <div className="flex items-start gap-2">
                  <Sparkles size={16} className="text-gold-400 shrink-0 mt-0.5" />
                  <div>
                    <b className="text-white">Instant UPI QR Code:</b> Generated automatically from your UPI ID{" "}
                    <code className="text-neon-300 font-mono">{data.upiId || "[Enter UPI ID above]"}</code>.
                    Compatible with Google Pay, PhonePe, Paytm, BHIM and all banking apps.
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-xl bg-white/5 p-4 border border-white/5 text-xs text-white/70">
                  Upload a clear image or screenshot of your PhonePe, Google Pay, or Paytm merchant/personal QR standee.
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="btn-ghost rounded-xl px-4 py-2.5 text-xs flex items-center gap-2 border border-white/10"
                  >
                    <Upload size={14} />
                    {customQrImage ? "Replace Image" : "Select Image from Device"}
                  </button>

                  {customQrImage && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomQrImage("");
                        setData((d) => ({ ...d, qrCodeUrl: "" }));
                        setQrMode("auto");
                      }}
                      className="text-rose-400 hover:text-rose-300 text-xs flex items-center gap-1.5 px-3 py-2"
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Save Button */}
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-white/40">Changes reflect immediately in your players&apos; wallets.</span>
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="btn-green px-6 py-3 rounded-xl text-sm font-semibold flex items-center gap-2"
            >
              {saving ? "Saving…" : "Save Payment Details"}
            </button>
          </div>
        </div>

        {/* Right Preview: 5 cols */}
        <div className="lg:col-span-5">
          <div className="sticky top-20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold tracking-wider uppercase text-white/50 flex items-center gap-1.5">
                <Smartphone size={14} />
                Live Player Preview
              </span>
              <span className="text-[11px] text-neon-400 bg-neon-400/10 px-2 py-0.5 rounded-full border border-neon-400/20">
                What your players see
              </span>
            </div>

            {/* Mobile Mockup Card */}
            <div className="w-full max-w-sm mx-auto rounded-[28px] border-2 border-white/10 bg-[#070b22] p-4 shadow-2xl relative overflow-hidden">
              <div className="text-center pt-1 pb-3 border-b border-white/5">
                <div className="text-xs text-white/50">Header &bull; Get Coins</div>
                <div className="text-sm font-semibold mt-0.5 flex items-center justify-center gap-1.5">
                  <ShieldCheck size={16} className="text-neon-400" />
                  Verified Agent Deposit
                </div>
              </div>

              <div className="mt-3 text-center">
                <div className="text-sm font-bold text-white">{data.payeeName || me.name}</div>
                <div className="text-[11px] text-white/50">
                  Agent ID: <span className="font-mono text-neon-400">{me.code}</span>
                </div>
              </div>

              {/* QR Code Container */}
              <div className="mt-4 p-3 bg-white/5 border border-white/10 rounded-2xl text-center">
                {activeQr ? (
                  <div className="bg-white p-3 rounded-xl inline-block shadow-md">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={activeQr}
                      alt="Agent QR Code"
                      className="w-44 h-44 object-contain mx-auto"
                    />
                  </div>
                ) : (
                  <div className="w-44 h-44 border-2 border-dashed border-white/15 rounded-xl grid place-items-center mx-auto text-center p-3 text-xs text-white/40">
                    <div>
                      <QrCode size={36} className="mx-auto text-white/20 mb-2" />
                      Enter UPI ID to preview QR code
                    </div>
                  </div>
                )}
                <div className="text-[11px] text-white/60 mt-2 font-medium">
                  Scan using Google Pay, PhonePe, Paytm or BHIM
                </div>
              </div>

              {/* UPI ID display */}
              <div className="mt-3 bg-white/5 border border-white/10 rounded-xl p-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] text-white/40">Agent UPI ID:</div>
                  <div className="text-xs font-mono font-medium text-white truncate">
                    {data.upiId || "Not set yet"}
                  </div>
                </div>
                {data.upiId && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(data.upiId);
                      setCopiedPreview(true);
                      setTimeout(() => setCopiedPreview(false), 2000);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[11px] text-white/80 shrink-0 flex items-center gap-1"
                  >
                    {copiedPreview ? <Check size={12} className="text-neon-400" /> : <Copy size={12} />}
                    {copiedPreview ? "Copied" : "Copy"}
                  </button>
                )}
              </div>

              {/* Direct UPI App pay button */}
              {data.upiId && (
                <div className="mt-2.5">
                  <div className="btn-green w-full py-2.5 rounded-xl text-xs font-semibold text-center flex items-center justify-center gap-1.5 opacity-90 cursor-default">
                    <ExternalLink size={14} />
                    Open in UPI App (Player Phone)
                  </div>
                </div>
              )}

              {/* Player ID prompt */}
              <div className="mt-3 rounded-xl bg-white/5 border border-white/5 p-2 text-center text-xs">
                <span className="text-white/60">Player ID: </span>
                <b className="font-mono text-gold-300">GH005063</b>
                <span className="text-[10px] text-white/40 block mt-0.5">Player copies this to send with screenshot</span>
              </div>

              {/* WhatsApp Screenshot button */}
              {cleanPhone && (
                <div className="mt-2.5">
                  <div className="bg-[#25D366]/20 border border-[#25D366]/40 text-[#25D366] w-full py-2 rounded-xl text-xs font-medium text-center flex items-center justify-center gap-1.5 cursor-default">
                    <MessageCircle size={14} />
                    Send Screenshot on WhatsApp
                  </div>
                </div>
              )}

              {/* Note / Instruction */}
              <div className="mt-3 text-[10px] text-white/50 text-center leading-relaxed">
                {data.paymentNote}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
