import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRainfall,
  rainfallContext,
  cachedRainfallContext,
  normalizeRidRainfall,
  createRidRainSource,
  createRainSource,
  tideContext,
  RAIN_URL,
} from "../assets/context.js";
import tables from "../assets/tide-tables-2026.js";
import { createRidSnapshotCache } from "../assets/rid-source.js";

const now = Date.parse("2026-10-04T02:30:00Z"),
  location = { lat: 13.518, lon: 99.954 };
const row = (changes = {}) => ({
  station: {
    id: 1316771,
    tele_station_name: { th: "วัดบางคนฑีใน" },
    tele_station_lat: 13.4913,
    tele_station_long: 99.9445,
  },
  rain_24h: 0,
  rainfall_datetime: "2026-10-04 08:00",
  ...changes,
});
const payload = (rows = [row()]) => ({ result: "OK", data: rows });
const response = () =>
  new Response(JSON.stringify(payload()), {
    headers: { "content-type": "application/json" },
  });

const ridPayload = () => ({
  type: "INIT",
  data: {
    396: {
      name: "วัดบางคนฑีใน",
      measure: { r: true },
      location: { y: 13.4913, x: 99.9445 },
      values: {
        rain_sum: { value: [0, 5], unixtime: [now / 1000, now / 1000] },
        rain_sum_now: { value: 9, unixtime: now / 1000 },
      },
    },
  },
});

test("RID rain uses the completed 07:00-to-07:00 period, separate from report time and rain since today's 07:00", () => {
  const stations = normalizeRidRainfall(ridPayload());
  assert.equal(stations[0].rain24hMm, 0);
  assert.equal(stations[0].periodEndAt, "2026-10-04T00:00:00.000Z");
  assert.equal(stations[0].measuredAt, "2026-10-04T02:30:00.000Z");
  assert.equal(stations[0].source, "RID");
  for (const value of [null, "-", -1, 32767]) {
    const p = ridPayload();
    p.data[396].values.rain_sum.value[0] = value;
    assert.throws(() => normalizeRidRainfall(p), /SCHEMA/);
  }
  const missing = ridPayload();
  delete missing.data[396].values.rain_sum;
  assert.throws(() => normalizeRidRainfall(missing), /SCHEMA/);
  const malformed = ridPayload();
  malformed.data[396].values.rain_sum.value = "0";
  assert.throws(() => normalizeRidRainfall(malformed), /SCHEMA/);
  const early = ridPayload();
  early.data[396].values.rain_sum.unixtime[0] =
    Date.parse("2026-10-03T23:45:00Z") / 1000;
  assert.equal(
    normalizeRidRainfall(early)[0].periodEndAt,
    "2026-10-03T00:00:00.000Z",
  );
});

test("water and rain share one RID snapshot while failed refreshes retain honest age and backoff", async () => {
  let time = now,
    calls = 0,
    failed = false;
  const shared = createRidSnapshotCache({
    now: () => time,
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failed) throw new Error("connection failed");
      return ridPayload();
    },
  });
  const rainSource = createRidRainSource({
    snapshotSource: shared,
    now: () => time,
  });
  const [water, rain] = await Promise.all([shared.get(), rainSource.get()]);
  assert.equal(calls, 1);
  assert.equal(water.payload.type, "INIT");
  assert.equal(rain.status, "fresh");
  assert.equal(rainfallContext(rain, location, 20, time).station.rain24hMm, 0);
  assert.equal(
    rainfallContext(rain, location, 20, time).sourceUrl,
    "https://telerid.rid.go.th/",
  );
  assert.equal(
    cachedRainfallContext(
      rainfallContext(rain, location, 20, time),
      location,
      20,
      time + 61000,
    ).status,
    "stale",
  );
  time += 61000;
  failed = true;
  const stale = await rainSource.get();
  assert.equal(stale.status, "stale");
  assert.equal(stale.fetchedAt, rain.fetchedAt);
  await assert.rejects(shared.get());
  assert.equal(calls, 2);
  time += 7 * 3600000;
  assert.equal((await rainSource.get()).status, "unavailable");
});

test("rainfall preserves measured zero, Bangkok timestamps and rejects missing/negative/sentinel/future data", () => {
  const stations = normalizeRainfall(payload());
  const result = rainfallContext(
    { stations, status: "fresh" },
    location,
    20,
    now,
  );
  assert.equal(result.status, "available");
  assert.equal(result.station.rain24hMm, 0);
  assert.equal(result.station.measuredAt, "2026-10-04T01:00:00.000Z");
  assert.equal(result.station.distanceKm, 3.14);
  for (const value of [null, "", -1, -9999, 32767]) {
    const invalid = normalizeRainfall(payload([row({ rain_24h: value })]));
    assert.equal(
      rainfallContext({ stations: invalid, status: "fresh" }, location, 20, now)
        .station,
      null,
    );
  }
  const future = normalizeRainfall(
    payload([row({ rainfall_datetime: "2026-10-05 08:00" })]),
  );
  assert.equal(
    rainfallContext({ stations: future, status: "fresh" }, location, 20, now)
      .station,
    null,
  );
  assert.throws(() => normalizeRainfall({ result: "OK", data: [] }), /SCHEMA/);
});

test("rain chooses the closest fresh gauge within radius, preserving stale source status and no-coverage state", () => {
  const stations = normalizeRainfall(
    payload([
      row({ rainfall_datetime: "2026-10-04 03:00" }),
      row({
        station: {
          id: 2,
          tele_station_name: { th: "ถัดไป" },
          tele_station_lat: 13.52,
          tele_station_long: 100.01,
        },
        rain_24h: 12.5,
      }),
    ]),
  );
  assert.equal(
    rainfallContext({ stations, status: "fresh" }, location, 20, now).station
      .id,
    "2",
  );
  assert.equal(
    rainfallContext({ stations, status: "stale" }, location, 20, now).status,
    "stale",
  );
  assert.equal(
    rainfallContext({ stations, status: "fresh" }, { lat: 0, lon: 0 }, 20, now)
      .status,
    "no_nearby",
  );
  assert.equal(
    rainfallContext({ stations: [], status: "unavailable" }, location, 20, now)
      .status,
    "unavailable",
  );
});

test("rain national cache coalesces callers without coordinates or cookies and throttling preserves the original timestamp", async () => {
  let time = now,
    calls = 0,
    fail = false;
  const source = createRainSource({
    now: () => time,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, RAIN_URL);
      assert.equal(options.credentials, "omit");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fail
        ? new Response("", { status: 429, headers: { "retry-after": "1800" } })
        : response();
    },
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => source.get()),
  );
  assert.equal(calls, 1);
  time += 5 * 60000 + 1;
  fail = true;
  const stale = await source.get();
  assert.equal(stale.status, "stale");
  assert.equal(stale.fetchedAt, results[0].fetchedAt);
  time += 10 * 60000;
  await source.get();
  assert.equal(calls, 2);
  time += 6 * 3600000;
  const expired = await source.get();
  assert.equal(expired.status, "unavailable");
  assert.deepEqual(expired.stations, []);
});

test("a saved rain card ages and expires during repeated request failures", () => {
  const context = rainfallContext(
    {
      stations: normalizeRainfall(payload()),
      status: "fresh",
      fetchedAt: new Date(now).toISOString(),
    },
    location,
    20,
    now,
  );
  assert.equal(
    cachedRainfallContext(context, location, 20, now).status,
    "available",
  );
  assert.equal(
    cachedRainfallContext(context, location, 20, now + 5 * 60000).status,
    "stale",
  );
  assert.equal(
    cachedRainfallContext(context, location, 20, now + 7 * 3600000).station,
    null,
  );
  assert.equal(
    cachedRainfallContext(context, location, 20, now + 7 * 3600000).status,
    "unavailable",
  );
});

test("rain malformed and oversized responses never create observations", async () => {
  for (const body of [
    '{"result":"OK","data":[]}',
    "x".repeat(9 * 1024 * 1024),
  ]) {
    const source = createRainSource({
      fetcher: async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    });
    assert.equal((await source.get()).status, "unavailable");
  }
});

test("official tide dataset has every 2026 day and hour, explicit MSL/Thailand time and source checksums", () => {
  assert.equal(tables.length, 2);
  for (const station of tables) {
    assert.equal(station.kind, "prediction");
    assert.equal(station.datum, "msl");
    assert.equal(station.timezone, "Asia/Bangkok");
    assert.equal(Object.keys(station.days).length, 365);
    assert.match(station.pdfSha256, /^[a-f0-9]{64}$/);
    for (const hours of Object.values(station.days)) {
      assert.equal(hours.length, 24);
      assert.ok(hours.every((v) => Number.isFinite(v) && Math.abs(v) < 10));
    }
  }
  // Cross-checked against the official October PDF, page 166 (MSL edition).
  assert.deepEqual(
    tables[0].days["2026-10-04"].slice(8, 15),
    [-0.3, 0.1, 0.6, 0.9, 1.1, 1.2, 1.2],
  );
});

test("tide uses a documented coastal reference and exact hourly predictions, never a local sensor or interpolated value", () => {
  const tide = tideContext(location, now);
  assert.equal(tide.kind, "prediction");
  assert.equal(tide.station.id, "mae-klong");
  assert.equal(tide.station.distanceKm, 16.18);
  assert.equal(tide.current.at, "2026-10-04T02:00:00.000Z");
  assert.equal(tide.current.levelMsl, 0.1);
  assert.equal(tide.high.levelMsl, 1.2);
  assert.equal(tide.high.at, "2026-10-04T06:00:00.000Z");
  assert.equal(tideContext(location, now + 29 * 60000).current.levelMsl, 0.1);
  assert.equal(
    tideContext({ lat: 13.48, lon: 100.27 }, now).station.id,
    "tha-chin",
  );
  assert.equal(
    tideContext({ lat: 18.79, lon: 98.98 }, now).status,
    "no_nearby",
  );
});

test("tide rejects an uncovered year/datum and incomplete future windows instead of inventing predictions", () => {
  assert.equal(
    tideContext(location, Date.parse("2027-01-01T00:00:00+07:00")).status,
    "unavailable",
  );
  assert.equal(
    tideContext(location, now, [{ ...tables[0], datum: "local" }]).status,
    "no_nearby",
  );
  assert.equal(
    tideContext(location, Date.parse("2026-12-31T12:00:00+07:00")).high,
    null,
  );
});
