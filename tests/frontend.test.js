import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(
  new URL("../assets/app.js", import.meta.url),
  "utf8",
);
const station = {
  id: "754",
  name: "<img src=x onerror=alert(1)>",
  lat: 13.57563,
  lon: 100.07884,
  distanceKm: 14.9,
  waterLevelMsl: 0.52,
  waterLevelLocal: null,
  bankGapM: 0.44,
  sensorUpdatedAt: "2026-10-02T12:20:00Z",
  situation: "high",
  situationLabel: "น้ำมาก",
  color: "orange",
  dataQuality: "fresh",
  trend: "stable",
  riseRateCmPerHour: null,
};
const data = {
  stations: [station],
  radiusKm: 50,
  checkedAt: "2026-10-02T12:30:05Z",
  updatedAt: "2026-10-02T12:30:00Z",
  source: { status: "fresh" },
  assessment: {
    score: 46,
    level: "watch",
    label: "ควรเฝ้าระวัง",
    confidence: "low",
    reasons: ["น้ำมาก"],
    limitations: ["ยังไม่รวมฝน"],
  },
};

function harness({ geolocation = true } = {}) {
  const elements = new Map(),
    events = new Map(),
    timers = new Map();
  let timerId = 0,
    gpsSuccess,
    gpsError,
    gpsOptions,
    rejectFetch = false;
  const element = () => ({
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    children: [],
    attributes: {},
    style: { setProperty() {} },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    scrollIntoView() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get("radius").value = "50";
  get("manual-location").hidden = true;
  const presets = ["damnoen", "ratchaburi", "maeklong"].map((preset) => ({
    ...element(),
    dataset: { preset },
  }));
  const requests = [];
  const context = {
    document: {
      hidden: false,
      getElementById: get,
      createElement: element,
      querySelectorAll: () => presets,
      addEventListener: (event, callback) => events.set(event, callback),
    },
    navigator: {
      onLine: true,
      ...(geolocation
        ? {
            geolocation: {
              getCurrentPosition(success, error, options) {
                gpsSuccess = success;
                gpsError = error;
                gpsOptions = options;
              },
            },
          }
        : {}),
    },
    window: {
      isSecureContext: true,
      WATER_CONFIG: { apiBase: "" },
      addEventListener: (event, callback) => events.set(event, callback),
    },
    fetch: async (url) => {
      requests.push(url);
      if (rejectFetch) throw new Error("network");
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    },
    setTimeout: (callback) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    URLSearchParams,
    AbortController,
    console,
  };
  vm.runInNewContext(script, context);
  return {
    get,
    presets,
    events,
    requests,
    context,
    timers,
    success: () =>
      gpsSuccess({
        coords: { latitude: 13.518, longitude: 99.954, accuracy: 12 },
      }),
    error: (code) => gpsError({ code }),
    options: () => gpsOptions,
    failFetch: () => {
      rejectFetch = true;
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("GPS success uses high accuracy, reports accuracy, and calls only our normalized API", async () => {
  const h = harness();
  assert.equal(h.options().enableHighAccuracy, true);
  assert.equal(h.options().timeout, 15000);
  h.success();
  await settle();
  assert.equal(h.get("place").textContent, "ตำแหน่ง GPS ปัจจุบัน");
  assert.match(h.get("coords").textContent, /12/);
  assert.match(
    h.requests[0],
    /^\/api\/water\?lat=13.518&lon=99.954&radius=50$/,
  );
  assert.equal(h.get("score").textContent, 46);
  assert.equal(
    h.get("stations").children[0].children[0].children[0].textContent,
    station.name,
  );
  assert.match(h.get("confidence").textContent, /ต่ำ/);
  assert.equal(h.get("rise-rate").textContent, "ยังไม่มีค่าต่อชั่วโมง");
});

test("permission denied, unavailable, timeout, and unsupported GPS expose a clear manual fallback", () => {
  for (const [code, expected] of [
    [1, /ไม่ได้รับอนุญาต/],
    [2, /ไม่สามารถ/],
    [3, /หมดเวลา/],
  ]) {
    const h = harness();
    h.error(code);
    assert.match(h.get("location-status").textContent, expected);
    assert.equal(h.get("manual-location").hidden, false);
    assert.equal(h.requests.length, 0);
  }
  const h = harness({ geolocation: false });
  assert.equal(h.get("manual-location").hidden, false);
  assert.match(h.get("location-status").textContent, /ไม่รองรับ GPS/);
});

test("manual selection wins over a late GPS callback and stays labeled as a reference location", async () => {
  const h = harness();
  h.presets[0].onclick();
  h.success();
  await settle();
  assert.equal(h.get("place").textContent, "จุดอ้างอิงดำเนินสะดวก");
  assert.match(h.get("location-status").textContent, /ไม่ใช่ตำแหน่ง GPS/);
  assert.equal(h.requests.length, 1);
});

test("network failure and offline state suppress a previous score", async () => {
  const h = harness();
  h.success();
  await settle();
  h.failFetch();
  h.get("refresh").onclick();
  await settle();
  assert.equal(h.get("score").textContent, "—");
  assert.match(h.get("data-status").textContent, /เชื่อมต่อข้อมูลไม่สำเร็จ/);
  h.events.get("offline")();
  assert.equal(h.get("score").textContent, "—");
  assert.match(h.get("source-status").textContent, /ออฟไลน์/);
});

test("same sensor response preserves station DOM between dashboard polls", async () => {
  const h = harness();
  h.success();
  await settle();
  const before = h.get("stations").children[0];
  h.get("refresh").onclick();
  await settle();
  assert.equal(h.get("stations").children[0], before);
  h.context.document.hidden = true;
  h.events.get("visibilitychange")();
  assert.equal(h.get("refresh").disabled, false);
});

test("backgrounding while GPS is pending does not discard the location result", async () => {
  const h = harness();
  h.context.document.hidden = true;
  h.events.get("visibilitychange")();
  h.success();
  await settle();
  assert.equal(h.get("place").textContent, "ตำแหน่ง GPS ปัจจุบัน");
  assert.equal(h.requests.length, 0);
  h.context.document.hidden = false;
  h.events.get("visibilitychange")();
  await settle();
  assert.equal(h.requests.length, 1);
});
