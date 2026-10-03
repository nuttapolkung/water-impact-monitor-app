import test from "node:test";
import assert from "node:assert/strict";
import { createWaterCache, THAIWATER_SOURCE } from "../src/cache.js";

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
    sources: [THAIWATER_SOURCE],
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
    sources: [THAIWATER_SOURCE],
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
    sources: [THAIWATER_SOURCE],
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

test("429 honors Retry-After and primary recovery retains supplementary station coverage", async () => {
  let timestamp = Date.parse("2026-10-02T13:00:00Z"),
    calls = 0,
    fallbackCalls = 0,
    recover = false;
  const backup = {
    name: "backup",
    url: "test:backup",
    normalize: (p) => p,
    load: async () => {
      fallbackCalls++;
      return [{ id: "backup:1", name: "independent observation" }];
    },
  };
  const cache = createWaterCache({
    file: null,
    logger,
    now: () => timestamp,
    sources: [THAIWATER_SOURCE, backup],
    fetcher: async () => {
      calls++;
      return recover
        ? response()
        : new Response("{}", {
            status: 429,
            headers: { "Retry-After": "1800" },
          });
    },
  });
  const first = await cache.get();
  assert.equal(first.status, "fresh");
  assert.equal(first.sourceName, "backup");
  assert.equal(first.fallback, true);
  assert.equal(calls, 1);
  timestamp += 60000;
  await cache.get();
  assert.equal(calls, 1);
  assert.equal(fallbackCalls, 2);
  recover = true;
  timestamp += 1800000;
  const primary = await cache.get();
  assert.equal(primary.sourceName, "ThaiWater + backup");
  assert.deepEqual(
    primary.stations.map((s) => s.id),
    ["1", "backup:1"],
  );
  assert.equal(fallbackCalls, 3);
  assert.equal(primary.fallback, false);
  assert.equal(calls, 2);
});

test("healthy primary still fetches and combines the independent supplementary source once for concurrent callers", async () => {
  let primaryCalls = 0,
    supplementaryCalls = 0;
  const cache = createWaterCache({
    file: null,
    logger,
    sources: [
      THAIWATER_SOURCE,
      {
        name: "RID",
        url: "test:rid",
        normalize: (p) => p,
        load: async () => {
          supplementaryCalls++;
          return [{ id: "rid:383:0", name: "ปตร.บางนกแขวก" }];
        },
      },
    ],
    fetcher: async () => {
      primaryCalls++;
      return response();
    },
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => cache.get()),
  );
  assert.equal(primaryCalls, 1);
  assert.equal(supplementaryCalls, 1);
  assert.ok(
    results.every(
      (result) =>
        result.stations.length === 2 &&
        result.sourceName === "ThaiWater + RID" &&
        !result.partial,
    ),
  );
  await cache.get();
  assert.equal(supplementaryCalls, 1);
});

test("a failed supplement stays stale when the primary refreshes, retains its timestamp and respects cooldown", async () => {
  let timestamp = Date.parse("2026-10-02T13:00:00Z"),
    fail = false,
    calls = 0;
  const cache = createWaterCache({
    file: null,
    logger,
    now: () => timestamp,
    ttlMs: 1000,
    retryAfterMs: 10000,
    sources: [
      THAIWATER_SOURCE,
      {
        name: "RID",
        url: "test:rid",
        normalize: (p) => p,
        attempts: 1,
        load: async () => {
          calls++;
          if (fail) throw new Error("failed");
          return [{ id: "rid:383:0" }];
        },
      },
    ],
    fetcher: async () => response(),
  });
  const first = await cache.get();
  fail = true;
  timestamp += 1001;
  const second = await cache.get();
  assert.equal(second.status, "fresh");
  assert.equal(second.partial, true);
  assert.equal(
    second.stations.find((s) => s.id.startsWith("rid:")).sourceStatus,
    "stale",
  );
  assert.equal(
    second.sources.find((s) => s.name === "RID").fetchedAt,
    first.sources.find((s) => s.name === "RID").fetchedAt,
  );
  timestamp += 1001;
  await cache.get();
  assert.equal(calls, 2);
});

test("all sources failing keeps the retry timestamp stable and disables assessment data", async () => {
  let timestamp = Date.now(),
    calls = 0;
  const cache = createWaterCache({
    file: null,
    logger,
    now: () => timestamp,
    sources: [THAIWATER_SOURCE],
    fetcher: async () => {
      calls++;
      return new Response("{}", {
        status: 429,
        headers: { "Retry-After": "3600" },
      });
    },
  });
  const unavailable = await cache.get();
  timestamp += 5000;
  const later = await cache.get();
  assert.equal(later.status, "unavailable");
  assert.deepEqual(later.stations, []);
  assert.equal(later.nextRefreshAt, unavailable.nextRefreshAt);
  assert.equal(calls, 1);
});
