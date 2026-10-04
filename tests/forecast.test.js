import test from "node:test";
import assert from "node:assert/strict";
import { forecastWaterLevel } from "../assets/forecast.js";
import { normalizeRidHistory } from "../assets/history.js";

const anchor = Date.parse("2026-10-04T03:00:00Z");
const at = (h) => new Date(anchor - h * 3600000).toISOString();
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
const history = () =>
  normalizeRidHistory(
    {
      id: 383,
      code: "TMK03",
      cross_section: [{ unit: 0, parameter: "WL_UP" }],
      values: {
        water_level_graph: {
          0: {
            time: [0, 0.25, 0.5, 0.75, 1].map((h) => Date.parse(at(h)) / 1000),
            value: [2.257, 2.25825, 2.2595, 2.26075, 2.262],
          },
        },
      },
    },
    "383",
  );
const forecast = (s = station, h = history(), options = {}) =>
  forecastWaterLevel(s, h, { now: anchor + 1800000, ...options });

test("level projection uses the unrounded gauge rate and accounts for the measurement-to-now delay", () => {
  const f = forecast();
  assert.equal(f.status, "ready");
  assert.equal(f.model, "constant_level_change_rate");
  assert.equal(f.datum, "msl");
  assert.equal(f.sampleCount, 5);
  assert.equal(f.baseLevel, 2.257);
  assert.ok(Math.abs(f.rateMPerHour + 0.005) < 1e-10);
  assert.deepEqual(
    f.projections.map((p) => p.hours),
    [1, 3, 6],
  );
  assert.equal(f.projections[0].at, "2026-10-04T04:30:00.000Z");
  assert.ok(Math.abs(f.projections[0].level - 2.2495) < 1e-10);
  assert.ok(Math.abs(f.projections[2].level - 2.2245) < 1e-10);
  assert.ok(Math.abs(f.projections[0].deltaCm + 0.75) < 1e-10);
});

test("forecast refuses stale sources, old actual channel readings and future clock mismatches", () => {
  for (const result of [
    forecast(station, history(), { sourceStatus: "stale" }),
    forecast({ ...station, sourceStatus: "stale" }),
    forecast({ ...station, dataQuality: "stale" }),
    forecast(station, history(), { now: anchor + 3600001 }),
    forecast(station, history(), { now: anchor - 60000 }),
    forecast(
      { ...station, sensorUpdatedAt: new Date(anchor + 5400000).toISOString() },
      history(),
      { now: anchor + 5400000 },
    ),
  ]) {
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.projections, []);
  }
});

test("forecast requires at least three real observations and no gap above 30 minutes in the baseline interval", () => {
  const h = history();
  h.channels[0].points = h.channels[0].points.filter((p) =>
    [at(0), at(1)].includes(p.at),
  );
  assert.equal(forecast(station, h).reason, "sparse_history");
  const gap = history();
  gap.channels[0].points = gap.channels[0].points.filter((p) =>
    [at(0), at(0.25), at(1)].includes(p.at),
  );
  assert.equal(forecast(station, gap).reason, "sparse_history");
  const missing = history();
  missing.channels[0].points = missing.channels[0].points.filter(
    (p) => Date.parse(p.at) > Date.parse(at(0.75)),
  );
  assert.equal(forecast(station, missing).reason, "missing_baseline");
});

test("forecast preserves datum and rejects another station, channel or conflicting current value", () => {
  for (const h of [
    { ...history(), resourceId: "999" },
    { ...history(), code: "OTHER" },
    {
      ...history(),
      channels: [{ ...history().channels[0], parameter: "WL_DOWN" }],
    },
    { ...history(), channels: [{ ...history().channels[0], datum: "local" }] },
  ])
    assert.equal(forecast(station, h).status, "unavailable");
  assert.equal(
    forecast({ ...station, waterLevelMsl: 2.5 }).status,
    "unavailable",
  );
  const local = history();
  local.channels[0].datum = "local";
  assert.equal(
    forecast({ ...station, waterLevelMsl: null, waterLevelLocal: 2.26 }, local)
      .datum,
    "local",
  );
});

test("stable water projects a constant value and negative MSL is not clamped to invented zero", () => {
  const stable = history();
  stable.channels[0].points.forEach((p) => (p.level = 2.257));
  const f = forecast(station, stable);
  assert.equal(f.rateMPerHour, 0);
  assert.ok(f.projections.every((p) => p.level === 2.257 && p.deltaCm === 0));
  const negative = history();
  negative.channels[0].points.forEach((p) => (p.level -= 2.3));
  const n = forecast({ ...station, waterLevelMsl: -0.04 }, negative);
  assert.equal(n.status, "ready");
  assert.ok(n.projections.every((p) => p.level < 0));
});
