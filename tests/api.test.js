import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";

const station = {
  id: "1",
  name: "สถานี",
  lat: 13.518,
  lon: 99.954,
  waterLevelMsl: 1,
  waterLevelLocal: null,
  previousWaterLevelMsl: null,
  bankGapM: null,
  situation: "normal",
  situationLabel: "น้ำปกติ",
  sensorUpdatedAt: "2026-10-02T12:20:00Z",
  riseRateCmPerHour: null,
};
const cache = {
  get: async () => ({
    stations: [station],
    status: "fresh",
    fetchedAt: "2026-10-02T12:30:00Z",
    lastFailureAt: null,
  }),
};
async function withServer(options, fn) {
  const server = createApp({
    cache,
    now: () => Date.parse("2026-10-02T12:30:00Z"),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("API validates coordinates/radii, returns normalized data and restricts CORS", async () => {
  await withServer({}, async (base) => {
    for (const query of [
      "",
      "?lat=&lon=",
      "?lat=91&lon=100",
      "?lat=13&lon=181",
      "?lat=13&lon=100&radius=999",
    ])
      assert.equal((await fetch(base + "/api/water" + query)).status, 400);
    const r = await fetch(base + "/api/water?lat=13.518&lon=99.954&radius=20", {
      headers: { Origin: "https://water-impact-monitor.onrender.com" },
    });
    assert.equal(r.status, 200);
    assert.equal(
      r.headers.get("access-control-allow-origin"),
      "https://water-impact-monitor.onrender.com",
    );
    const result = await r.json();
    assert.equal(result.stations.length, 1);
    assert.equal(result.assessment.confidence, "low");
    assert.equal(result.source.status, "fresh");
    const foreign = await fetch(base + "/api/water?lat=13&lon=100", {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(base + "/server.js")).status, 404);
    assert.equal((await fetch(base + "/.cache/water.json")).status, 404);
    assert.equal((await fetch(base + "/healthz")).status, 200);
  });
});

test("unavailable source returns a structured 503 with no invented stations or score", async () => {
  await withServer(
    {
      cache: {
        get: async () => ({
          status: "unavailable",
          stations: [],
          fetchedAt: null,
        }),
      },
    },
    async (base) => {
      const r = await fetch(base + "/api/water?lat=13&lon=100");
      assert.equal(r.status, 503);
      const result = await r.json();
      assert.equal(result.assessment.score, null);
      assert.deepEqual(result.stations, []);
    },
  );
});

test("API rate limiting does not block health checks", async () => {
  await withServer({ rateLimit: 1 }, async (base) => {
    assert.equal((await fetch(base + "/api/water?lat=13&lon=100")).status, 200);
    const r = await fetch(base + "/api/water?lat=13&lon=100");
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "60");
    assert.equal((await fetch(base + "/healthz")).status, 200);
  });
});
