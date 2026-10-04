import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const context = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("../assets/areas.js", import.meta.url), "utf8"),
  context,
);
const areas = context.window.WATER_AREAS;

test("public area references have unique IDs, bounded coordinates and station provenance", () => {
  assert.ok(areas.length > 300);
  assert.equal(new Set(areas.map((a) => a.id)).size, areas.length);
  assert.equal(new Set(areas.map((a) => a.province)).size, 73);
  for (const area of areas) {
    assert.ok(area.name && area.province && area.reference && area.ridId);
    assert.ok(Number.isFinite(area.lat) && area.lat >= 5 && area.lat <= 21);
    assert.ok(Number.isFinite(area.lon) && area.lon >= 97 && area.lon <= 106);
  }
  const bang = areas.find((a) => a.id === "bangnokkhwaek");
  assert.equal(bang.lat, 13.500218);
  assert.equal(bang.lon, 99.927311);
  assert.equal(bang.reference, "ปตร.บางนกแขวก");
  assert.equal(bang.province, "สมุทรสงคราม");
});
