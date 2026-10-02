import { number } from "./water.js";
import { waterRoute } from "./water-routes.js";

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
      const rawLevel = number(readings[index]);
      const cross = row.cross_section?.[index];
      // Verified official unit mapping: 0 = MSL (ม.รทก), 1 = station datum (ม.รสม).
      // Without a known datum, do not convert or label a value as MSL.
      if (rawLevel === null || ![0, 1].includes(cross?.unit)) continue;
      // The live feed has returned 32767 metres. Keep the station visible as
      // missing data, rather than turn a physically implausible reading into
      // a critical alert. This broad bound preserves negative and elevated MSL.
      const level = Math.abs(rawLevel) < 10000 ? rawLevel : null;
      const warning = number(cross.warning),
        critical = number(cross.critical);
      const known = warning !== null && critical !== null && critical > warning;
      const situation =
        !known || level === null
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
        gaugeParameter: channel,
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
      s.waterRoute = waterRoute(s);
      if (s.waterRoute.status === "documented") s.river = s.waterRoute.waterway;
      const old = oldById.get(s.id);
      const oldReading =
        cross.unit === 0 ? old?.waterLevelMsl : old?.waterLevelLocal;
      const oldLevel =
        typeof oldReading === "number" && Math.abs(oldReading) < 10000
          ? oldReading
          : null;
      if (
        old &&
        level !== null &&
        sensorUpdatedAt === old.sensorUpdatedAt &&
        oldLevel === level
      ) {
        s.riseRateCmPerHour = old.riseRateCmPerHour ?? null;
        s.previousSensorUpdatedAt = old.previousSensorUpdatedAt ?? null;
        s.previousWaterLevelMsl = old.previousWaterLevelMsl ?? null;
        s.trend = old.trend ?? "unknown";
      } else if (
        level !== null &&
        old?.sensorUpdatedAt &&
        sensorUpdatedAt &&
        oldLevel != null
      ) {
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
