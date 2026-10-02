import WebSocket from "ws";
import { number } from "./water.js";

export const RID_URL = "wss://telerid.rid.go.th/ws/public/";

// The official dashboard consumes this public INIT snapshot. One bounded connection
// retrieves it for the shared cache; browsers never open per-user upstream sockets.
export function fetchRidSnapshot({
  timeoutMs = 30000,
  logger = console,
  Socket = WebSocket,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(RID_URL, {
      handshakeTimeout: timeoutMs,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    let settled = false,
      opened = false;
    const startedAt = Date.now();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.terminate) socket.terminate();
      else socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            opened ? "UPSTREAM_SNAPSHOT_TIMEOUT" : "UPSTREAM_CONNECT_TIMEOUT",
          ),
        ),
      timeoutMs,
    );
    socket.on?.("unexpected-response", (_request, response) => {
      const error = new Error(`UPSTREAM_HTTP_${response.statusCode}`);
      error.status = response.statusCode;
      error.retryAfter = response.headers["retry-after"];
      response.destroy();
      finish(error);
    });
    socket.addEventListener("open", () => {
      opened = true;
      logger.info(
        JSON.stringify({
          event: "rid_connection_open",
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
    socket.addEventListener("error", (event) => {
      if (settled) return;
      logger.warn(
        JSON.stringify({
          event: "rid_connection_error",
          elapsedMs: Date.now() - startedAt,
          message: String(event.message || event.error?.message || "").slice(
            0,
            200,
          ),
        }),
      );
      const cause = event.error?.cause?.code || event.error?.code;
      const code =
        typeof cause === "string" && /^[A-Z_0-9]+$/.test(cause)
          ? cause
          : "REQUEST_FAILED";
      finish(new Error(`UPSTREAM_${code}`));
    });
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("UPSTREAM_CLOSED"));
    });
    socket.addEventListener("message", (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > 8 * 1024 * 1024
        )
          throw new Error("UPSTREAM_TOO_LARGE");
        const envelope = JSON.parse(event.data);
        const payload =
          typeof envelope.message === "string"
            ? JSON.parse(envelope.message)
            : null;
        if (payload?.type === "INIT") finish(null, payload);
      } catch {
        finish(new Error("UPSTREAM_SCHEMA_INVALID"));
      }
    });
  });
}

const clean = (s) => (typeof s === "string" ? s.trim().slice(0, 200) : "");
const timestamp = (value) => {
  const seconds = number(value);
  if (seconds === null || seconds <= 0 || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toISOString();
};

export function normalizeRid(payload, previous = []) {
  if (
    payload?.type !== "INIT" ||
    !payload.data ||
    Array.isArray(payload.data) ||
    typeof payload.data !== "object"
  )
    throw new Error("UPSTREAM_SCHEMA_INVALID");
  const oldById = new Map(previous.map((s) => [s.id, s]));
  const stations = [];
  for (const [id, row] of Object.entries(payload.data)) {
    if (!row?.measure?.wl || row.is_display === false) continue;
    const lat = number(row.location?.y),
      lon = number(row.location?.x);
    if (
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0)
    )
      continue;
    const list = row.values?.water_level_value_list;
    const readings = Array.isArray(list?.value)
      ? list.value
      : [row.values?.water_level?.value];
    for (let index = 0; index < readings.length; index++) {
      const level = number(readings[index]);
      const cross = row.cross_section?.[index];
      // Verified official unit mapping: 0 = MSL (ม.รทก), 1 = station datum (ม.รสม).
      // Without a known datum, do not convert or label a value as MSL.
      if (level === null || ![0, 1].includes(cross?.unit)) continue;
      const warning = number(cross.warning),
        critical = number(cross.critical);
      const known = warning !== null && critical !== null && critical > warning;
      const situation = !known
        ? "unknown"
        : level >= critical
          ? "critical"
          : level >= warning
            ? "high"
            : "normal";
      const channel = clean(cross.parameter);
      const channelLabel =
        channel === "WL_UP"
          ? "เหนือน้ำ"
          : channel === "WL_DOWN"
            ? "ท้ายน้ำ"
            : `จุด ${index + 1}`;
      const multi = readings.filter((v) => number(v) !== null).length > 1;
      const sensorUpdatedAt = timestamp(
        list?.unixtime ?? row.values?.water_level?.unixtime,
      );
      const s = {
        id: `rid:${id}:${index}`,
        stationId: `rid:${id}`,
        code: clean(row.code) + (multi ? `/${channel || index + 1}` : ""),
        name:
          (clean(row.name) || clean(row.code) || "สถานีไม่ระบุชื่อ") +
          (multi ? ` · ${channelLabel}` : ""),
        lat,
        lon,
        waterLevelMsl: cross.unit === 0 ? level : null,
        waterLevelLocal: cross.unit === 1 ? level : null,
        previousWaterLevelMsl: null,
        sensorUpdatedAt,
        previousSensorUpdatedAt: null,
        riseRateCmPerHour: null,
        trend: "unknown",
        situationLevel: null,
        situation,
        situationLabel: {
          unknown: "ไม่ทราบเกณฑ์",
          critical: "ถึงเกณฑ์วิกฤติ RID",
          high: "ถึงเกณฑ์เฝ้าระวัง RID",
          normal: "ต่ำกว่าเกณฑ์เฝ้าระวัง RID",
        }[situation],
        color: {
          unknown: "gray",
          critical: "red",
          high: "orange",
          normal: "green",
        }[situation],
        bankLevelMsl: null,
        bankGapM: null,
        warningLevel: known ? warning : null,
        criticalLevel: known ? critical : null,
        thresholdDatum: cross.unit === 0 ? "msl" : "local",
        river: "",
        basin: clean(row.basin?.name),
        province: clean(row.province),
        agency: "กรมชลประทาน",
        source: "RID",
        sourceUrl: "https://telerid.rid.go.th/",
      };
      const old = oldById.get(s.id);
      const oldLevel =
        cross.unit === 0 ? old?.waterLevelMsl : old?.waterLevelLocal;
      if (
        old &&
        sensorUpdatedAt === old.sensorUpdatedAt &&
        oldLevel === level
      ) {
        s.riseRateCmPerHour = old.riseRateCmPerHour ?? null;
        s.previousSensorUpdatedAt = old.previousSensorUpdatedAt ?? null;
        s.previousWaterLevelMsl = old.previousWaterLevelMsl ?? null;
        s.trend = old.trend ?? "unknown";
      } else if (old?.sensorUpdatedAt && sensorUpdatedAt && oldLevel != null) {
        const hours =
          (Date.parse(sensorUpdatedAt) - Date.parse(old.sensorUpdatedAt)) /
          3600000;
        if (hours >= 1 / 60 && hours <= 6) {
          s.riseRateCmPerHour =
            Math.round((((level - oldLevel) * 100) / hours) * 10) / 10;
          s.previousSensorUpdatedAt = old.sensorUpdatedAt;
          s.previousWaterLevelMsl = cross.unit === 0 ? oldLevel : null;
          s.trend =
            level - oldLevel > 0.005
              ? "rising"
              : level - oldLevel < -0.005
                ? "falling"
                : "stable";
        }
      }
      stations.push(s);
    }
  }
  if (!stations.length) throw new Error("UPSTREAM_SCHEMA_INVALID");
  return stations;
}
