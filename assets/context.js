import { number, sensorTime, distanceKm, SENSOR_MAX_AGE_MS } from "./water.js";
import tideTables from "./tide-tables-2026.js";

export const RAIN_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h";
export const RAIN_PAGE = "https://www.thaiwater.net/weather/rainfall";
const HOUR = 3600000;

const label = (v) =>
  (typeof v === "string"
    ? v
    : typeof v?.th === "string"
      ? v.th
      : typeof v?.en === "string"
        ? v.en
        : ""
  )
    .trim()
    .slice(0, 200);
export function normalizeRainfall(payload) {
  if (payload?.result !== "OK" || !Array.isArray(payload.data))
    throw new Error("RAIN_SCHEMA_INVALID");
  const stations = new Map();
  for (const row of payload.data) {
    const meta = row.station || {},
      id = number(meta.id),
      lat = number(meta.tele_station_lat),
      lon = number(meta.tele_station_long);
    if (
      id === null ||
      id <= 0 ||
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    const value = number(row.rain_24h);
    const station = {
      id: String(id),
      name: label(meta.tele_station_name) || "สถานีไม่ระบุชื่อ",
      lat,
      lon,
      rain24hMm: value !== null && value >= 0 && value <= 3000 ? value : null,
      measuredAt: sensorTime(row.rainfall_datetime),
      agency: label(row.agency?.agency_name),
      source: "ThaiWater",
    };
    const old = stations.get(station.id);
    if (
      !old ||
      (Date.parse(station.measuredAt) || 0) > (Date.parse(old.measuredAt) || 0)
    )
      stations.set(station.id, station);
  }
  if (!stations.size) throw new Error("RAIN_SCHEMA_INVALID");
  return [...stations.values()];
}

export function rainfallContext(
  snapshot,
  location,
  radiusKm,
  now = Date.now(),
) {
  const nearby = (snapshot.stations || [])
    .map((s) => {
      const age = now - Date.parse(s.measuredAt);
      return {
        ...s,
        distanceKm:
          Math.round(
            distanceKm(location.lat, location.lon, s.lat, s.lon) * 100,
          ) / 100,
        usable: Number.isFinite(age) && age >= -300000 && age <= 6 * HOUR,
        fresh:
          snapshot.status === "fresh" &&
          Number.isFinite(age) &&
          age >= -300000 &&
          age <= SENSOR_MAX_AGE_MS,
      };
    })
    .filter(
      (s) =>
        s.distanceKm <= radiusKm && Number.isFinite(s.rain24hMm) && s.usable,
    )
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const station = nearby.find((s) => s.fresh) || nearby[0] || null;
  return {
    status: station
      ? station.fresh
        ? "available"
        : "stale"
      : snapshot.status === "unavailable"
        ? "unavailable"
        : "no_nearby",
    station,
    radiusKm,
    freshStations: nearby.filter((s) => s.fresh).length,
    sourceUrl: RAIN_PAGE,
    fetchedAt: snapshot.fetchedAt,
    nextRefreshAt: snapshot.nextRefreshAt,
    transport: snapshot.transport || "server",
  };
}

// A saved card must age even when later requests fail or the page stays open.
export function cachedRainfallContext(
  context,
  location,
  radiusKm,
  now = Date.now(),
) {
  if (!context?.station) return context;
  const age = now - Date.parse(context.fetchedAt);
  const usable = Number.isFinite(age) && age >= -300000 && age <= 6 * HOUR;
  return rainfallContext(
    {
      stations: usable ? [context.station] : [],
      status: !usable
        ? "unavailable"
        : context.status === "available" && age < 5 * 60000
          ? "fresh"
          : "stale",
      fetchedAt: context.fetchedAt,
      nextRefreshAt: context.nextRefreshAt,
      transport: context.transport,
    },
    location,
    radiusKm,
    now,
  );
}

// Shared national rainfall cache, independent of location and water availability.
// Requests carry neither location nor cookies. Failures never become zero rain.
export function createRainSource({
  fetcher = fetch,
  now = Date.now,
  transport = "server",
} = {}) {
  let snapshot = null,
    pending = null,
    retryAt = 0,
    failed = false;
  async function update() {
    try {
      const response = await fetcher(RAIN_URL, {
        signal: AbortSignal.timeout(10000),
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const error = new Error("RAIN_SOURCE_FAILED");
        error.status = response.status;
        error.retryAfter = response.headers.get("retry-after");
        await response.body?.cancel();
        throw error;
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new Error("RAIN_SCHEMA_INVALID");
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
          if (bytes > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("RAIN_TOO_LARGE");
          }
          body += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      snapshot = {
        stations: normalizeRainfall(JSON.parse(body + decoder.decode())),
        fetchedAt: new Date(now()).toISOString(),
      };
      retryAt = 0;
      failed = false;
    } catch (error) {
      const seconds = number(error.retryAfter),
        delay =
          seconds !== null
            ? seconds * 1000
            : Date.parse(error.retryAfter) - now();
      retryAt =
        now() +
        Math.max(
          error.status === 429 || error.status === 403 ? 15 * 60000 : 60000,
          Number.isFinite(delay) ? delay : 0,
        );
      failed = true;
    }
  }
  return {
    async get() {
      if (
        (!snapshot || now() - Date.parse(snapshot.fetchedAt) >= 5 * 60000) &&
        now() >= retryAt
      ) {
        pending ||= update().finally(() => {
          pending = null;
        });
        await pending;
      }
      const age = snapshot ? now() - Date.parse(snapshot.fetchedAt) : Infinity,
        usable = age >= 0 && age <= 6 * HOUR;
      return {
        stations: usable ? snapshot.stations : [],
        fetchedAt: usable ? snapshot.fetchedAt : null,
        transport,
        status: !usable
          ? "unavailable"
          : failed || age >= 5 * 60000
            ? "stale"
            : "fresh",
        nextRefreshAt: new Date(
          Math.max(
            retryAt,
            snapshot
              ? Date.parse(snapshot.fetchedAt) + 5 * 60000
              : now() + 60000,
          ),
        ).toISOString(),
      };
    },
  };
}
export const browserRainSource = createRainSource({ transport: "browser" });

// Hourly official predictions, never interpolated or relabeled as measurements.
// This is a nearby coastal reference, not propagation to the selected property.
export function tideContext(location, now = Date.now(), tables = tideTables) {
  const station = tables
    .filter(
      (s) =>
        s.kind === "prediction" &&
        s.datum === "msl" &&
        s.timezone === "Asia/Bangkok",
    )
    .map((s) => ({
      ...s,
      distanceKm:
        Math.round(distanceKm(location.lat, location.lon, s.lat, s.lon) * 100) /
        100,
    }))
    .filter((s) => s.distanceKm <= 100)
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  if (!station)
    return {
      status: "no_nearby",
      sourceUrl: "https://hydro.navy.mi.th/waterlaveltable",
    };
  const hour = Math.floor(now / HOUR) * HOUR;
  const point = (at) => {
    const date = new Date(at + 7 * HOUR).toISOString(),
      values = station.days[date.slice(0, 10)],
      level = values?.[+date.slice(11, 13)];
    return typeof level === "number" && Number.isFinite(level)
      ? { at: new Date(at).toISOString(), levelMsl: level }
      : null;
  };
  const current = point(hour),
    future = Array.from({ length: 24 }, (_, i) => point(hour + (i + 1) * HOUR));
  const { days, ...metadata } = station;
  if (!current)
    return {
      status: "unavailable",
      reason: "year_not_covered",
      station: metadata,
      sourceUrl: station.sourceUrl,
    };
  const high = future.every(Boolean)
    ? [...future].sort(
        (a, b) =>
          b.levelMsl - a.levelMsl || Date.parse(a.at) - Date.parse(b.at),
      )[0]
    : null;
  return {
    status: "available",
    kind: "prediction",
    station: metadata,
    current,
    high,
    sourceUrl: station.sourceUrl,
  };
}
