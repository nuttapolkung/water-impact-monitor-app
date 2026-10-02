import test from "node:test";
import assert from "node:assert/strict";
import { createWaterCache } from "../src/cache.js";

const data = {
  waterlevel_data: {
    result: "OK",
    data: [
      {
        waterlevel_msl: "1",
        situation_level: 3,
        waterlevel_datetime: "2026-10-02 19:20",
        station: {
          id: 1,
          tele_station_name: { th: "สถานี" },
          tele_station_lat: 13,
          tele_station_long: 100,
        },
      },
    ],
  },
};
const logger = { info() {}, warn() {} };
const response = () =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });

test("concurrent requests share one upstream fetch and cached requests do not refetch", async () => {
  let calls = 0;
  const cache = createWaterCache({
    file: null,
    logger,
    fetcher: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return response();
    },
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => cache.get()),
  );
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.status === "fresh"));
  await cache.get();
  assert.equal(calls, 1);
});

test("retry and backoff preserve last-known-good data without resetting its timestamp", async () => {
  let timestamp = Date.parse("2026-10-02T12:30:00Z"),
    calls = 0,
    fail = false;
  const cache = createWaterCache({
    file: null,
    logger,
    now: () => timestamp,
    ttlMs: 1000,
    retryAfterMs: 10000,
    maxStaleMs: 100000,
    fetcher: async () => {
      calls++;
      if (fail) return new Response("{}", { status: 500 });
      return response();
    },
  });
  const original = await cache.get();
  fail = true;
  timestamp += 1001;
  const stale = await cache.get();
  assert.equal(stale.status, "stale");
  assert.equal(stale.fetchedAt, original.fetchedAt);
  assert.equal(calls, 3);
  await cache.get();
  assert.equal(calls, 3);
  timestamp += 100000;
  const expired = await cache.get();
  assert.equal(expired.status, "unavailable");
  assert.equal(expired.stations.length, 0);
});

test("schema failures never poison the last-known-good cache", async () => {
  let timestamp = Date.now(),
    malformed = false;
  const cache = createWaterCache({
    file: null,
    logger,
    now: () => timestamp,
    ttlMs: 1000,
    fetcher: async () =>
      malformed
        ? new Response('{"data":[]}', {
            headers: { "Content-Type": "application/json" },
          })
        : response(),
  });
  const original = await cache.get();
  malformed = true;
  timestamp += 1001;
  const stale = await cache.get();
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.stations, original.stations);
});
