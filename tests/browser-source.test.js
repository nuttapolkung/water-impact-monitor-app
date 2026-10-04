import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserSource } from "../assets/browser-source.js";
import { SOURCE_URL } from "../src/water.js";
import { RID_URL, fetchRidBrowserSnapshot } from "../assets/rid-source.js";

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

test("browser RID failover keeps ThaiWater throttled while refreshing independent snapshots", async () => {
  let time = Date.parse("2026-10-02T13:20:00Z"),
    primary = 0,
    secondary = 0;
  const source = createBrowserSource({
    now: () => time,
    fetcher: async () => {
      primary++;
      return new Response("", { status: 429 });
    },
    ridFetcher: async () => {
      secondary++;
      return {
        type: "INIT",
        data: {
          383: {
            name: "ปตร.บางนกแขวก",
            location: { x: 99.927, y: 13.5 },
            measure: { wl: true },
            cross_section: [{ unit: 0, warning: 2.5, critical: 2.8 }],
            values: { water_level: { value: 2.9, unixtime: time / 1000 } },
          },
        },
      };
    },
  });
  const first = await source.get(query);
  assert.match(first.source.name, /RID/);
  assert.equal(first.stations[0].waterLevelMsl, 2.9);
  assert.equal(first.stations[0].situation, "critical");
  assert.equal(first.assessment.confidence, "low");
  await source.get(query);
  assert.equal(secondary, 1);
  time += 60001;
  await source.get(query);
  assert.equal(primary, 1);
  assert.equal(secondary, 2);
});

test("water keeps a shared RID snapshot's original fetch time instead of renewing its freshness", async () => {
  let time = Date.parse("2026-10-02T13:20:00Z");
  const fetchedAt = new Date(time - 45000).toISOString();
  let failed = false;
  const source = createBrowserSource({
    includeThaiWater: false,
    now: () => time,
    ridFetcher: async () => {
      if (failed) throw new Error("failed refresh");
      return {
        fetchedAt,
        payload: {
          type: "INIT",
          data: {
            383: {
              name: "บางนกแขวก",
              location: { x: 99.927, y: 13.5 },
              measure: { wl: true },
              cross_section: [{ unit: 0, warning: 2.5, critical: 2.8 }],
              values: { water_level: { value: 2.9, unixtime: time / 1000 } },
            },
          },
        },
      };
    },
  });
  const first = await source.get(query);
  assert.equal(first.updatedAt, fetchedAt);
  assert.equal(first.source.status, "fresh");
  time += 16000;
  failed = true;
  const stale = await source.get(query);
  assert.equal(stale.updatedAt, fetchedAt);
  assert.equal(stale.source.status, "stale");
  assert.equal(stale.assessment.score, null);
});

test("browser RID reads one public INIT then closes and abort/timeout close sockets", async () => {
  let socket;
  class FakeSocket extends EventTarget {
    constructor(...args) {
      super();
      socket = this;
      this.args = args;
    }
    close() {
      this.closed = true;
    }
    message(data) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  const request = fetchRidBrowserSnapshot({
    Socket: FakeSocket,
    timeoutMs: 100,
  });
  assert.deepEqual(socket.args, [RID_URL]);
  socket.message(
    JSON.stringify({ message: JSON.stringify({ type: "INIT", data: {} }) }),
  );
  assert.equal((await request).type, "INIT");
  assert.equal(socket.closed, true);
  const controller = new AbortController();
  const aborted = fetchRidBrowserSnapshot({
    Socket: FakeSocket,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal(socket.closed, true);
  await assert.rejects(
    fetchRidBrowserSnapshot({ Socket: FakeSocket, timeoutMs: 5 }),
    /TIMEOUT/,
  );
  assert.equal(socket.closed, true);
});

test("RID supplement loads independently of healthy ThaiWater and shares its national cache", async () => {
  let time = Date.parse("2026-10-03T00:00:00Z"),
    calls = 0;
  const source = createBrowserSource({
    includeThaiWater: false,
    now: () => time,
    fetcher: () => {
      throw new Error("ThaiWater must not replace the RID supplement");
    },
    ridFetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        type: "INIT",
        data: {
          383: {
            name: "ปตร.บางนกแขวก",
            location: { x: 99.9273112, y: 13.500218 },
            measure: { wl: true },
            cross_section: [{ unit: 0, warning: 2.5, critical: 2.8 }],
            values: { water_level: { value: 2.1, unixtime: time / 1000 } },
          },
        },
      };
    },
  });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => source.get(query)),
  );
  assert.equal(calls, 1);
  assert.ok(
    results.every(
      (r) => r.source.name.startsWith("RID") && r.stations.length === 1,
    ),
  );
  assert.ok(Math.abs(results[0].stations[0].distanceKm - 3.5) < 0.02);
  await source.get({ ...query, location: { lat: 0, lon: 0 } });
  assert.equal(calls, 1);
  time += 60001;
  await source.get(query);
  assert.equal(calls, 2);
});
