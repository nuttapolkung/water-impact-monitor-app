import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserSource } from "../assets/browser-source.js";
import { SOURCE_URL } from "../src/water.js";

const payload = {
  waterlevel_data: {
    result: "OK",
    data: [
      {
        station: {
          id: 1,
          tele_station_name: { th: "สถานีจริง" },
          tele_station_lat: 13.52,
          tele_station_long: 99.95,
        },
        waterlevel_msl: "2.1",
        situation_level: 3,
        waterlevel_datetime: "2026-10-02 20:15:00",
      },
    ],
  },
};
const response = () =>
  new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
const query = {
  location: { lat: 13.518, lon: 99.954 },
  radiusKm: 50,
  version: "test",
};

test("browser fallback shares a national fetch, sends no location/cookies and identifies its route", async () => {
  let calls = 0;
  const source = createBrowserSource({
    now: () => Date.parse("2026-10-02T13:20:00Z"),
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, SOURCE_URL);
      assert.equal(options.credentials, "omit");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response();
    },
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => source.get(query)),
  );
  assert.equal(calls, 1);
  assert.ok(
    results.every(
      (r) => r.source.transport === "browser" && r.source.status === "fresh",
    ),
  );
  assert.equal(results[0].stations[0].waterLevelMsl, 2.1);
  assert.equal(results[0].assessment.confidence, "low");
  const distant = await source.get({ ...query, location: { lat: 0, lon: 0 } });
  assert.equal(calls, 1);
  assert.equal(distant.stations.length, 0);
  assert.equal(distant.assessment.score, null);
});

test("browser fallback throttling retains the original timestamp and suppresses a stale score", async () => {
  let timestamp = Date.parse("2026-10-02T13:20:00Z"),
    calls = 0,
    fail = false;
  const source = createBrowserSource({
    now: () => timestamp,
    fetcher: async () => {
      calls++;
      return fail
        ? new Response("{}", {
            status: 429,
            headers: { "Retry-After": "1800" },
          })
        : response();
    },
  });
  const original = await source.get(query);
  timestamp += 60001;
  fail = true;
  const stale = await source.get(query);
  assert.equal(stale.updatedAt, original.updatedAt);
  assert.equal(stale.source.status, "stale");
  assert.equal(stale.assessment.score, null);
  timestamp += 60000;
  await source.get(query);
  assert.equal(calls, 2);
  timestamp += 6 * 3600000;
  await assert.rejects(source.get(query), /SOURCE_UNAVAILABLE/);
});

test("browser fallback refuses invalid and oversized responses without producing measurements", async () => {
  const malformed = createBrowserSource({
    fetcher: async () =>
      new Response('{"data":[]}', {
        headers: { "Content-Type": "application/json" },
      }),
  });
  await assert.rejects(malformed.get(query), /SOURCE_UNAVAILABLE/);
  const oversized = createBrowserSource({
    fetcher: async () =>
      new Response("x".repeat(9 * 1024 * 1024), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  await assert.rejects(oversized.get(query), /SOURCE_UNAVAILABLE/);
});
