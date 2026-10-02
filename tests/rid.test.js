import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRid, fetchRidSnapshot } from "../src/rid.js";
import { nearbyStations, assess } from "../src/water.js";

const time = Date.parse("2026-10-02T13:15:00Z");
const payload = () => ({
  type: "INIT",
  data: {
    383: {
      name: "ปตร.บางนกแขวก",
      code: "TMK03",
      measure: { wl: true },
      is_display: true,
      location: { x: 99.9273112, y: 13.500218 },
      basin: { name: "แม่กลอง" },
      province: "สมุทรสงคราม",
      cross_section: [
        { parameter: "WL_UP", unit: 0, warning: 2.5, critical: 2.8 },
        { parameter: "WL_DOWN", unit: 0, warning: 2.5, critical: 2.8 },
      ],
      values: {
        water_level_value_list: {
          value: ["2.27", "2.9", "-"],
          unixtime: time / 1000,
        },
      },
    },
  },
});

test("RID preserves each sensor, UTC timestamp and actual warning/critical thresholds without inventing a bank", () => {
  const stations = normalizeRid(payload());
  assert.equal(stations.length, 2);
  assert.equal(stations[0].sensorUpdatedAt, "2026-10-02T13:15:00.000Z");
  assert.equal(stations[0].waterLevelMsl, 2.27);
  assert.equal(stations[0].situation, "normal");
  assert.equal(stations[1].situation, "critical");
  assert.match(stations[1].name, /ท้ายน้ำ/);
  assert.equal(stations[1].bankGapM, null);
  assert.equal(stations[1].criticalLevel, 2.8);
  const nearby = nearbyStations(
    stations,
    { lat: 13.518, lon: 99.954 },
    50,
    time,
  );
  const a = assess(nearby, "fresh");
  assert.ok(a.score >= 75);
  assert.match(a.reasons[0], /ท้ายน้ำ.*เกณฑ์วิกฤติ RID/);
  assert.doesNotMatch(a.reasons[0], /ล้นตลิ่ง/);
});

test("RID station datum never becomes MSL; unknown datum and absent thresholds do not create reassuring status", () => {
  const p = payload();
  p.data[383].cross_section[0] = { unit: 1, warning: 2.5, critical: 2.8 };
  p.data[383].cross_section[1] = { unit: 0, warning: null, critical: null };
  const s = normalizeRid(p);
  assert.equal(s[0].waterLevelMsl, null);
  assert.equal(s[0].waterLevelLocal, 2.27);
  assert.equal(s[1].situation, "unknown");
  p.data[383].cross_section[0].unit = 8;
  assert.equal(normalizeRid(p).length, 1);
  p.data[383].location.x = 200;
  assert.throws(() => normalizeRid(p), /UPSTREAM_SCHEMA_INVALID/);
});

test("RID rise rate uses distinct readings of the same sensor and retains it on repeated snapshots", () => {
  const p = payload(),
    old = normalizeRid(p);
  p.data[383].values.water_level_value_list.unixtime += 900;
  p.data[383].values.water_level_value_list.value[0] = "2.29";
  const current = normalizeRid(p, old);
  assert.equal(current[0].riseRateCmPerHour, 8);
  assert.equal(current[0].trend, "rising");
  assert.equal(normalizeRid(p, current)[0].riseRateCmPerHour, 8);
});

test("RID snapshot connection closes after INIT or timeout and rejects invalid data", async () => {
  let socket;
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      socket = this;
    }
    close() {
      this.closed = true;
    }
    message(data) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  const request = fetchRidSnapshot({ Socket: FakeSocket, timeoutMs: 100 });
  socket.message(JSON.stringify({ message: JSON.stringify(payload()) }));
  assert.equal((await request).type, "INIT");
  assert.equal(socket.closed, true);
  const invalid = fetchRidSnapshot({ Socket: FakeSocket, timeoutMs: 100 });
  socket.message("not JSON");
  await assert.rejects(invalid, /SCHEMA_INVALID/);
  assert.equal(socket.closed, true);
  await assert.rejects(
    fetchRidSnapshot({ Socket: FakeSocket, timeoutMs: 5 }),
    /TIMEOUT/,
  );
  assert.equal(socket.closed, true);
});
