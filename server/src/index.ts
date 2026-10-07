// GameHub realtime game server (Railway). Players connect over WebSocket; each table runs in memory with its own
// timers, so moves, bots and timeouts happen instantly. Logins and coins stay in Supabase:
//   • a player proves who they are with their Supabase access token (checked once per connection);
//   • every coin movement goes through wallet_move (ledger + audit), queued per player.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { realClock } from "./clock.js";
import { cfg, refreshConfig } from "./config.js";
import { refreshBots } from "./bots.js";
import { getProfile, userFromToken, betRoom } from "./supa.js";
import { SupabaseWallet } from "./wallet.js";
import { TPTable } from "./teenpatti.js";
import { fetchWithCache, CACHE_TTLS } from "./sportsCache.js";

const PORT = Number(process.env.PORT ?? 8080);
const BOOTS = [10, 25, 50, 100, 200, 500, 1000];
// Private tables: the creator picks any whole-coin boot in this range.
const PRIVATE_BOOT_MIN = 1;
const PRIVATE_BOOT_MAX = 10000;
const wallet = new SupabaseWallet();

interface Conn { ws: WebSocket; uid?: string; name?: string; tableId?: string; alive: boolean }
const conns = new Set<Conn>();
const tables = new Map<string, TPTable>();
const userTable = new Map<string, string>(); // uid → Teen Patti table id

const send = (c: Conn, msg: unknown) => { if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg)); };
const emojiFor = (uid: string) => ["🧑🏽", "👩🏽", "👨🏻", "👩🏾", "🧑🏻", "👨🏾"][[...uid].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % 6];

function broadcast(t: TPTable) {
  for (const c of conns) if (c.uid && c.tableId === t.id) send(c, { t: "tp_view", view: t.view(c.uid) });
}

function newCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const c = Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join("");
    if (![...tables.values()].some((t) => t.code === c)) return c;
  }
}

function makeTable(boot: number, code: string | null) {
  const t = new TPTable(randomUUID(), boot, code, realClock, wallet, broadcast);
  tables.set(t.id, t);
  return t;
}

/** Find or create the table for this player (rejoining their current one if they are still seated). */
function joinTable(c: Conn, boot: number, code: string | null): TPTable | string {
  const uid = c.uid!;
  if (!cfg("teen-patti").enabled) return "Teen Patti is closed for maintenance";
  let t: TPTable | undefined;
  const current = userTable.get(uid) ? tables.get(userTable.get(uid)!) : undefined;
  if (code) {
    t = [...tables.values()].find((x) => x.code === code.trim().toUpperCase());
    if (!t) return "No table with that code";
  } else if (!BOOTS.includes(boot)) return "Invalid boot";
  if (wallet.balance(uid) < (t?.boot ?? boot)) return "Not enough coins";

  if (current && current.members().includes(uid) && current.boot === (t?.boot ?? boot) && current.code === (t?.code ?? null)) t = current;
  else {
    if (current) current.leave(uid);
    if (!t) {
      t = [...tables.values()]
        .filter((x) => x.boot === boot && x.code === null && x.humans() < 6)
        .sort((a, b) => b.humans() - a.humans())[0] ?? makeTable(boot, null);
    } else if (t.members().length >= 6 && !t.members().includes(uid)) return "This table is full";
  }
  userTable.set(uid, t.id);
  c.tableId = t.id;
  t.join(uid, c.name!, emojiFor(uid));
  return t;
}

async function onMessage(c: Conn, raw: string) {
  let m: { t: string; [k: string]: unknown };
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === "ping") return send(c, { t: "pong", now: Date.now() });
  if (m.t === "auth") {
    const user = await userFromToken(String(m.token ?? ""));
    const p = user ? await getProfile(user.id) : null;
    if (!p) return send(c, { t: "error", code: "auth", message: "Please sign in again" });
    if (p.role !== "player") return send(c, { t: "error", code: "auth", message: "Only players can join tables" });
    if (p.status !== "active") return send(c, { t: "error", code: "auth", message: "This account is frozen. Contact your agent." });
    c.uid = p.id; c.name = p.name;
    await wallet.load(p.id);
    return send(c, { t: "auth_ok", name: p.name, coins: wallet.balance(p.id) });
  }
  if (!c.uid) return send(c, { t: "error", code: "auth", message: "Not signed in" });

  switch (m.t) {
    case "tp_join": {
      await wallet.load(c.uid);
      {
        // Admin's daily bet limit for this player: the boot must still fit today.
        const byCode = m.code ? [...tables.values()].find((x) => x.code === String(m.code).trim().toUpperCase()) : undefined;
        const room = await betRoom(c.uid);
        if (room !== null && room < (byCode?.boot ?? Number(m.boot))) return send(c, { t: "error", code: "join", message: `Daily bet limit reached (${room} coins left today)` });
      }
      const r = joinTable(c, Number(m.boot), m.code ? String(m.code) : null);
      if (typeof r === "string") return send(c, { t: "error", code: "join", message: r });
      return send(c, { t: "tp_view", view: r.view(c.uid) });
    }
    case "tp_create": {
      const boot = Number(m.boot);
      if (!Number.isInteger(boot) || boot < PRIVATE_BOOT_MIN || boot > PRIVATE_BOOT_MAX) {
        return send(c, { t: "error", code: "join", message: `Pick a boot between ${PRIVATE_BOOT_MIN} and ${PRIVATE_BOOT_MAX.toLocaleString("en-IN")} coins` });
      }
      await wallet.load(c.uid);
      if (wallet.balance(c.uid) < boot) return send(c, { t: "error", code: "join", message: "Not enough coins" });
      { const room = await betRoom(c.uid); if (room !== null && room < boot) return send(c, { t: "error", code: "join", message: `Daily bet limit reached (${room} coins left today)` }); }
      const t = makeTable(boot, newCode());
      const r = joinTable(c, boot, t.code);
      if (typeof r === "string") return send(c, { t: "error", code: "join", message: r });
      send(c, { t: "tp_created", code: t.code });
      return send(c, { t: "tp_view", view: r.view(c.uid) });
    }
    case "tp_act": {
      const t = c.tableId ? tables.get(c.tableId) : undefined;
      if (!t) return send(c, { t: "error", code: "act", message: "You are not at a table" });
      const err = t.act(c.uid, String(m.action));
      if (err) send(c, { t: "error", code: "act", message: err });
      return;
    }
    case "tp_leave": {
      const t = c.tableId ? tables.get(c.tableId) : undefined;
      t?.leave(c.uid);
      if (userTable.get(c.uid) === c.tableId) userTable.delete(c.uid);
      c.tableId = undefined;
      return send(c, { t: "tp_left" });
    }
  }
}

// ------------------------------------------------------------------ HTTP: health + lobby counts + sports proxy

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = parsedUrl.pathname;

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tables: tables.size, players: conns.size }));
  }

  if (pathname === "/lobby") {
    const tp: Record<string, number> = {};
    for (const t of tables.values()) if (!t.code) tp[t.boot] = (tp[t.boot] ?? 0) + t.humans();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ "teen-patti": tp }));
  }

  // 1. Diagnostics: Check Railway Outbound IP as seen by public internet & DiamondExch
  if (pathname === "/check-ip") {
    const diag: Record<string, any> = { timestamp: new Date().toISOString() };
    try {
      const ipRes = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
      diag.railwayPublicIP = (await ipRes.json()).ip;
    } catch (e: any) {
      diag.railwayPublicIPError = e.message;
    }

    try {
      const dRes = await fetch("https://apis.diamondexchapi.com/check-ip", { cache: "no-store" });
      diag.diamondExchCheckIp = (await dRes.text()).trim();
    } catch (e: any) {
      diag.diamondExchCheckIpError = e.message;
    }

    const testUrls = [
      "https://apis.diamondexchapi.com/api/cricket/odds?eventId=761013765",
      "https://apis.diamondexchapi.com/api/cricket/odds?marketId=5188803657540",
      "https://apis.diamondexchapi.com/api/cricket/odds?eventId=473531415",
      "https://apis.diamondexchapi.com/api/odds?eventId=761013765",
      "https://apis.diamondexchapi.com/api/cricket/odds/761013765",
      "https://apis.diamondexchapi.com/api/cricket/fancy?eventId=761013765",
      "https://apis.diamondexchapi.com/api/cricket/fancy-results?eventId=761013765",
    ];

    diag.probes = {};
    for (const url of testUrls) {
      try {
        const pRes = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        const text = await pRes.text();
        diag.probes[url] = {
          status: pRes.status,
          isJson: (pRes.headers.get("content-type") || "").includes("json"),
          snippet: text.slice(0, 150),
        };
      } catch (err: any) {
        diag.probes[url] = { error: err.message };
      }
    }

    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(diag, null, 2));
  }

  // 1b. Test vendor odds with various headers/params
  if (pathname === "/test-vendor-odds") {
    const eventId = parsedUrl.searchParams.get("eventId") || "761013765";
    const marketId = parsedUrl.searchParams.get("marketId") || "5188803657540";
    
    const attempts: Array<{ name: string; url: string; headers: Record<string, string> }> = [
      { name: "standard_eventId", url: `https://apis.diamondexchapi.com/api/cricket/odds?eventId=${eventId}`, headers: { "Accept": "application/json" } },
      { name: "with_referer", url: `https://apis.diamondexchapi.com/api/cricket/odds?eventId=${eventId}`, headers: { "Accept": "application/json", "Origin": "https://khelobaazi.in", "Referer": "https://khelobaazi.in/" } },
      { name: "my99_origin", url: `https://apis.diamondexchapi.com/api/cricket/odds?eventId=${eventId}`, headers: { "Accept": "application/json", "Origin": "https://my99exch.cx", "Referer": "https://my99exch.cx/" } },
      { name: "marketId_param", url: `https://apis.diamondexchapi.com/api/cricket/odds?marketId=${marketId}`, headers: { "Accept": "application/json" } },
      { name: "both_params", url: `https://apis.diamondexchapi.com/api/cricket/odds?eventId=${eventId}&marketId=${marketId}`, headers: { "Accept": "application/json" } },
      { name: "root_odds", url: `https://apis.diamondexchapi.com/api/odds?eventId=${eventId}`, headers: { "Accept": "application/json" } },
      { name: "fancy_endpoint", url: `https://apis.diamondexchapi.com/api/cricket/fancy?eventId=${eventId}`, headers: { "Accept": "application/json" } },
      { name: "fancy_results", url: `https://apis.diamondexchapi.com/api/cricket/fancy-results?eventId=${eventId}`, headers: { "Accept": "application/json" } },
    ];

    const results: Record<string, any> = {};
    for (const att of attempts) {
      try {
        const r = await fetch(att.url, { headers: att.headers, cache: "no-store" });
        const text = await r.text();
        results[att.name] = {
          url: att.url,
          status: r.status,
          contentType: r.headers.get("content-type"),
          snippet: text.slice(0, 200),
        };
      } catch (e: any) {
        results[att.name] = { error: e.message };
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(results, null, 2));
  }

  // 2. Proxy: Sports Matches from my99exch / DiamondExch (Cached for 15 minutes)
  const matchesMatch = pathname.match(/^\/api\/(cricket|soccer|football|tennis|sports)\/matches$/);
  if (matchesMatch || pathname === "/api/sports/matches") {
    let sportName = matchesMatch ? matchesMatch[1] : (parsedUrl.searchParams.get("sport") || "cricket").toLowerCase();
    if (sportName === "football" || sportName === "sports") sportName = "soccer";
    const cacheKey = `matches_${sportName}`;
    const etid = sportName === "soccer" ? 1 : sportName === "tennis" ? 2 : 4;

    try {
      const cachedRes = await fetchWithCache(cacheKey, CACHE_TTLS.MATCH_LIST, async () => {
        // 1. Try my99exch highlight odds feed
        try {
          const my99Res = await fetch("https://my99exch.cx/api/front_open/highlightodds-direct/", {
            headers: { "Accept": "application/json", "User-Agent": "curl/7.81.0" },
            cache: "no-store",
          });
          if (my99Res.ok) {
            const json = await my99Res.json();
            const list = json?.data?.t1;
            if (Array.isArray(list) && list.length > 0) {
              const filtered = list.filter((m: any) => !etid || m.etid === etid || m.etid === 4);
              const mapped = (filtered.length > 0 ? filtered : list).map((m: any) => {
                const parts = (m.ename || "").split(/ v | vs | VS /i);
                const t1 = parts[0]?.trim() || m.section?.[0]?.nat || "Team 1";
                const t2 = parts[1]?.trim() || m.section?.[1]?.nat || "Team 2";
                const o1 = m.section?.[0]?.odds || [];
                const o2 = m.section?.[1]?.odds || [];
                const b1 = o1.find((x: any) => x.oname === "back1")?.odds || 0;
                const l1 = o1.find((x: any) => x.oname === "lay1")?.odds || 0;
                const b2 = o2.find((x: any) => x.oname === "back1")?.odds || 0;
                const l2 = o2.find((x: any) => x.oname === "lay1")?.odds || 0;

                return {
                  gameId: String(m.gmid),
                  eventId: String(m.gmid),
                  marketId: String(m.mid || ""),
                  eventName: m.ename || `${t1} v ${t2}`,
                  eventTime: m.stime || new Date().toISOString(),
                  seriesName: m.cname || "Tournament",
                  inPlay: Boolean(m.iplay),
                  status: m.iplay ? "INPLAY" : "OPEN",
                  tv: Boolean(m.tv),
                  bm: Boolean(m.bm),
                  f: Boolean(m.f || m.f1),
                  back1: b1,
                  lay1: l1,
                  back2: b2,
                  lay2: l2,
                  team1: { name: t1, short: t1.slice(0, 3).toUpperCase() },
                  team2: { name: t2, short: t2.slice(0, 3).toUpperCase() },
                  section: m.section,
                };
              });

              return {
                status: 200,
                contentType: "application/json",
                data: JSON.stringify({ status: 200, success: true, data: mapped }),
              };
            }
          }
        } catch {}

        // 2. Fallback to DiamondExch matches
        const dRes = await fetch(`https://apis.diamondexchapi.com/api/${sportName}/matches`, {
          headers: { "Accept": "application/json", "User-Agent": "curl/7.81.0" },
          cache: "no-store",
        });
        const text = await dRes.text();
        return {
          status: dRes.status,
          contentType: dRes.headers.get("content-type") || "application/json",
          data: text,
        };
      });

      res.writeHead(cachedRes.status, {
        "Content-Type": cachedRes.contentType,
        "Cache-Control": "public, max-age=900",
        "X-Cache": cachedRes.cached ? "HIT" : "MISS",
        "X-Cache-Age-Ms": String(cachedRes.ageMs),
      });
      return res.end(cachedRes.data);
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to fetch from sports provider", details: err.message }));
    }
  }

  // 3. Proxy: Match Odds from my99exch / DiamondExch (Live: 500ms, Upcoming: 2s)
  const oddsMatch = pathname.match(/^\/api\/(cricket|soccer|football|tennis|sports)\/odds$/);
  if (oddsMatch || pathname === "/api/cricket/odds" || pathname === "/api/sports/odds") {
    const eventId = parsedUrl.searchParams.get("gameId") || parsedUrl.searchParams.get("eventId") || "";
    let sportName = oddsMatch ? oddsMatch[1] : (parsedUrl.searchParams.get("sport") || "cricket").toLowerCase();
    if (sportName === "football" || sportName === "sports") sportName = "soccer";
    const isLive = parsedUrl.searchParams.get("live") === "true" || parsedUrl.searchParams.get("inPlay") === "true";
    const ttl = isLive ? CACHE_TTLS.LIVE_MATCH_ODDS : CACHE_TTLS.UPCOMING_MATCH_ODDS;
    const cacheKey = `odds_${sportName}_${eventId}`;

    try {
      const cachedRes = await fetchWithCache(cacheKey, ttl, async () => {
        // 1. Try my99exch highlight odds directly with gmid
        try {
          const my99Res = await fetch(`https://my99exch.cx/api/front_open/highlightodds-direct/?gmid=${encodeURIComponent(eventId)}`, {
            headers: { "Accept": "application/json", "User-Agent": "curl/7.81.0" },
            cache: "no-store",
          });
          if (my99Res.ok) {
            const json = await my99Res.json();
            const list = json?.data?.t1 || [];
            const match = list.find((x: any) => String(x.gmid) === String(eventId)) || list[0];
            if (match && Array.isArray(match.section) && match.section.length > 0) {
              const oddDatas = match.section.map((sec: any, idx: number) => {
                const oddsArr = sec.odds || [];
                const b1 = oddsArr.find((o: any) => o.oname === "back1");
                const b2 = oddsArr.find((o: any) => o.oname === "back2");
                const b3 = oddsArr.find((o: any) => o.oname === "back3");
                const l1 = oddsArr.find((o: any) => o.oname === "lay1");
                const l2 = oddsArr.find((o: any) => o.oname === "lay2");
                const l3 = oddsArr.find((o: any) => o.oname === "lay3");

                return {
                  sid: sec.sid || idx + 1,
                  rname: sec.nat || `Runner ${idx + 1}`,
                  status: sec.gstatus || "ACTIVE",
                  b1: b1 ? String(b1.odds) : undefined,
                  bs1: b1 ? `${b1.size}L` : undefined,
                  b2: b2 ? String(b2.odds) : undefined,
                  bs2: b2 ? `${b2.size}L` : undefined,
                  b3: b3 ? String(b3.odds) : undefined,
                  bs3: b3 ? `${b3.size}L` : undefined,
                  l1: l1 ? String(l1.odds) : undefined,
                  ls1: l1 ? `${l1.size}L` : undefined,
                  l2: l2 ? String(l2.odds) : undefined,
                  ls2: l2 ? `${l2.size}L` : undefined,
                  l3: l3 ? String(l3.odds) : undefined,
                  ls3: l3 ? `${l3.size}L` : undefined,
                  min: sec.min || 100,
                  max: sec.max || 500000,
                };
              });

              // Construct Bookmaker Odds
              const bmOddDatas = oddDatas.map((r: any) => {
                const price = Number(r.b1 || 1.85);
                const rate = Math.max(10, Math.min(190, Math.round((price - 1) * 100)));
                return {
                  sid: r.sid,
                  rname: r.rname,
                  status: r.status,
                  b1: String(rate),
                  bs1: "1.5L",
                  l1: String(rate + 2),
                  ls1: "1.2L",
                };
              });

              const transformed = {
                matchOdds: [
                  {
                    mid: match.mid || `mo.${eventId}`,
                    mname: match.mname || "MATCH_ODDS",
                    status: match.status || "OPEN",
                    min: match.min || 100,
                    max: match.max || 500000,
                    gtype: match.gtype || "match",
                    oddDatas,
                  },
                ],
                bookMakerOdds: [
                  {
                    mid: `bm.${eventId}`,
                    mname: "BOOKMAKER",
                    status: "OPEN",
                    min: 100,
                    max: 200000,
                    gtype: "bookmaker",
                    oddDatas: bmOddDatas,
                  },
                ],
                fancyOdds: [],
              };

              return {
                status: 200,
                contentType: "application/json",
                data: JSON.stringify({ status: 200, success: true, source: "my99exch_live", data: transformed }),
              };
            }
          }
        } catch {}

        // 2. Fallback to DiamondExch
        const dRes = await fetch(`https://apis.diamondexchapi.com/api/${sportName}/odds?gameId=${encodeURIComponent(eventId)}&eventId=${encodeURIComponent(eventId)}`, {
          headers: { "Accept": "application/json", "User-Agent": "curl/7.81.0" },
          cache: "no-store",
        });
        const text = await dRes.text();
        return {
          status: dRes.status,
          contentType: dRes.headers.get("content-type") || "application/json",
          data: text,
        };
      });

      res.writeHead(cachedRes.status, {
        "Content-Type": cachedRes.contentType,
        "Cache-Control": isLive ? "public, max-age=1" : "public, max-age=2",
        "X-Cache": cachedRes.cached ? "HIT" : "MISS",
        "X-Cache-Age-Ms": String(cachedRes.ageMs),
      });
      return res.end(cachedRes.data);
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to fetch odds from sports provider", details: err.message }));
    }
  }

  // 4. Proxy: Fancy Results API (Cached for 1 minute)
  if (pathname === "/api/cricket/fancy-results" || pathname === "/api/sports/fancy-results" || pathname === "/api/fancy-results") {
    const eventId = parsedUrl.searchParams.get("eventId") || "";
    const sportParam = (parsedUrl.searchParams.get("sport") || "cricket").toLowerCase();
    const sportName = sportParam === "football" ? "soccer" : sportParam;
    const cacheKey = `fancy_results_${sportName}_${eventId}`;

    try {
      const cachedRes = await fetchWithCache(cacheKey, CACHE_TTLS.FANCY_RESULTS, async () => {
        const dRes = await fetch(`https://apis.diamondexchapi.com/api/${sportName}/fancy-results?eventId=${encodeURIComponent(eventId)}`, {
          headers: { "Accept": "application/json", "User-Agent": "curl/7.81.0" },
          cache: "no-store",
        });
        const text = await dRes.text();
        return {
          status: dRes.status,
          contentType: dRes.headers.get("content-type") || "application/json",
          data: text,
        };
      });

      res.writeHead(cachedRes.status, {
        "Content-Type": cachedRes.contentType,
        "Cache-Control": "public, max-age=60",
        "X-Cache": cachedRes.cached ? "HIT" : "MISS",
        "X-Cache-Age-Ms": String(cachedRes.ageMs),
      });
      return res.end(cachedRes.data);
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to fetch fancy results", details: err.message }));
    }
  }

  // 5. Proxy: Betfair & Bookmaker Results API (Cached for 5 minutes)
  if (pathname === "/api/cricket/results" || pathname === "/api/sports/results" || pathname === "/api/results") {
    const eventId = parsedUrl.searchParams.get("eventId") || "";
    const sportParam = (parsedUrl.searchParams.get("sport") || "cricket").toLowerCase();
    const sportName = sportParam === "football" ? "soccer" : sportParam;
    const cacheKey = `results_${sportName}_${eventId}`;

    try {
      const cachedRes = await fetchWithCache(cacheKey, CACHE_TTLS.BETFAIR_BOOKMAKER_RESULTS, async () => {
        const dRes = await fetch(`https://apis.diamondexchapi.com/api/${sportName}/results?eventId=${encodeURIComponent(eventId)}`, {
          headers: { "Accept": "application/json", "User-Agent": "curl/7.81.0" },
          cache: "no-store",
        });
        const text = await dRes.text();
        return {
          status: dRes.status,
          contentType: dRes.headers.get("content-type") || "application/json",
          data: text,
        };
      });

      res.writeHead(cachedRes.status, {
        "Content-Type": cachedRes.contentType,
        "Cache-Control": "public, max-age=300",
        "X-Cache": cachedRes.cached ? "HIT" : "MISS",
        "X-Cache-Age-Ms": String(cachedRes.ageMs),
      });
      return res.end(cachedRes.data);
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to fetch match results", details: err.message }));
    }
  }

  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const c: Conn = { ws, alive: true };
  conns.add(c);
  ws.on("pong", () => { c.alive = true; });
  ws.on("message", (d) => { onMessage(c, d.toString()).catch((e) => send(c, { t: "error", code: "server", message: (e as Error).message })); });
  ws.on("close", () => {
    conns.delete(c);
    if (c.uid && c.tableId && ![...conns].some((x) => x.uid === c.uid && x.tableId === c.tableId)) tables.get(c.tableId)?.setOnline(c.uid, false);
  });
});

// Keep connections honest (drop dead sockets), and tidy up empty tables.
setInterval(() => {
  for (const c of conns) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch {} }
  const now = Date.now();
  for (const [id, t] of tables) {
    if (t.humans() === 0 && t.status !== "playing" && now - t.touched > 120_000) { t.dispose(); tables.delete(id); }
  }
}, 15_000);

// Settings and bots from the admin panel.
await Promise.all([refreshConfig(), refreshBots()]);
setInterval(refreshConfig, 30_000);
setInterval(refreshBots, 60_000);

server.listen(PORT, () => console.log(`[gamehub] game server on :${PORT}`));

// Railway sends SIGTERM on redeploy: give back coins for hands that can't finish, then exit.
async function shutdown() {
  console.log("[gamehub] shutting down — refunding hands in progress");
  for (const t of tables.values()) t.refundInProgress();
  for (const c of conns) send(c, { t: "error", code: "restart", message: "Server is restarting — reconnecting…" });
  const uids = new Set([...tables.values()].flatMap((t) => t.members()));
  await Promise.race([Promise.all([...uids].map((u) => wallet.settled(u))), new Promise((r) => setTimeout(r, 8000))]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
