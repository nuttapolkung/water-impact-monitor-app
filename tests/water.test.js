import test from "node:test";
import assert from "node:assert/strict";
import {
  number,
  sensorTime,
  normalizeWater,
  nearbyStations,
  assess,
  distanceKm,
} from "../src/water.js";

export const row = (changes = {}) => ({
  waterlevel_msl: "1.20",
  waterlevel_msl_previous: "1.10",
  waterlevel_m: null,
  waterlevel_datetime: "2026-10-02 19:20",
  situation_level: 3,
  station: {
    id: 754,
    tele_station_name: { th: "บ้านแพ้ว" },
    tele_station_lat: 13.57563,
    tele_station_long: 100.07884,
    min_bank: 2.0,
  },
  ...changes,
});
export const payload = (...rows) => ({
  waterlevel_data: { result: "OK", data: rows },
});
const now = Date.parse("2026-10-02T12:30:00Z");

test("missing numeric data stays missing and Thai timestamps use UTC+7", () => {
  for (const value of [null, undefined, "", " ", false, "bad"])
    assert.equal(number(value), null);
  assert.equal(number("0"), 0);
  assert.equal(sensorTime("2026-10-02 19:20"), "2026-10-02T12:20:00.000Z");
  assert.equal(sensorTime("broken"), null);
});

test("real ThaiWater nested coordinates and station IDs are normalized", () => {
  const [station] = normalizeWater(payload(row()));
  assert.equal(station.lat, 13.57563);
  assert.equal(station.lon, 100.07884);
  assert.equal(station.id, "754");
  assert.equal(station.waterLevelMsl, 1.2);
  assert.equal(station.bankGapM, 0.8);
  assert.equal(station.trend, "rising");
  assert.equal(station.riseRateCmPerHour, null);
});

test("ThaiWater scale differentiates low water, normal water, high water and overflow", () => {
  const results = [1, 2, 3, 4, 5, null].map(
    (level) => normalizeWater(payload(row({ situation_level: level })))[0],
  );
  assert.deepEqual(
    results.map((s) => s.situation),
    ["critical_low", "low", "normal", "high", "overflow", "unknown"],
  );
});

test("station-local water levels must never be labeled MSL or compared to an MSL bank", () => {
  const [station] = normalizeWater(
    payload(row({ waterlevel_msl: null, waterlevel_m: "2.50" })),
  );
  assert.equal(station.waterLevelMsl, null);
  assert.equal(station.waterLevelLocal, 2.5);
  assert.equal(station.bankGapM, null);
  const nearby = nearbyStations(
    [station],
    { lat: station.lat, lon: station.lon },
    20,
    now,
  );
  assert.equal(assess(nearby, "fresh").score, null);
});

test("rise rate only uses distinct timestamps, and persists through repeated sensor readings", () => {
  const old = normalizeWater(
    payload(
      row({ waterlevel_datetime: "2026-10-02 18:20", waterlevel_msl: "1.1" }),
    ),
  );
  const next = normalizeWater(payload(row()), old);
  assert.equal(next[0].riseRateCmPerHour, 10);
  assert.equal(normalizeWater(payload(row()), next)[0].riseRateCmPerHour, 10);
  assert.equal(
    normalizeWater(payload(row({ waterlevel_msl: "1.3" })), next)[0]
      .riseRateCmPerHour,
    null,
  );
});

test("invalid schemas and unusable coordinates do not replace a good cache", () => {
  for (const data of [
    {},
    payload(),
    { waterlevel_data: { result: "FAIL", data: [row()] } },
    payload(
      row({
        station: { id: 1, tele_station_lat: null, tele_station_long: null },
      }),
    ),
  ])
    assert.throws(() => normalizeWater(data), /SCHEMA/);
});

test("duplicate stations prefer the newest sensor record", () => {
  const stations = normalizeWater(
    payload(row(), row({ waterlevel_datetime: "2026-10-02 18:20" })),
  );
  assert.equal(stations.length, 1);
  assert.equal(stations[0].sensorUpdatedAt, "2026-10-02T12:20:00.000Z");
});

test("stale, missing, future and unknown-status data cannot produce an all-clear score", () => {
  for (const change of [
    { waterlevel_datetime: "2026-10-01 19:20" },
    { waterlevel_msl: null },
    { waterlevel_datetime: null },
    { waterlevel_datetime: "2026-10-03 19:20" },
    { situation_level: null },
  ]) {
    const stations = nearbyStations(
      normalizeWater(payload(row(change))),
      { lat: 13.57563, lon: 100.07884 },
      20,
      now,
    );
    assert.equal(assess(stations, "fresh").score, null);
  }
  const stations = nearbyStations(
    normalizeWater(payload(row())),
    { lat: 13.57563, lon: 100.07884 },
    20,
    now,
  );
  assert.equal(assess(stations, "stale").score, null);
});

test("nearby filtering sorts distances and high water produces transparent low-confidence reasons", () => {
  const stations = nearbyStations(
    normalizeWater(payload(row({ situation_level: 5, waterlevel_msl: "2.1" }))),
    { lat: 13.518, lon: 99.954 },
    20,
    now,
  );
  assert.ok(stations[0].distanceKm > 10 && stations[0].distanceKm < 20);
  const result = assess(stations, "fresh");
  assert.equal(result.level, "high");
  assert.equal(result.confidence, "low");
  assert.ok(result.reasons[0].includes("บ้านแพ้ว"));
  assert.equal(
    nearbyStations(normalizeWater(payload(row())), { lat: 0, lon: 0 }, 100, now)
      .length,
    0,
  );
  assert.equal(distanceKm(13, 100, 13, 100), 0);
});

test("assessment reasons include the station that drives the highest score", () => {
  const nearby = nearbyStations(
    normalizeWater(payload(row())),
    { lat: 13.57563, lon: 100.07884 },
    50,
    now,
  )[0];
  const stations = Array.from({ length: 8 }, (_, i) => ({
    ...nearby,
    id: String(i),
    name: "สถานี" + i,
    distanceKm: i + 1,
    situation: "high",
    situationLabel: "น้ำมาก",
    bankGapM: 1,
  }));
  stations.push({
    ...nearby,
    id: "overflow",
    name: "สถานีล้นตลิ่ง",
    distanceKm: 15,
    situation: "overflow",
    situationLabel: "น้ำล้นตลิ่ง",
    bankGapM: -0.2,
  });
  const result = assess(stations, "fresh");
  assert.ok(result.reasons[0].includes("สถานีล้นตลิ่ง"));
});
