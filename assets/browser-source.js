import { SOURCE_URL, normalizeWater, nearbyStations, assess } from "./water.js";
import { normalizeRid } from "./rid-water.js";
import { RID_URL, fetchRidBrowserSnapshot } from "./rid-source.js";

// Each page shares one national snapshot per minute. Coordinates are used only
// for local filtering; public sources receive no GPS parameters or cookies.
export function createBrowserSource({
  fetcher = fetch,
  now = Date.now,
  ridFetcher = null,
} = {}) {
  let snapshot = null,
    pending = null,
    retryAt = 0,
    failed = false,
    lastError = null;
  const cooldowns = new Map();
  async function thaiWater(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 10000);
    try {
      const response = await fetcher(SOURCE_URL, {
        signal: controller.signal,
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const error = new Error(`SOURCE_HTTP_${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get("retry-after");
        await response.body?.cancel();
        throw error;
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new Error("SOURCE_SCHEMA");
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let body = "",
        bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("SOURCE_TOO_LARGE");
          }
          body += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(body + decoder.decode());
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  const sources = [
    {
      name: "ThaiWater",
      url: SOURCE_URL,
      load: thaiWater,
      normalize: normalizeWater,
    },
    ...(ridFetcher
      ? [
          {
            name: "RID",
            url: RID_URL,
            load: (signal) => ridFetcher({ signal }),
            normalize: normalizeRid,
          },
        ]
      : []),
  ];
  async function update(signal) {
    for (const source of sources) {
      if (now() < (cooldowns.get(source.name) || 0)) continue;
      try {
        const stations = source.normalize(
          await source.load(signal),
          snapshot?.stations || [],
        );
        if (signal?.aborted)
          throw new DOMException("Request aborted", "AbortError");
        snapshot = {
          fetchedAt: new Date(now()).toISOString(),
          stations,
          name: source.name,
          url: source.url,
        };
        cooldowns.delete(source.name);
        retryAt = 0;
        failed = false;
        lastError = null;
        return;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) return;
        const retry = error.retryAfter;
        const delay =
          retry && Number.isFinite(Number(retry))
            ? Number(retry) * 1000
            : Date.parse(retry) - now();
        cooldowns.set(
          source.name,
          now() +
            Math.max(
              error.status === 429 ? 15 * 60000 : 60000,
              Number.isFinite(delay) ? delay : 0,
            ),
        );
      }
    }
    failed = true;
    retryAt = Math.min(
      ...sources.map((s) => cooldowns.get(s.name) || now() + 60000),
    );
  }
  return {
    async get({ location, radiusKm, version, signal }) {
      if (
        (!snapshot || now() - Date.parse(snapshot.fetchedAt) >= 60000) &&
        now() >= retryAt
      ) {
        if (!pending)
          pending = update(signal).finally(() => {
            pending = null;
          });
        await pending;
      }
      const age = snapshot ? now() - Date.parse(snapshot.fetchedAt) : Infinity;
      if (age < 0 || age > 6 * 3600000)
        throw new Error("SOURCE_UNAVAILABLE", { cause: lastError });
      const status = failed || age >= 60000 ? "stale" : "fresh";
      const stations = nearbyStations(
        snapshot.stations,
        location,
        radiusKm,
        now(),
      );
      return {
        version,
        location,
        radiusKm,
        stations,
        checkedAt: new Date(now()).toISOString(),
        updatedAt: snapshot.fetchedAt,
        source: {
          name: `${snapshot.name} · เบราว์เซอร์`,
          url: snapshot.url,
          status,
          fallback: true,
          transport: "browser",
          fetchedAt: snapshot.fetchedAt,
          cacheSeconds: 60,
          message:
            status === "fresh"
              ? `เส้นทางบริการไม่พร้อม ใช้ข้อมูล ${snapshot.name} ผ่านเบราว์เซอร์ (ไม่ส่งพิกัด)`
              : "ต้นทางไม่พร้อม ใช้ข้อมูลที่เบราว์เซอร์เก็บไว้",
        },
        assessment: assess(stations, status),
      };
    },
  };
}
export const browserSource = createBrowserSource({
  ridFetcher: fetchRidBrowserSnapshot,
});
