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

  // A screen's code that can no longer be fetched (a deploy went out while this bundle was open and its chunks are
  // gone): nothing on the page will work again until it reloads, so reload at once — even at a table; the table
  // lives on the server and the player is seated again on return. Once per minute at most, so a real outage
  // doesn't loop.
  useEffect(() => {
    if (BUILD_ID === "dev") return;
    const chunkGone = (msg: string) => /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
    const reloadOnce = () => {
      const last = Number(sessionStorage.getItem("kb-chunk-reload") ?? 0);
      if (Date.now() - last < 60000) return;
      sessionStorage.setItem("kb-chunk-reload", String(Date.now()));
      window.location.reload();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { name?: string; message?: string } | undefined;
      if (chunkGone(`${r?.name ?? ""} ${r?.message ?? ""}`)) reloadOnce();
    };
    const onError = (e: ErrorEvent) => { if (chunkGone(`${e.message ?? ""}`)) reloadOnce(); };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => { window.removeEventListener("unhandledrejection", onRejection); window.removeEventListener("error", onError); };
  }, []);
}
