"use client";

import { useEffect, useRef } from "react";
import { supabase } from "./supabase";

// One device per account (migration 069). Signing in claims a random tag on the profile and keeps a copy on the
// device; while the app is open it compares the two every CHECK_MS and whenever it returns to the foreground.
// A different tag means the account signed in somewhere else: this device signs out.

const CHECK_MS = 15000;
const key = (scope: "player" | "staff") => `gamehub-session-tag:${scope}`;

const localTag = (scope: "player" | "staff") => {
  try { return localStorage.getItem(key(scope)); } catch { return null; }
};

/** Call right after a successful sign-in (and on a restored session that has no tag yet). */
export async function claimSession(scope: "player" | "staff") {
  const tag = crypto.randomUUID();
  const { error } = await supabase().rpc("claim_session", { p_tag: tag });
  if (error) return; // migration 069 not run yet: single-device enforcement is simply off
  try { localStorage.setItem(key(scope), tag); } catch { /* private mode */ }
}

/** Claim a tag for a session this device already had (first launch after the feature shipped). */
export async function ensureSessionTag(scope: "player" | "staff") {
  if (!localTag(scope)) await claimSession(scope);
}

export function useSingleSession(scope: "player" | "staff", active: boolean, onKicked: () => void) {
  const kicked = useRef(onKicked);
  kicked.current = onKicked;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const check = async () => {
      const mine = localTag(scope);
      if (!mine) return;
      const { data, error } = await supabase().rpc("session_tag");
      if (!alive || error || data == null) return; // offline or not set up: never sign out on a failed check
      if (data !== mine) {
        try { localStorage.removeItem(key(scope)); } catch { /* ignore */ }
        kicked.current();
      }
    };
    check();
    const t = setInterval(check, CHECK_MS);
    const onShow = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onShow); };
  }, [scope, active]);
}
