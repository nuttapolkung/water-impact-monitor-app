import test from "node:test";
import assert from "node:assert/strict";
import { waterRoute } from "../assets/water-routes.js";

test("station routes use checked station codes and coordinates, never basin or proximity alone", () => {
  const station = {
    code: "TK.72",
    lat: 13.4913,
    lon: 99.9445,
    basin: "แม่กลอง",
  };
  const route = waterRoute(station);
  assert.equal(route.status, "documented");
  assert.equal(route.waterway, "แม่น้ำแม่กลอง");
  assert.match(route.origin, /แควใหญ่.*แควน้อย/);
  assert.ok(route.sources.every((s) => s.url.startsWith("https://")));
  assert.equal(
    waterRoute({ ...station, code: "UNVERIFIED" }).status,
    "unknown",
  );
  assert.equal(waterRoute({ ...station, lat: 15 }).status, "unknown");
  assert.equal(
    waterRoute({ code: "TK.74", lat: 13.482, lon: 100.044, basin: "แม่กลอง" })
      .status,
    "unknown",
  );
  assert.equal(
    waterRoute({ ...station, code: "", river: "แม่น้ำแม่กลอง" }).status,
    "documented",
  );
});

test("gate channels show connected waterways without claiming a measured direction or nearest-station link", () => {
  for (const code of ["TMK03/WL_UP", "TMK03/WL_DOWN"]) {
    const route = waterRoute({ code, lat: 13.500218, lon: 99.9273112 });
    assert.equal(route.connector, "↔");
    assert.equal(route.kind, "connection");
    assert.match(route.origin, /แม่กลอง.*ท่าจีน/);
    assert.match(route.note, /ไม่ยืนยัน.*ไหล/);
  }
  const unknown = waterRoute({
    code: "OTHER",
    basin: "แม่กลอง",
    lat: 13.5,
    lon: 99.927,
  });
  assert.equal(unknown.nodes.length, 0);
  assert.match(unknown.origin, /ยังยืนยัน.*ไม่ได้/);
  assert.match(unknown.note, /ใกล้กัน.*ไม่ได้ยืนยัน/);
});
