import { number, sensorTime, SENSOR_MAX_AGE_MS } from "./water.js";
import { fetchRidBrowserStation } from "./rid-source.js";

export const HISTORY_HOURS = [1, 3, 6, 24];
export const HISTORY_TOLERANCE_MS = 15 * 60000;
const GRAPH_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_graph";
const validLevel = (v) =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 10000;

export function historyReference(s) {
  const rid = /^rid:(\d{1,8}):(\d)$/.exec(s.id);
  if (s.source === "RID" && rid)
    return {
      provider: "RID",
      resourceId: rid[1],
      index: +rid[2],
      key: `RID:${rid[1]}`,
    };
  if (
    s.source === "ThaiWater" &&
    /^\d{1,8}$/.test(s.id) &&
    (!s.historyStationType || s.historyStationType === "tele_waterlevel")
  )
    return {
      provider: "ThaiWater",
      resourceId: s.id,
      index: 0,
      key: `ThaiWater:${s.id}`,
    };
  return null;
}

function points(values) {
  if (!Array.isArray(values) || values.length > 5000)
    throw new Error("HISTORY_SCHEMA_INVALID");
  const unique = new Map();
  for (const { at, level } of values) {
    const time = Date.parse(at);
    if (!Number.isFinite(time) || !validLevel(level)) continue;
    // Conflicting readings at the same instant are ambiguous, not an average.
    if (unique.has(time) && unique.get(time) !== level) unique.set(time, null);
    else unique.set(time, level);
  }
  const sorted = [...unique]
    .filter(([, level]) => level !== null)
    .sort(([a], [b]) => a - b);
  const last = sorted.at(-1)?.[0] ?? 0;
  return sorted
    .filter(([at]) => at >= last - 27 * 3600000)
    .map(([at, level]) => ({ at: new Date(at).toISOString(), level }));
}

export function normalizeRidHistory(payload, resourceId) {
  if (
    !Array.isArray(payload?.cross_section) ||
    !payload?.values?.water_level_graph ||
    (payload.id != null && String(payload.id) !== String(resourceId))
  )
    throw new Error("HISTORY_SCHEMA_INVALID");
  const channels = [];
  for (let index = 0; index < payload.cross_section.length; index++) {
    const cross = payload.cross_section[index],
      graph = payload.values.water_level_graph[index];
    if (![0, 1].includes(cross?.unit) || !graph) continue;
    if (
      !Array.isArray(graph.time) ||
      !Array.isArray(graph.value) ||
      graph.time.length !== graph.value.length
    )
      throw new Error("HISTORY_SCHEMA_INVALID");
    channels.push({
      index,
      datum: cross.unit === 0 ? "msl" : "local",
      parameter: cross.parameter || "",
      points: points(
        graph.value.map((v, i) => {
          const seconds = number(graph.time[i]);
          return {
            level: number(v),
            at:
              seconds !== null && seconds > 0 && seconds < 253402300799
                ? new Date(seconds * 1000).toISOString()
                : null,
          };
        }),
      ),
    });
  }
  if (!channels.length) throw new Error("HISTORY_SCHEMA_INVALID");
  return {
    provider: "RID",
    resourceId: String(resourceId),
    code: payload.code || "",
    channels,
  };
}

export function normalizeThaiWaterHistory(payload, resourceId) {
  if (payload?.result !== "OK" || !Array.isArray(payload?.data?.graph_data))
    throw new Error("HISTORY_SCHEMA_INVALID");
  // Verified against the official tele_waterlevel graph's MSL axis and current
  // station reading. Unzoned graph datetimes are Thailand local time, as above.
  return {
    provider: "ThaiWater",
    resourceId: String(resourceId),
    channels: [
      {
        index: 0,
        datum: "msl",
        parameter: "",
        points: points(
          payload.data.graph_data.map((r) => ({
            at: sensorTime(r.datetime),
            level: number(r.value),
          })),
        ),
      },
    ],
  };
}

export function compareHistory(
  station,
  history,
  { now = Date.now(), sourceStatus = "fresh" } = {},
) {
  const ref = historyReference(station),
    anchor = Date.parse(station.sensorUpdatedAt);
  const result = {
    anchorAt: station.sensorUpdatedAt,
    comparisons: HISTORY_HOURS.map((hours) => ({ hours, status: "missing" })),
  };
  if (
    sourceStatus !== "fresh" ||
    station.dataQuality !== "fresh" ||
    !Number.isFinite(anchor) ||
    now - anchor > SENSOR_MAX_AGE_MS ||
    anchor - now > 300000
  )
    return { ...result, status: "stale" };
  const datum = station.waterLevelMsl != null ? "msl" : "local";
  const level =
    datum === "msl" ? station.waterLevelMsl : station.waterLevelLocal;
  const channel = history?.channels?.find(
    (c) => c.index === ref?.index && c.datum === datum,
  );
  if (
    !ref ||
    !validLevel(level) ||
    history?.provider !== ref.provider ||
    history.resourceId !== ref.resourceId ||
    !channel ||
    (ref.provider === "RID" &&
      (history.code !== station.code?.split("/")[0] ||
        (station.gaugeParameter &&
          channel.parameter !== station.gaugeParameter)))
  )
    return { ...result, status: "incompatible" };
  // Dashboard snapshots round to two decimals. Use the unrounded graph value
  // at the exact same instant, otherwise rounding alone can invent a direction.
  const current = channel.points.find((p) => Date.parse(p.at) === anchor);
  if (!current || Math.abs(current.level - level) > 0.0051)
    return { ...result, status: "incompatible" };
  result.status = "ready";
  result.datum = datum;
  result.comparisons = HISTORY_HOURS.map((hours) => {
    const target = anchor - hours * 3600000;
    const previous = channel.points
      .filter(
        (p) =>
          Date.parse(p.at) < anchor &&
          Math.abs(Date.parse(p.at) - target) <= HISTORY_TOLERANCE_MS,
      )
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.at) - target) -
            Math.abs(Date.parse(b.at) - target) ||
          Date.parse(a.at) - Date.parse(b.at),
      )[0];
    if (!previous) return { hours, status: "missing" };
    const deltaCm =
      Math.round((current.level - previous.level) * 1000) / 10 || 0;
    return {
      hours,
      status: "available",
      deltaCm,
      direction: deltaCm > 0 ? "rising" : deltaCm < 0 ? "falling" : "stable",
      baselineAt: previous.at,
      baselineLevel: previous.level,
      currentLevel: current.level,
      actualMinutes: (anchor - Date.parse(previous.at)) / 60000,
      approximate: Math.abs(Date.parse(previous.at) - target) > 60000,
    };
  });
  return result;
}

async function thaiWaterGraph(ref, fetcher, now) {
  const localDate = (at) =>
    new Date(at + 7 * 3600000).toISOString().slice(0, 16).replace("T", " ");
  const query = new URLSearchParams({
    station_type: "tele_waterlevel",
    station_id: ref.resourceId,
    start_date: localDate(now - 26 * 3600000).slice(0, 10),
    end_date: localDate(now),
  });
  const response = await fetcher(`${GRAPH_URL}?${query}`, {
    signal: AbortSignal.timeout(10000),
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error("HISTORY_SOURCE_FAILED");
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    await response.body?.cancel();
    throw error;
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new Error("HISTORY_SCHEMA_INVALID");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let body = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error("HISTORY_TOO_LARGE");
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return normalizeThaiWaterHistory(
    JSON.parse(body + decoder.decode()),
    ref.resourceId,
  );
}

export function createHistorySource({
  ridLoader = fetchRidBrowserStation,
  fetcher = fetch,
  now = Date.now,
  concurrency = 2,
} = {}) {
  const entries = new Map(),
    cooldowns = new Map(),
    queue = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const work = queue.shift();
      active++;
      work().finally(() => {
        active--;
        drain();
      });
    }
  };
  return {
    get(station) {
      const ref = historyReference(station);
      if (!ref)
        return Promise.resolve({ status: "unsupported", expiresAt: Infinity });
      const old = entries.get(ref.key);
      if (old && (old.pending || old.expiresAt > now())) return old.promise;
      if (entries.size >= 128 && !old) {
        const victim = [...entries].find(([, e]) => !e.pending);
        if (!victim)
          return Promise.resolve({
            status: "unavailable",
            expiresAt: now() + 60000,
          });
        entries.delete(victim[0]);
      }
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      const entry = { promise, pending: true, expiresAt: 0 };
      entries.set(ref.key, entry);
      queue.push(async () => {
        let response;
        try {
          if ((cooldowns.get(ref.provider) || 0) > now()) {
            response = {
              status: "rate_limited",
              expiresAt: cooldowns.get(ref.provider),
            };
          } else {
            const data =
              ref.provider === "RID"
                ? normalizeRidHistory(
                    await ridLoader({ stationId: ref.resourceId }),
                    ref.resourceId,
                  )
                : await thaiWaterGraph(ref, fetcher, now());
            response = {
              status: "ready",
              data,
              fetchedAt: new Date(now()).toISOString(),
              expiresAt: now() + 5 * 60000,
            };
          }
        } catch (error) {
          let delay = 60000;
          if (error.status === 429 || error.status === 403) {
            const seconds = Number(error.retryAfter);
            const retry =
              seconds > 0
                ? seconds * 1000
                : Date.parse(error.retryAfter) - now();
            delay = Math.max(15 * 60000, Number.isFinite(retry) ? retry : 0);
            cooldowns.set(ref.provider, now() + delay);
          }
          response = {
            status:
              error.status === 429 || error.status === 403
                ? "rate_limited"
                : "unavailable",
            expiresAt: now() + delay,
          };
        }
        entry.pending = false;
        entry.expiresAt = response.expiresAt;
        resolve(response);
      });
      drain();
      return promise;
    },
  };
}
export const historySource = createHistorySource();
