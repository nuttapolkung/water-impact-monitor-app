import test from "node:test";
import assert from "node:assert/strict";
import { combineSnapshots, mergeWaterResponses } from "../assets/source-set.js";
import { nearbyStations } from "../assets/water.js";

const now = Date.parse("2026-10-03T08:30:00Z");
const location = { lat: 13.518, lon: 99.954 };
const station = {
  id: "rid:383:0",
  source: "RID",
  name: "ปตร.บางนกแขวก · เหนือน้ำ",
  lat: 13.500218,
  lon: 99.9273112,
  sensorUpdatedAt: new Date(now - 60000).toISOString(),
  waterLevelMsl: 2.2,
  waterLevelLocal: null,
  thresholdDatum: "msl",
  warningLevel: 2.5,
  criticalLevel: 2.8,
  situation: "normal",
  situationLabel: "ต่ำกว่าเกณฑ์เฝ้าระวัง RID",
  bankGapM: null,
  riseRateCmPerHour: null,
};
const thaiStation = {
  ...station,
  id: "754",
  source: "ThaiWater",
  name: "บ้านแพ้ว",
  lat: 13.57563,
  lon: 100.07884,
};
const snapshot = (name, stations, status = "fresh") => ({
  sourceName: name,
  sourceUrl: `https://example.test/${name}`,
  stations,
  status,
  fetchedAt: new Date(now).toISOString(),
});

test("combined station coverage includes Bang Nok Khwaek 3.5 km away when ThaiWater's nearest is 14.94 km away", () => {
  const result = combineSnapshots([
    snapshot("ThaiWater", [thaiStation]),
    snapshot("RID", [station]),
  ]);
  const nearby = nearbyStations(result.stations, location, 20, now);
  assert.equal(nearby[0].name, station.name);
  assert.equal(nearby[0].distanceKm, 3.5);
  assert.equal(nearby[1].distanceKm, 14.94);
  assert.equal(result.sourceName, "ThaiWater + RID");
});

test("browser supplementation fills missing RID without duplicating API gauges and preserves global distance order", () => {
  const base = {
    location,
    radiusKm: 20,
    version: "test",
    stations: [thaiStation],
    source: {
      name: "ThaiWater",
      status: "fresh",
      sources: [
        {
          name: "ThaiWater",
          status: "fresh",
          fetchedAt: new Date(now).toISOString(),
        },
        { name: "RID", status: "unavailable", fetchedAt: null },
      ],
    },
  };
  const rid = {
    stations: [
      station,
      { ...station, id: "rid:383:1", name: "ปตร.บางนกแขวก · ท้ายน้ำ" },
    ],
    updatedAt: new Date(now).toISOString(),
    source: {
      name: "RID · เบราว์เซอร์",
      status: "fresh",
      transport: "browser",
    },
  };
  const result = mergeWaterResponses(base, rid, now);
  assert.equal(result.stations.length, 3);
  assert.equal(result.stations[0].distanceKm, 3.5);
  assert.equal(result.stations[1].distanceKm, 3.5);
  assert.equal(result.source.partial, false);
  assert.equal(
    result.source.sources.find((s) => s.name === "RID").transport,
    "browser",
  );
  assert.equal(mergeWaterResponses(result, rid, now).stations.length, 3);
  assert.equal(result.assessment.confidence, "low");
});

test("a saved source stays stale even when another source is fresh and cannot drive a water warning", () => {
  const result = combineSnapshots([
    snapshot("ThaiWater", [thaiStation]),
    snapshot(
      "RID",
      [{ ...station, waterLevelMsl: 3, situation: "critical" }],
      "stale",
    ),
  ]);
  const nearby = nearbyStations(result.stations, location, 20, now);
  assert.equal(result.status, "fresh");
  assert.equal(result.partial, true);
  assert.equal(nearby[0].dataQuality, "stale");
  const base = {
    location,
    radiusKm: 20,
    stations: [thaiStation],
    source: { name: "ThaiWater", status: "fresh" },
  };
  const merged = mergeWaterResponses(
    base,
    {
      stations: [{ ...station, waterLevelMsl: 3, situation: "critical" }],
      source: { name: "RID", status: "stale" },
    },
    now,
  );
  assert.equal(merged.stations[0].dataQuality, "stale");
  assert.ok(
    !merged.assessment.reasons.some((reason) => reason.includes("บางนกแขวก")),
  );
});

test("a stale supplement improves unavailable coverage but never overwrites a fresher gauge", () => {
  const result = combineSnapshots([
    snapshot("RID", [], "unavailable"),
    snapshot("RID", [station], "stale"),
  ]);
  assert.equal(result.sources[0].status, "stale");
  assert.equal(result.status, "stale");
  const fresh = combineSnapshots([
    snapshot("RID", [station]),
    snapshot("RID", [{ ...station, waterLevelMsl: 9 }], "stale"),
  ]);
  assert.equal(fresh.stations[0].waterLevelMsl, 2.2);
});
