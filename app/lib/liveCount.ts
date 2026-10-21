"use client";

import { useEffect, useState } from "react";

/** A "players online" number that drifts a little every few seconds (±15% of the base) so it never looks frozen. */
export function useLiveCount(base: number): number {
  const [n, setN] = useState(base);
  useEffect(() => {
    setN(base);
    const lo = Math.max(1, Math.round(base * 0.85)), hi = Math.round(base * 1.15);
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setN((cur) => Math.min(hi, Math.max(lo, cur + Math.floor(Math.random() * 7) - 3)));
      t = setTimeout(tick, 1500 + Math.random() * 3500);
    };
    t = setTimeout(tick, 1500 + Math.random() * 3500);
    return () => clearTimeout(t);
  }, [base]);
  return n;
}
