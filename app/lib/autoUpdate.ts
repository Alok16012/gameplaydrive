"use client";

import { useEffect, useRef } from "react";

// Keeps phones on the latest build. NEXT_PUBLIC_BUILD_ID is baked into every bundle at build time (next.config.ts)
// and /api/version returns the one on the server; when they differ a newer deploy is live, so the page reloads —
// at once on an ordinary screen, or as soon as the player leaves a game table (never mid-hand).

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
const CHECK_MS = 60000;

export function useAutoUpdate(inGame: boolean) {
  const stale = useRef(false);
  const game = useRef(inGame);
  game.current = inGame;

  useEffect(() => {
    if (BUILD_ID === "dev") return;
    let alive = true;
    const reloadIfIdle = () => { if (stale.current && !game.current) window.location.reload(); };
    const check = async () => {
      try {
        const r = await fetch(`/api/version?t=${Date.now()}`, { cache: "no-store" });
        const j = await r.json();
        if (alive && j.build && j.build !== BUILD_ID) { stale.current = true; reloadIfIdle(); }
      } catch { /* offline: try again later */ }
    };
    check();
    const t = setInterval(check, CHECK_MS);
    const onShow = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onShow); };
  }, []);

  // Leaving a game with an update pending: reload now.
  useEffect(() => { if (!inGame && stale.current) window.location.reload(); }, [inGame]);
}
