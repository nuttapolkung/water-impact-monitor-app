import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const context = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("../assets/station-photos.js", import.meta.url), "utf8"),
  context,
);
const lookup = context.window.WATER_STATION_PHOTO;
const station = {
  source: "RID",
  stationId: "rid:383",
  code: "TMK03/WL_UP",
  lat: 13.500218,
  lon: 99.9273112,
};
test("municipal gate photo matches both sensors but never claims a live or dated camera view", () => {
  const photo = lookup(station);
  assert.equal(new URL(photo.url).host, "bnk.go.th");
  assert.match(photo.caption, /ไม่ใช่ภาพสด.*ไม่ระบุวันที่ถ่าย/);
  assert.match(photo.note, /ไม่ระบุมุม.*กล้องสด.*ยังไม่พบ/);
  assert.equal(lookup({ ...station, code: "TMK03/WL_DOWN" }), photo);
});
test("similar names, wrong provider/ID/code/location and untrusted image URLs cannot substitute a photo", () => {
  for (const changed of [
    { source: "ThaiWater" },
    { stationId: "rid:396" },
    { code: "TK.72" },
    { lat: 13.47 },
    { lon: 100 },
    { lat: null },
  ])
    assert.equal(lookup({ ...station, ...changed }), null);
  assert.equal(
    lookup({ ...station, image: "https://untrusted.example/image.jpg" }).url,
    "https://bnk.go.th/public/list_upload/backend/list_77/pics_121_1.jpg",
  );
});
