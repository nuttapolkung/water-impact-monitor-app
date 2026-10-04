import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRainfall,
  rainfallContext,
  cachedRainfallContext,
  createRainSource,
  tideContext,
  RAIN_URL,
} from "../assets/context.js";
import tables from "../assets/tide-tables-2026.js";

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
