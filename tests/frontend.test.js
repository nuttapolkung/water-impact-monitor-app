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

function harness({ geolocation = true, responseData = data } = {}) {
  const elements = new Map(),
    events = new Map(),
    timers = new Map();
  let timerId = 0,
    gpsSuccess,
    gpsError,
    gpsOptions,
    rejectFetch = false,
    nextData = responseData;
  const element = () => ({
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    children: [],
    attributes: {},
    style: {
      setProperty(key, value) {
        this[key] = value;
      },
    },
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
      createElement: (tag) => ({ ...element(), tagName: tag }),
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
      return {
        ok: true,
        status: 200,
        json: async () => structuredClone(nextData),
      };
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
    respond: (value) => {
      nextData = value;
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

const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const byClass = (node, className) =>
  descendants(node).find((n) => n.className?.split(" ").includes(className));
const ridData = (changes = {}, sourceStatus = "fresh") => ({
  ...data,
  stations: [
    {
      ...station,
      source: "RID",
      name: "ปตร.บางนกแขวก · ท้ายน้ำ",
      code: "TMK03/WL_DOWN",
      bankGapM: null,
      thresholdDatum: "msl",
      warningLevel: 2.5,
      criticalLevel: 2.8,
      ...changes,
    },
  ],
  source: { name: "RID · เบราว์เซอร์", status: sourceStatus, fallback: true },
});

test("station cards compare actual water levels with matching warning/critical thresholds in centimeters", async () => {
  for (const [level, situation, warning, critical, expected] of [
    [2.18, "critical", 1.2, 1.5, "สูงกว่าเกณฑ์วิกฤติ 68 ซม."],
    [2.26, "normal", 2.5, 2.8, "ยังต่ำกว่าเกณฑ์เฝ้าระวัง 24 ซม."],
    [2.63, "high", 2.5, 2.8, "สูงกว่าเกณฑ์เฝ้าระวัง 13 ซม."],
    [2.8, "critical", 2.5, 2.8, "ระดับน้ำถึงเกณฑ์วิกฤติ"],
    [-0.2, "normal", -0.1, 0.1, "ยังต่ำกว่าเกณฑ์เฝ้าระวัง 10 ซม."],
  ]) {
    const h = harness({
      responseData: ridData({
        waterLevelMsl: level,
        situation,
        warningLevel: warning,
        criticalLevel: critical,
      }),
    });
    h.success();
    await settle();
    const card = h.get("stations").children[0];
    assert.equal(byClass(card, "station-difference").textContent, expected);
    assert.equal(card.children[0].children[0].textContent, "ปตร.บางนกแขวก");
    assert.equal(byClass(card, "station-point").textContent, "ด้านท้ายน้ำ");
    const scale = byClass(card, "station-scale");
    assert.match(scale.attributes["aria-label"], /ในระดับอ้างอิงเดียวกัน/);
    for (const key of ["--level-at", "--watch-at", "--critical-at"]) {
      const position = parseFloat(scale.style[key]);
      assert.ok(position >= 0 && position <= 100);
    }
  }
});

test("station comparisons never mix a local datum with MSL or render missing/stale data as a current warning", async () => {
  const local = harness({
    responseData: ridData({
      waterLevelMsl: null,
      waterLevelLocal: 2.63,
      thresholdDatum: "local",
      situation: "high",
    }),
  });
  local.success();
  await settle();
  const card = local.get("stations").children[0];
  assert.match(byClass(card, "station-datum").textContent, /เฉพาะสถานี/);
  assert.equal(
    byClass(card, "station-difference").textContent,
    "สูงกว่าเกณฑ์เฝ้าระวัง 13 ซม.",
  );
  for (const responseData of [
    ridData({ thresholdDatum: "local", waterLevelLocal: null }),
    ridData({ warningLevel: null, criticalLevel: null, situation: "unknown" }),
    ridData({ dataQuality: "stale", situation: "critical" }),
    ridData({ situation: "critical" }, "stale"),
  ]) {
    const h = harness({ responseData });
    h.success();
    await settle();
    const card = h.get("stations").children[0];
    assert.equal(byClass(card, "station-scale"), undefined);
    assert.doesNotMatch(
      byClass(card, "station-difference").textContent,
      /สูงกว่า/,
    );
    if (
      responseData.source.status === "stale" ||
      responseData.stations[0].dataQuality === "stale"
    )
      assert.match(byClass(card, "station-status").className, /gray/);
  }
});

test("station details stay open while polling updates age and measurements; technical source messages stay in details", async () => {
  const first = ridData({ waterLevelMsl: 2.63, situation: "high" });
  first.source.message =
    "เส้นทางบริการไม่พร้อม ใช้ข้อมูล RID ผ่านเบราว์เซอร์ (ไม่ส่งพิกัด)";
  const h = harness({ responseData: first });
  h.success();
  await settle();
  const original = h.get("stations").children[0],
    details = byClass(original, "station-details");
  details.open = true;
  byClass(original, "station-route-details").open = true;
  assert.equal(
    byClass(original, "station-time").textContent,
    "สถานีรายงานล่าสุด 10 นาทีที่แล้ว",
  );
  assert.doesNotMatch(h.get("data-status").textContent, /เส้นทาง|เบราว์เซอร์/);
  assert.match(h.get("source-detail").textContent, /ไม่ส่งพิกัด/);
  h.respond({ ...first, checkedAt: "2026-10-02T12:32:05Z" });
  h.get("refresh").onclick();
  await settle();
  assert.equal(h.get("stations").children[0], original);
  assert.equal(details.open, true);
  assert.equal(
    byClass(original, "station-time").textContent,
    "สถานีรายงานล่าสุด 12 นาทีที่แล้ว",
  );
  h.respond(ridData({ waterLevelMsl: 2.64, situation: "high" }));
  h.get("refresh").onclick();
  await settle();
  assert.equal(
    byClass(h.get("stations").children[0], "station-details").open,
    true,
  );
  assert.equal(
    byClass(h.get("stations").children[0], "station-route-details").open,
    true,
  );
});

test("history cards expose all four periods and clearly explain unavailable data and unknown water origin", async () => {
  const h = harness({ responseData: ridData() });
  h.success();
  await settle();
  const card = h.get("stations").children[0],
    grid = byClass(card, "history-grid");
  assert.deepEqual(
    grid.children.map((c) => c.children[0].textContent),
    ["1 ชม.", "3 ชม.", "6 ชม.", "24 ชม."],
  );
  assert.ok(grid.children.every((c) => c.children[1].textContent === "—"));
  assert.match(byClass(card, "history-caption").textContent, /โหลดค่าจริง/);
  assert.match(
    byClass(card, "station-route-details").children[2].children[1].textContent,
    /ยังยืนยัน.*ไม่ได้/,
  );
});
