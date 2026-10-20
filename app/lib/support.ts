"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// The Help & Support and "Contact for ID" WhatsApp number set by Super Admin & Admins.

export interface Support {
  whatsapp?: string;
  note?: string;
  message?: string;
}

let cache: { at: number; v: Support } | null = null;

export const DEFAULT_ID_MESSAGE =
  "Hello, I want to get an ID for Khelobaazi. Please create my account.";

export async function loadSupport(force = false): Promise<Support> {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.v;
  
  // Try server API first
  try {
    const res = await fetch("/api/support-contact", { cache: "no-store" });
    if (res.ok) {
      const json = await res.json();
      if (json && (json.whatsapp !== undefined || json.message !== undefined)) {
        cache = { at: Date.now(), v: json };
        return json;
      }
    }
  } catch {
    // fallback to supabase RPC
  }

  try {
    const { data } = await supabase().rpc("support_contact");
    const v = (data ?? {}) as Support;
    cache = { at: Date.now(), v };
    return v;
  } catch {
    return cache?.v ?? { message: DEFAULT_ID_MESSAGE };
  }
}

export function useSupport(): Support | null {
  const [s, setS] = useState<Support | null>(cache?.v ?? null);
  useEffect(() => {
    loadSupport().then(setS);
  }, []);
  return s;
}

/** "+91 98765 43210" for display. */
export const prettyNumber = (n?: string) => {
  if (!n) return "";
  const clean = n.replace(/\D/g, "");
  if (clean.length === 12 && clean.startsWith("91")) {
    return `+91 ${clean.slice(2, 7)} ${clean.slice(7)}`;
  }
  if (clean.length === 10) {
    return `+91 ${clean.slice(0, 5)} ${clean.slice(5)}`;
  }
  return clean ? `+${clean}` : "";
};

/** Open a WhatsApp chat with the support number, with a first message filled in. */
export const whatsappLink = (n?: string, text?: string) => {
  const clean = (n || "919876543210").replace(/\D/g, "");
  const numWithCountry = clean.length === 10 ? `91${clean}` : clean;
  const msg = text || DEFAULT_ID_MESSAGE;
  return `https://wa.me/${numWithCountry}?text=${encodeURIComponent(msg)}`;
};
