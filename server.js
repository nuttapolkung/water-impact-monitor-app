import { createServer } from "node:http";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWaterCache } from "./src/cache.js";
import { nearbyStations, assess, number, SOURCE_URL } from "./src/water.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ORIGINS = [
  "https://water-impact-monitor.onrender.com",
  "https://water-impact-monitor-app.onrender.com",
];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export function createApp({
  cache = createWaterCache(),
  rateLimit = 90,
  origins = DEFAULT_ORIGINS,
  now = Date.now,
  version = process.env.RENDER_GIT_COMMIT || "local",
  trustRenderProxy = Boolean(process.env.RENDER),
} = {}) {
  const clients = new Map();
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(self), camera=(), microphone=()",
    );
    const origin = req.headers.origin;
    if (
      origin &&
      (origins.includes(origin) ||
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    }
    const json = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      if (url.pathname === "/healthz") {
        json(200, { status: "ok", version });
        return;
      }
      if (url.pathname === "/api/water") {
        if (req.method !== "GET") {
          json(405, { error: "METHOD_NOT_ALLOWED" });
          return;
        }
        // Trust edge client headers only on Render, never on direct local requests.
        // Prefer its CDN's client address; Render documents the first XFF address as the client.
        const forwarded = trustRenderProxy
          ? req.headers["true-client-ip"] ||
            req.headers["cf-connecting-ip"] ||
            req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
          : null;
        const ip =
          typeof forwarded === "string" && isIP(forwarded)
            ? forwarded
            : req.socket.remoteAddress;
        const timestamp = now();
        if (clients.size > 5000)
          for (const [key, value] of clients)
            if (timestamp - value.start >= 60000) clients.delete(key);
        const bucket = clients.get(ip);
        const current =
          bucket && timestamp - bucket.start < 60000
            ? bucket
            : { start: timestamp, count: 0 };
        if (clients.size >= 10000 && !clients.has(ip)) {
          json(503, { error: "BUSY" });
          return;
        }
        clients.set(ip, current);
        if (++current.count > rateLimit) {
          res.setHeader("Retry-After", "60");
          json(429, {
            error: "RATE_LIMITED",
            message: "กรุณารอสักครู่ก่อนตรวจข้อมูลอีกครั้ง",
          });
          return;
        }
        const lat = number(url.searchParams.get("lat")),
          lon = number(url.searchParams.get("lon"));
        const radius = url.searchParams.has("radius")
          ? number(url.searchParams.get("radius"))
          : 50;
        if (
          lat === null ||
          lon === null ||
          lat < -90 ||
          lat > 90 ||
          lon < -180 ||
          lon > 180 ||
          ![20, 50, 100].includes(radius)
        ) {
          json(400, {
            error: "INVALID_LOCATION",
            message:
              "ระบุ lat (-90 ถึง 90), lon (-180 ถึง 180) และ radius 20, 50 หรือ 100 กม.",
          });
          return;
        }
        const data = await cache.get();
        const location = { lat, lon };
        const stations = nearbyStations(data.stations, location, radius, now());
        const checkedAt = new Date(now()).toISOString();
        json(data.status === "unavailable" ? 503 : 200, {
          version,
          updatedAt: data.fetchedAt,
          checkedAt,
          location,
          radiusKm: radius,
          stations,
          source: {
            name: "ThaiWater",
            url: SOURCE_URL,
            status: data.status,
            fetchedAt: data.fetchedAt,
            lastFailureAt: data.lastFailureAt,
            nextRefreshAt: data.nextRefreshAt,
            cacheSeconds: 60,
            message:
              data.status === "fresh"
                ? "เชื่อมต่อข้อมูลต้นทางได้"
                : "ข้อมูลต้นทางชั่วคราวไม่พร้อมใช้งาน",
          },
          assessment: assess(stations, data.status),
          context: {
            elevation: { status: "unavailable" },
            tide: {
              status: "unavailable",
              sourceUrl: "https://hydro.navy.mi.th/waterlaveltable",
            },
            rainfall: {
              status: "unavailable",
              sourceUrl: "https://www.thaiwater.net/",
            },
          },
        });
        return;
      }
      const path =
        url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      // Never serve source, cache, dotfiles, or handoff documents from the Node service.
      if (
        path !== "/index.html" &&
        !/^\/assets\/[a-zA-Z0-9_./-]+$/.test(path)
      ) {
        json(404, { error: "NOT_FOUND" });
        return;
      }
      const file = resolve(ROOT, "." + path);
      if (
        !file.startsWith(resolve(ROOT, "assets") + "/") &&
        file !== resolve(ROOT, "index.html")
      ) {
        json(404, { error: "NOT_FOUND" });
        return;
      }
      const content = await readFile(file).catch(() => null);
      if (content === null) {
        json(404, { error: "NOT_FOUND" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Cache-Control": "public, max-age=300",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      json(500, {
        error: "INTERNAL_ERROR",
        message: "ไม่สามารถตรวจข้อมูลได้ในขณะนี้",
      });
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const cache = createWaterCache();
  const app = createApp({ cache });
  app.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
    console.info(
      JSON.stringify({
        event: "server_started",
        port: Number(process.env.PORT) || 3000,
      }),
    ),
  );
  // Warm the national cache without sending a user's location to the upstream provider.
  cache.get().catch(() => {});
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => app.close(() => process.exit(0)));
}
