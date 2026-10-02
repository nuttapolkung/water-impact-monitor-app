import { SOURCE_URL, normalizeWater, nearbyStations, assess } from "./water.js";

// Browser fallback for a reachable public, CORS-enabled feed when the hosting
// provider cannot reach it. One national request per minute per open page;
// no location parameters, cookies, persistent GPS or substitute observations.
export function createBrowserSource({ fetcher = fetch, now = Date.now } = {}) {
  let snapshot = null,
    pending = null,
    retryAt = 0,
    failed = false,
    lastError = null;
  async function update(signal) {
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
        const retry = response.headers.get("retry-after");
        const delay = Number.isFinite(Number(retry))
          ? Number(retry) * 1000
          : Date.parse(retry) - now();
        retryAt =
          now() +
          Math.max(
            response.status === 429 ? 15 * 60000 : 60000,
            Number.isFinite(delay) ? delay : 0,
          );
        await response.body?.cancel();
        throw new Error(`SOURCE_HTTP_${response.status}`);
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
      const stations = normalizeWater(
        JSON.parse(body + decoder.decode()),
        snapshot?.stations || [],
      );
      snapshot = { fetchedAt: new Date(now()).toISOString(), stations };
      retryAt = 0;
      failed = false;
      lastError = null;
    } catch (error) {
      failed = true;
      lastError = error;
      retryAt = Math.max(retryAt, now() + 60000);
      // A location change abort should not delay a subsequent national-data fetch.
      if (signal?.aborted) retryAt = 0;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
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
        try {
          await pending;
        } catch {
          /* A labeled last-known-good snapshot can still be shown. */
        }
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
          name: "ThaiWater · เบราว์เซอร์",
          url: SOURCE_URL,
          status,
          fallback: true,
          transport: "browser",
          fetchedAt: snapshot.fetchedAt,
          cacheSeconds: 60,
          message:
            status === "fresh"
              ? "เส้นทางบริการไม่พร้อม ใช้ข้อมูล ThaiWater ผ่านเบราว์เซอร์ (ไม่ส่งพิกัด)"
              : "ต้นทางไม่พร้อม ใช้ข้อมูลที่เบราว์เซอร์เก็บไว้",
        },
        assessment: assess(stations, status),
      };
    },
  };
}
export const browserSource = createBrowserSource();
