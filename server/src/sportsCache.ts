// Server-side High-Performance Memory Cache for Sports Exchange APIs
// Enforces precise TTLs and deduplicates concurrent in-flight requests.

interface CacheEntry {
  data: string;
  contentType: string;
  status: number;
  timestamp: number;
  ttl: number;
}

export const CACHE_TTLS = {
  MATCH_LIST: 15 * 60 * 1000,          // 15 minutes
  LIVE_MATCH_ODDS: 500,                // 500 ms
  UPCOMING_MATCH_ODDS: 2 * 1000,       // 2 seconds
  FANCY_RESULTS: 1 * 60 * 1000,        // 1 minute
  BETFAIR_BOOKMAKER_RESULTS: 5 * 60 * 1000, // 5 minutes
};

const store = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<{ status: number; contentType: string; data: string }>>();

export async function fetchWithCache(
  key: string,
  ttlMs: number,
  fetchFn: () => Promise<{ status: number; contentType: string; data: string }>
): Promise<{ status: number; contentType: string; data: string; cached: boolean; ageMs: number }> {
  const now = Date.now();
  const cached = store.get(key);

  // Return fresh cache if within TTL
  if (cached && (now - cached.timestamp < cached.ttl)) {
    return {
      status: cached.status,
      contentType: cached.contentType,
      data: cached.data,
      cached: true,
      ageMs: now - cached.timestamp,
    };
  }

  // Deduplicate simultaneous requests
  if (inFlight.has(key)) {
    const res = await inFlight.get(key)!;
    return {
      status: res.status,
      contentType: res.contentType,
      data: res.data,
      cached: true,
      ageMs: 0,
    };
  }

  const promise = (async () => {
    try {
      const res = await fetchFn();
      if (res.status === 200 && res.data) {
        store.set(key, {
          data: res.data,
          contentType: res.contentType,
          status: res.status,
          timestamp: Date.now(),
          ttl: ttlMs,
        });
      }
      return res;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  const result = await promise;

  return {
    status: result.status,
    contentType: result.contentType,
    data: result.data,
    cached: false,
    ageMs: 0,
  };
}

export function clearCache(pattern?: string) {
  if (!pattern) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.includes(pattern)) store.delete(key);
  }
}
