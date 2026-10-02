import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { SOURCE_URL, normalizeWater } from "./water.js";
import { RID_URL, fetchRidSnapshot, normalizeRid } from "./rid.js";

export const THAIWATER_SOURCE = {
  name: "ThaiWater",
  url: SOURCE_URL,
  normalize: normalizeWater,
};
export const RID_SOURCE = {
  name: "RID",
  url: RID_URL,
  normalize: normalizeRid,
  load: fetchRidSnapshot,
};

export function retryDelay(value, now, fallback) {
  if (!value) return fallback;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0
    ? Math.max(fallback, delay)
    : fallback;
}

export function createWaterCache({
  fetcher = fetch,
  now = Date.now,
  ttlMs = 60000,
  retryAfterMs = 60000,
  maxStaleMs = 6 * 3600000,
  timeoutMs = 8000,
  file = ".cache/water.json",
  logger = console,
  sources = [THAIWATER_SOURCE, RID_SOURCE],
} = {}) {
  let snapshot = null,
    pending = null,
    retryAt = 0,
    lastFailureAt = null;
  const cooldowns = new Map();
  const restore = (async () => {
    if (!file) return;
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      const age = now() - Date.parse(saved.fetchedAt);
      if (
        Array.isArray(saved.stations) &&
        saved.stations.length &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= maxStaleMs
      )
        snapshot = saved;
    } catch {
      /* Cold starts and ephemeral disks have no saved cache. */
    }
  })();

  async function request(source) {
    if (source.load) return source.load({ timeoutMs });
    const response = await fetcher(source.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        "User-Agent":
          "WaterImpactMonitor/1.0 (+https://github.com/nuttapolkung/water-impact-monitor-app)",
      },
    });
    if (!response.ok) {
      const error = new Error(`UPSTREAM_HTTP_${response.status}`);
      error.status = response.status;
      error.delay = retryDelay(
        response.headers.get("retry-after"),
        now(),
        response.status === 429 ? 15 * 60000 : retryAfterMs,
      );
      await response.body?.cancel();
      throw error;
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new Error("UPSTREAM_CONTENT_TYPE");
    }
    let body = "",
      bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error("UPSTREAM_TOO_LARGE");
      body += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  }

  async function update() {
    for (const source of sources) {
      if (now() < (cooldowns.get(source.name) || 0)) continue;
      let failure;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const stations = source.normalize(
            await request(source),
            snapshot?.stations || [],
          );
          snapshot = {
            fetchedAt: new Date(now()).toISOString(),
            stations,
            sourceName: source.name,
            sourceUrl: source.url,
          };
          retryAt = 0;
          lastFailureAt = null;
          cooldowns.delete(source.name);
          logger.info(
            JSON.stringify({
              event: "water_upstream_success",
              source: source.name,
              stations: stations.length,
              fetchedAt: snapshot.fetchedAt,
            }),
          );
          if (file) {
            try {
              await mkdir(dirname(file), { recursive: true });
              await writeFile(file + ".tmp", JSON.stringify(snapshot));
              await rename(file + ".tmp", file);
            } catch {
              logger.warn(
                JSON.stringify({ event: "water_cache_persist_failed" }),
              );
            }
          }
          return;
        } catch (error) {
          failure = error;
          // Respect upstream throttling and access refusals; never retry them immediately.
          if (error.status && error.status < 500) break;
          if (error.delay > retryAfterMs) break;
          if (attempt === 0)
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      cooldowns.set(source.name, now() + (failure?.delay || retryAfterMs));
      logger.warn(
        JSON.stringify({
          event: "water_upstream_failed",
          source: source.name,
          code: /^UPSTREAM_/.test(failure?.message)
            ? failure.message
            : "UPSTREAM_REQUEST_FAILED",
          lastFailureAt: new Date(now()).toISOString(),
          nextRetryAt: new Date(cooldowns.get(source.name)).toISOString(),
        }),
      );
    }
    lastFailureAt = new Date(now()).toISOString();
    retryAt = Math.min(
      ...sources.map((s) => cooldowns.get(s.name) || now() + retryAfterMs),
    );
  }

  return {
    async get() {
      await restore;
      if (
        (!snapshot || now() - Date.parse(snapshot.fetchedAt) >= ttlMs) &&
        now() >= retryAt
      ) {
        if (!pending)
          pending = update().finally(() => {
            pending = null;
          });
        await pending;
      }
      const ageMs = snapshot
        ? now() - Date.parse(snapshot.fetchedAt)
        : Infinity;
      const usable = snapshot && ageMs >= 0 && ageMs <= maxStaleMs;
      return {
        stations: usable ? snapshot.stations : [],
        fetchedAt: usable ? snapshot.fetchedAt : null,
        sourceName: snapshot?.sourceName || sources[0].name,
        sourceUrl: snapshot?.sourceUrl || sources[0].url,
        fallback:
          usable &&
          (snapshot.sourceName || sources[0].name) !== sources[0].name,
        status: !usable
          ? "unavailable"
          : lastFailureAt || ageMs >= ttlMs
            ? "stale"
            : "fresh",
        lastFailureAt,
        nextRefreshAt: new Date(
          Math.max(
            retryAt,
            snapshot
              ? Date.parse(snapshot.fetchedAt) + ttlMs
              : retryAt || now() + ttlMs,
          ),
        ).toISOString(),
      };
    },
  };
}
