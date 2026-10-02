"use client";

// Client for the realtime game server (Railway; server/src/index.ts). Teen Patti tables live there, in memory,
// so every change — a bot's move, a timer running out, another player's action — reaches this screen the
// instant it happens, with no polling. Logins and coins stay in Supabase; this socket only proves who you are
// (your Supabase access token) and then plays the hand.
import { supabase } from "./supabase";

const WS_URL = process.env.NEXT_PUBLIC_GAME_SERVER_WS ?? "";
const HTTP_URL = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP ?? "";

export interface ServerMsg { t: string; [k: string]: unknown }
type Handler = (msg: ServerMsg) => void;

/** One shared connection. A table screen connects on mount and disconnects on unmount; your seat is kept by
 *  the server (keyed by account, not by connection), so closing the screen doesn't leave the table — only the
 *  Leave button does. Reconnects (network blip, phone backgrounded) re-authenticate automatically. */
const AUTH_TIMEOUT_MS = 10000;

class GameSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private authed = false;
  private queue: string[] = [];
  private backoff = 500;
  private wanted = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  private emit(msg: ServerMsg) { for (const h of this.handlers) h(msg); }

  connect() {
    this.wanted = true;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (!WS_URL) { console.error("[gameServer] NEXT_PUBLIC_GAME_SERVER_WS is not set"); return; }
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.authed = false;
    ws.onopen = () => {
      this.backoff = 500;
      this.authenticate();
      // If the server never answers (dropped packet, a stuck proxy, a token fetch that never resolves), don't
      // leave the screen stuck on "Finding a table…" forever — surface it and let the caller retry.
      this.authTimer = setTimeout(() => {
        this.authTimer = null;
        this.emit({ t: "error", code: "auth", message: "Couldn't reach the game server. Check your connection and try again." });
        try { ws.close(); } catch {}
      }, AUTH_TIMEOUT_MS);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.t === "auth_ok") {
        this.authed = true;
        if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
        this.flush();
      }
      this.emit(m);
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
      this.ws = null; this.authed = false;
      if (this.wanted) { setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 1.6, 8000); }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    this.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" })); }, 20000);
  }

  disconnect() {
    this.wanted = false;
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  private async authenticate() {
    const { data } = await supabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) { this.emit({ t: "error", code: "auth", message: "Please sign in again" }); return; }
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "auth", token }));
  }

  /** Queued until authenticated (including across a reconnect), then sent in order. */
  send(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  private flush() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const s of this.queue.splice(0)) this.ws.send(s);
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
}

export const gameSocket = new GameSocket();

/** Real players seated at Teen Patti tables right now, by boot amount — e.g. {"10": 3, "50": 1}. No auth needed. */
export async function getTeenPattiLobby(): Promise<Record<string, number>> {
  if (!HTTP_URL) return {};
  try {
    const r = await fetch(`${HTTP_URL}/lobby`, { cache: "no-store" });
    const d = await r.json();
    return (d["teen-patti"] as Record<string, number>) ?? {};
  } catch { return {}; }
}

/** Create a private Teen Patti table and get back its invite code. Resolves once the server confirms.
 *  `send` queues the request until the connection is authenticated, so this works whether or not a table
 *  screen already has the socket open. Rejects (rather than hanging) on any server error, or after 15 s. */
export function createTeenPattiPrivate(boot: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Timed out creating the table. Try again.")); }, 15000);
    const off = gameSocket.on((m) => {
      if (m.t === "tp_created") { clearTimeout(timer); off(); resolve(String(m.code)); }
      else if (m.t === "error") { clearTimeout(timer); off(); reject(new Error(String(m.message))); }
    });
    gameSocket.connect();
    gameSocket.send({ t: "tp_create", boot });
  });
}
