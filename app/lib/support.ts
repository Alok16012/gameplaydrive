"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// The Help & Support WhatsApp number the Super Admin sets (supabase/migrations/021_support_contact.sql).

export interface Support { whatsapp?: string; note?: string }

let cache: { at: number; v: Support } | null = null;

export async function loadSupport(force = false): Promise<Support> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.v;
  const { data, error } = await supabase().rpc("support_contact");
  const v = (error ? {} : (data ?? {})) as Support;
  cache = { at: Date.now(), v };
  return v;
}

export function useSupport(): Support | null {
  const [s, setS] = useState<Support | null>(cache?.v ?? null);
  useEffect(() => { loadSupport().then(setS); }, []);
  return s;
}

/** "+91 98765 43210" for display. */
export const prettyNumber = (n: string) =>
  n.length === 12 && n.startsWith("91") ? `+91 ${n.slice(2, 7)} ${n.slice(7)}` : `+${n}`;

/** Open a WhatsApp chat with the support number, with a first message filled in. */
export const whatsappLink = (n: string, text: string) => `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
