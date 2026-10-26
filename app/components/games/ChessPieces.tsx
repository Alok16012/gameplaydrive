// Chess pieces drawn for this app (Staunton-style silhouettes built from simple shapes). White: ivory with a dark
// outline; black: charcoal with a light inner line. Sized to fill their box.

const W = { fill: "#fbfbf8", stroke: "#1d1d1b", detail: "#1d1d1b" };
const B = { fill: "#2a2826", stroke: "#0b0b0a", detail: "#d9d6cf" };

export function ChessPiece({ p, className = "" }: { p: string; className?: string }) {
  const c = p === p.toUpperCase() ? W : B;
  const k = p.toLowerCase();
  const s = { fill: c.fill, stroke: c.stroke, strokeWidth: 1.5, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  const line = { fill: "none", stroke: c.detail, strokeWidth: 1.4, strokeLinecap: "round" as const };
  return (
    <svg viewBox="0 0 45 45" className={className} style={{ width: "100%", height: "100%", display: "block", filter: "drop-shadow(0 1.5px 1px rgba(0,0,0,.35))" }} aria-hidden>
      {k === "p" && (
        <g {...s}>
          <rect x="10" y="35" width="25" height="4.5" rx="1.6" />
          <path d="M15.5 35 Q15.5 29.5 18.5 27 H26.5 Q29.5 29.5 29.5 35 Z" />
          <path d="M17 27 Q17 22.5 22.5 21.5 Q28 22.5 28 27 Z" />
          <circle cx="22.5" cy="15" r="5.2" />
        </g>
      )}
      {k === "r" && (
        <g {...s}>
          <rect x="9.5" y="35" width="26" height="4.5" rx="1.6" />
          <rect x="12" y="31" width="21" height="4" rx="1" />
          <path d="M14.5 31 L15.5 17.5 H29.5 L30.5 31 Z" />
          <path d="M12 17.5 V9.5 H16.5 V12.5 H20.2 V9.5 H24.8 V12.5 H28.5 V9.5 H33 V17.5 Z" />
          <path d="M15.5 17.5 H29.5 M14.8 27.5 H30.2" {...line} />
        </g>
      )}
      {k === "b" && (
        <g {...s}>
          <rect x="10" y="35" width="25" height="4.5" rx="1.6" />
          <path d="M14 35 Q15.5 30.5 18 28.5 H27 Q29.5 30.5 31 35 Z" />
          <path d="M18 28.5 C13.5 24 15.5 16 22.5 10.5 C29.5 16 31.5 24 27 28.5 Z" />
          <circle cx="22.5" cy="8" r="2.6" />
          <path d="M25.5 15.5 L20.5 21.5 M18 28.5 H27" {...line} />
        </g>
      )}
      {k === "n" && (
        <g {...s}>
          <rect x="11.5" y="35" width="23" height="4.5" rx="1.6" />
          <path d="M14 35 C14.5 31 17 28.5 19.2 26.4 C19.6 25.6 19 25 18 25.4 C16.2 26.6 14.6 28.2 12.8 28.3 C11 28.4 10.2 26.8 10.8 25.4 L13.6 19.6 C15.2 16.2 18 13.8 21.4 13.2 L22.6 9.6 L24.6 12.8 C29.8 15.6 32.2 22.6 32 35 Z" />
          <path d="M22.6 9.6 L20 7.8 L21.4 13.2" />
          <circle cx="17.6" cy="18.8" r="1.2" fill={c.detail} stroke="none" />
          <path d="M24.6 14.6 C28 18 29.6 24 29.4 31" {...line} />
        </g>
      )}
      {k === "q" && (
        <g {...s}>
          <rect x="9.5" y="35" width="26" height="4.5" rx="1.6" />
          <path d="M12 35 L9.5 16.5 L15.8 26.5 L16.6 13.5 L20.6 24.5 L22.5 11.5 L24.4 24.5 L28.4 13.5 L29.2 26.5 L35.5 16.5 L33 35 Z" />
          {[[9.5, 15.5], [16.6, 12.2], [22.5, 10], [28.4, 12.2], [35.5, 15.5]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.3" />)}
          <path d="M12.6 30.5 H32.4" {...line} />
        </g>
      )}
      {k === "k" && (
        <g {...s}>
          <rect x="9.5" y="35" width="26" height="4.5" rx="1.6" />
          <path d="M12 35 C8.5 28.5 9 21.5 14 20 C17.5 19 20.5 21.2 22.5 25 C24.5 21.2 27.5 19 31 20 C36 21.5 36.5 28.5 33 35 Z" />
          <path d="M22.5 25 C20 21 20 17.5 22.5 15.8 C25 17.5 25 21 22.5 25 Z" />
          <path d="M22.5 6.2 V15.2 M19 9.4 H26" stroke={c.stroke} strokeWidth="2.6" strokeLinecap="round" fill="none" />
          <path d="M22.5 6.2 V15.2 M19 9.4 H26" stroke={c.fill} strokeWidth="1" strokeLinecap="round" fill="none" />
          <path d="M12.6 30.5 H32.4" {...line} />
        </g>
      )}
    </svg>
  );
}
