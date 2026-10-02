import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { SOURCE_URL, normalizeWater } from "./water.js";

export function createWaterCache({
  fetcher = fetch,
  now = Date.now,
  ttlMs = 60000,
  retryAfterMs = 60000,
  maxStaleMs = 6 * 3600000,
  timeoutMs = 8000,
  file = ".cache/water.json",
  logger = console,
} = {}) {
  let snapshot = null,
    pending = null,
    retryAt = 0,
    lastFailureAt = null;
  const restore = (async () => {
    if (!file) return;
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (
        Array.isArray(saved.stations) &&
        saved.stations.length &&
        Number.isFinite(Date.parse(saved.fetchedAt)) &&
        now() - Date.parse(saved.fetchedAt) <= maxStaleMs
      )
        snapshot = saved;
    } catch {
      /* Cold starts and ephemeral disks have no saved cache. */
    }
  })();

  async function update() {
    let failure;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(SOURCE_URL, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Accept: "application/json",
            "User-Agent":
              "WaterImpactMonitor/1.0 (+https://github.com/nuttapolkung/water-impact-monitor-app)",
          },
        });
        if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw new Error("UPSTREAM_CONTENT_TYPE");
        // Bound memory use even if an upstream starts returning an unexpected large document.
        let body = "",
          bytes = 0;
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 8 * 1024 * 1024) throw new Error("UPSTREAM_TOO_LARGE");
          body += decoder.decode(chunk, { stream: true });
        }
        body += decoder.decode();
        const stations = normalizeWater(
          JSON.parse(body),
          snapshot?.stations || [],
        );
        snapshot = { fetchedAt: new Date(now()).toISOString(), stations };
        retryAt = 0;
        lastFailureAt = null;
        logger.info(
          JSON.stringify({
            event: "water_upstream_success",
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
        if (attempt === 0)
          await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    lastFailureAt = new Date(now()).toISOString();
    retryAt = now() + retryAfterMs;
    logger.warn(
      JSON.stringify({
        event: "water_upstream_failed",
        code: /^UPSTREAM_/.test(failure?.message)
          ? failure.message
          : "UPSTREAM_REQUEST_FAILED",
        lastFailureAt,
      }),
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
        status: !usable
          ? "unavailable"
          : lastFailureAt || ageMs >= ttlMs
            ? "stale"
            : "fresh",
        lastFailureAt,
        nextRefreshAt: new Date(
          Math.max(
            retryAt,
            (snapshot ? Date.parse(snapshot.fetchedAt) : now()) + ttlMs,
          ),
        ).toISOString(),
      };
    },
  };
}
