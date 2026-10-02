import test from "node:test";
import assert from "node:assert/strict";
import {
  compareHistory,
  normalizeRidHistory,
  normalizeThaiWaterHistory,
  createHistorySource,
  historyReference,
} from "../assets/history.js";
import { fetchRidBrowserStation } from "../assets/rid-source.js";

const anchor = Date.parse("2026-10-02T19:00:00Z");
const at = (hours) => new Date(anchor - hours * 3600000).toISOString();
const station = {
  id: "rid:383:0",
  source: "RID",
  code: "TMK03/WL_UP",
  gaugeParameter: "WL_UP",
  waterLevelMsl: 2.26,
  waterLevelLocal: null,
  sensorUpdatedAt: at(0),
  dataQuality: "fresh",
};
const graph = (id = "383", levels = [2.257, 2.262, 2.3, 2.2, 2]) => ({
  id,
  code: "TMK03",
  cross_section: [
    { unit: 0, parameter: "WL_UP" },
    { unit: 0, parameter: "WL_DOWN" },
  ],
  values: {
    water_level_graph: {
      0: {
        time: [0, 1, 3, 6, 24].map((h) => Date.parse(at(h)) / 1000),
        value: levels,
      },
      1: {
        time: [0, 1, 3, 6, 24].map((h) => Date.parse(at(h)) / 1000),
        value: [2.63, 2.7, 2.8, 2.9, 3],
      },
    },
  },
});
const compare = (
  s = station,
  h = normalizeRidHistory(graph(), "383"),
  options = {},
) => compareHistory(s, h, { now: anchor + 60000, ...options });

test("history compares 1/3/6/24 hours using unrounded same-instant readings and preserves each gauge", () => {
  const history = normalizeRidHistory(graph(), "383");
  const up = compare(station, history);
  assert.equal(up.status, "ready");
  assert.deepEqual(
    up.comparisons.map((c) => c.deltaCm),
    [-0.5, -4.3, 5.7, 25.7],
  );
  assert.deepEqual(
    up.comparisons.map((c) => c.actualMinutes),
    [60, 180, 360, 1440],
  );
  assert.equal(up.comparisons[0].currentLevel, 2.257);
  const down = compare(
    {
      ...station,
      id: "rid:383:1",
      code: "TMK03/WL_DOWN",
      gaugeParameter: "WL_DOWN",
      waterLevelMsl: 2.63,
    },
    history,
  );
  assert.deepEqual(
    down.comparisons.map((c) => c.deltaCm),
    [-7, -17, -27, -37],
  );
  const identical = normalizeRidHistory(
    graph("383", [2.257, 2.257, 2.257, 2.257, 2.257]),
    "383",
  );
  assert.ok(
    compare(station, identical).comparisons.every(
      (c) => c.direction === "stable",
    ),
  );
});

test("historical deltas require matching station/provider/parameter/datum and an exact current reading", () => {
  const history = normalizeRidHistory(graph(), "383");
  for (const changed of [
    { ...history, resourceId: "999" },
    { ...history, provider: "ThaiWater" },
    { ...history, code: "OTHER" },
    {
      ...history,
      channels: [{ ...history.channels[0], parameter: "WL_DOWN" }],
    },
    { ...history, channels: [{ ...history.channels[0], datum: "local" }] },
    {
      ...history,
      channels: [
        {
          ...history.channels[0],
          points: history.channels[0].points.filter((p) => p.at !== at(0)),
        },
      ],
    },
  ])
    assert.equal(compare(station, changed).status, "incompatible");
  assert.equal(
    compare({ ...station, waterLevelMsl: 3 }, history).status,
    "incompatible",
  );
  assert.equal(historyReference({ ...station, id: "rid:../../:0" }), null);
  const local = structuredClone(graph());
  local.cross_section[0].unit = 1;
  assert.equal(
    compare(
      { ...station, waterLevelMsl: null, waterLevelLocal: 2.26 },
      normalizeRidHistory(local, "383"),
    ).datum,
    "local",
  );
});

test("missing windows are not interpolated; nearby timestamps carry actual intervals and stale observations are suppressed", () => {
  const history = normalizeRidHistory(graph(), "383");
  const ch = history.channels[0];
  ch.points = ch.points.filter((p) => p.at !== at(3) && p.at !== at(6));
  ch.points.push({ at: at(3.25), level: 2.3 }, { at: at(6.251), level: 2.2 });
  const result = compare(station, history);
  assert.equal(result.comparisons[1].approximate, true);
  assert.equal(result.comparisons[1].actualMinutes, 195);
  assert.equal(result.comparisons[2].status, "missing");
  for (const options of [
    { sourceStatus: "stale" },
    { sourceStatus: "unavailable" },
    { now: anchor + 3 * 3600000 + 1 },
    { now: anchor - 300001 },
  ]) {
    const stale = compare(station, history, options);
    assert.equal(stale.status, "stale");
    assert.ok(stale.comparisons.every((c) => c.status === "missing"));
  }
  assert.equal(
    compare({ ...station, dataQuality: "missing" }, history).status,
    "stale",
  );
});

test("graph normalization keeps negative/zero levels, rejects impossible values and drops conflicting duplicates", () => {
  const payload = graph();
  payload.values.water_level_graph[0] = {
    time: [1, 2, 3, 4, 5, 6, 7, 7, 7].map((n) => anchor / 1000 - n * 900),
    value: [0, -0.2, null, 32767, -32767, "bad", 1, 2, 1],
  };
  assert.deepEqual(
    normalizeRidHistory(payload, "383").channels[0].points.map((p) => p.level),
    [-0.2, 0],
  );
  assert.throws(() => normalizeRidHistory(graph(), "999"), /SCHEMA/);
  payload.values.water_level_graph[0].time.pop();
  assert.throws(() => normalizeRidHistory(payload, "383"), /SCHEMA/);
  const thai = normalizeThaiWaterHistory(
    {
      result: "OK",
      data: {
        graph_data: [
          { datetime: "2026-10-03 02:00", value: ".528" },
          { datetime: "2026-10-03 02:10", value: null },
        ],
      },
    },
    "754",
  );
  assert.equal(thai.channels[0].points[0].at, at(0));
  assert.equal(thai.channels[0].datum, "msl");
  assert.equal(thai.channels[0].points.length, 1);
});

test("history source coalesces two gauges of one station, bounds concurrency and caches results for five minutes", async () => {
  let time = anchor,
    calls = 0,
    active = 0,
    max = 0;
  const source = createHistorySource({
    now: () => time,
    ridLoader: async ({ stationId }) => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return graph(stationId);
    },
  });
  const same = source.get(station),
    down = source.get({ ...station, id: "rid:383:1" });
  assert.equal(same, down);
  const results = await Promise.all([
    same,
    down,
    ...[384, 385, 386].map((id) =>
      source.get({ ...station, id: `rid:${id}:0` }),
    ),
  ]);
  assert.ok(results.every((r) => r.status === "ready"));
  assert.equal(calls, 4);
  assert.equal(max, 2);
  await source.get(station);
  assert.equal(calls, 4);
  time += 5 * 60000 + 1;
  await source.get(station);
  assert.equal(calls, 5);
});

test("rate limits cool down the entire provider, honor Retry-After and leave RID independent", async () => {
  let time = anchor,
    calls = 0,
    rid = 0;
  const source = createHistorySource({
    now: () => time,
    concurrency: 1,
    fetcher: async () => {
      calls++;
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "1800" },
      });
    },
    ridLoader: async () => {
      rid++;
      return graph();
    },
  });
  const thai = { ...station, source: "ThaiWater", id: "754" };
  const first = await source.get(thai);
  assert.equal(first.status, "rate_limited");
  assert.equal(first.expiresAt, anchor + 1800000);
  assert.equal(
    (await source.get({ ...thai, id: "755" })).status,
    "rate_limited",
  );
  assert.equal(calls, 1);
  assert.equal((await source.get(station)).status, "ready");
  assert.equal(rid, 1);
  time += 900001;
  await source.get(thai);
  assert.equal(calls, 1);
  time += 900001;
  await source.get(thai);
  assert.equal(calls, 2);
});

test("ThaiWater graph queries carry station/date only, omit credentials, and reject malformed or oversized bodies", async () => {
  const thai = {
    ...station,
    source: "ThaiWater",
    id: "754",
    historyStationType: "tele_waterlevel",
  };
  const source = createHistorySource({
    now: () => anchor,
    fetcher: async (url, options) => {
      const u = new URL(url);
      assert.equal(u.searchParams.get("station_id"), "754");
      assert.equal(u.searchParams.get("station_type"), "tele_waterlevel");
      assert.equal(u.searchParams.has("lat"), false);
      assert.equal(u.searchParams.has("lon"), false);
      assert.equal(options.credentials, "omit");
      return new Response(
        JSON.stringify({
          result: "OK",
          data: {
            graph_data: [{ datetime: "2026-10-03 02:00", value: 0.528 }],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal((await source.get(thai)).status, "ready");
  assert.equal(
    (await source.get({ ...thai, historyStationType: "canal" })).status,
    "unsupported",
  );
  for (const body of ["{}", "x".repeat(1024 * 1024 + 1)]) {
    const bad = createHistorySource({
      fetcher: async () =>
        new Response(body, { headers: { "Content-Type": "application/json" } }),
    });
    assert.equal((await bad.get(thai)).status, "unavailable");
  }
});

test("station history socket uses the public detail endpoint, closes after graph receipt and validates IDs", async () => {
  let socket;
  class Socket extends EventTarget {
    constructor(url) {
      super();
      socket = this;
      this.url = url;
    }
    close() {
      this.closed = true;
    }
    message(payload) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ message: JSON.stringify(payload) }),
        }),
      );
    }
  }
  const request = fetchRidBrowserStation({ stationId: "383", Socket });
  assert.equal(socket.url, "wss://telerid.rid.go.th/ws/station/383/");
  socket.message(graph());
  assert.equal((await request).id, "383");
  assert.equal(socket.closed, true);
  await assert.rejects(
    fetchRidBrowserStation({ stationId: "../383", Socket }),
    /INVALID/,
  );
  await assert.rejects(
    fetchRidBrowserStation({ stationId: "383", Socket, timeoutMs: 5 }),
    /TIMEOUT/,
  );
  assert.equal(socket.closed, true);
});
