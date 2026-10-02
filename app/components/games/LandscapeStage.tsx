"use client";

import { useEffect, useState } from "react";

// Full-screen landscape stage for the card tables (Teen Patti, Rummy), like native card-game apps.
// In landscape it simply fills the screen. Held upright, the stage is rotated 90° so the table is still
// wide; pop-up sheets render inside it (the rotated stage is their containing block) and rotate with it.

export function LandscapeStage({ children }: { children: React.ReactNode }) {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(orientation: portrait)");
    const sync = () => setPortrait(m.matches);
    sync();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, []);
  return (
    <div className="fixed inset-0 z-40 overflow-hidden table-room">
      <div className={portrait ? "stage-rotated" : "absolute inset-0"}>{children}</div>
    </div>
  );
}
