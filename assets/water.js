import { waterRoute } from "./water-routes.js";

export const SOURCE_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load";
export const SENSOR_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export function number(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    String(value).trim() === ""
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  const s =
    typeof value === "object" && value !== null ? value.th || value.en : value;
  return typeof s === "string" ? s.trim().slice(0, 200) : "";
}

export function sensorTime(value) {
  if (typeof value !== "string") return null;
  // ThaiWater's unzoned station timestamps are Thailand local time, never server local time.
  const s = value.trim().replace(" ", "T");
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)
    ? s + "+07:00"
    : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function distanceKm(lat, lon, otherLat, otherLon) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((otherLat - lat) * rad) / 2) ** 2 +
    Math.cos(lat * rad) *
      Math.cos(otherLat * rad) *
      Math.sin(((otherLon - lon) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

// Verified against the response's scale.data.scale on 2026-10-02.
// 1 and 2 are LOW water, 3 is normal, 4 high water, 5 overflow.
const SITUATIONS = {
  1: ["critical_low", "น้ำน้อยวิกฤติ", "yellow"],
  2: ["low", "น้ำน้อย", "yellow"],
  3: ["normal", "น้ำปกติ", "green"],
  4: ["high", "น้ำมาก", "orange"],
  5: ["overflow", "น้ำล้นตลิ่ง", "red"],
};

export function normalizeWater(payload, previous = []) {
  if (
    payload?.waterlevel_data?.result !== "OK" ||
    !Array.isArray(payload.waterlevel_data.data) ||
    !payload.waterlevel_data.data.length
  ) {
    throw new Error("UPSTREAM_SCHEMA_INVALID");
  }
  const oldById = new Map(previous.map((s) => [s.id, s]));
  const stations = new Map();
  for (const row of payload.waterlevel_data.data) {
    if (!row || typeof row !== "object") continue;
    const meta = row.station || {};
    const lat = number(meta.tele_station_lat),
      lon = number(meta.tele_station_long);
    const id = meta.id ?? meta.tele_station_oldcode;
    if (
      id == null ||
      lat == null ||
      lon == null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180 ||
      (lat === 0 && lon === 0)
    )
      continue;
    const situationLevel = number(row.situation_level);
    const [situation, situationLabel, color] = SITUATIONS[situationLevel] || [
      "unknown",
      "ไม่ทราบสถานะ",
      "gray",
    ];
    const waterLevelMsl = number(row.waterlevel_msl);
    const waterLevelLocal = number(row.waterlevel_m);
    const sensorUpdatedAt = sensorTime(row.waterlevel_datetime);
    const s = {
      id: String(id),
      code: text(meta.tele_station_oldcode),
      name: text(meta.tele_station_name) || "สถานีไม่ระบุชื่อ",
      lat,
      lon,
      waterLevelMsl,
      waterLevelLocal,
      previousWaterLevelMsl: number(row.waterlevel_msl_previous),
      sensorUpdatedAt,
      previousSensorUpdatedAt: null,
      riseRateCmPerHour: null,
      situationLevel: SITUATIONS[situationLevel] ? situationLevel : null,
      situation,
      situationLabel,
      color,
      bankLevelMsl: number(meta.min_bank),
      river: text(row.river_name),
      basin: text(row.basin?.basin_name),
      province: text(row.geocode?.province_name),
      agency: text(row.agency?.agency_name),
      source: "ThaiWater",
      historyStationType: text(meta.tele_station_type),
      sourceUrl: "https://www.thaiwater.net/",
    };
    s.waterRoute = waterRoute(s);
    s.bankGapM =
      waterLevelMsl !== null && s.bankLevelMsl !== null
        ? Math.round((s.bankLevelMsl - waterLevelMsl) * 1000) / 1000
        : null;
    const old = oldById.get(s.id);
    if (
      old &&
      sensorUpdatedAt === old.sensorUpdatedAt &&
      waterLevelMsl === old.waterLevelMsl
    ) {
      s.riseRateCmPerHour = old.riseRateCmPerHour ?? null;
      s.previousSensorUpdatedAt = old.previousSensorUpdatedAt ?? null;
    } else if (
      old?.sensorUpdatedAt &&
      sensorUpdatedAt &&
      old.waterLevelMsl !== null &&
      waterLevelMsl !== null
    ) {
      const hours =
        (Date.parse(sensorUpdatedAt) - Date.parse(old.sensorUpdatedAt)) /
        3600000;
      if (hours >= 1 / 60 && hours <= 6) {
        s.riseRateCmPerHour =
          Math.round(
            (((waterLevelMsl - old.waterLevelMsl) * 100) / hours) * 10,
          ) / 10;
        s.previousSensorUpdatedAt = old.sensorUpdatedAt;
      }
    }
    const delta =
      waterLevelMsl !== null && s.previousWaterLevelMsl !== null
        ? waterLevelMsl - s.previousWaterLevelMsl
        : null;
    s.trend =
      delta === null
        ? "unknown"
        : delta > 0.005
          ? "rising"
          : delta < -0.005
            ? "falling"
            : "stable";
    // Multiple records for a station must not duplicate map markers or prefer an older reading.
    const existing = stations.get(s.id);
    if (
      !existing ||
      (Date.parse(s.sensorUpdatedAt) || 0) >
        (Date.parse(existing.sensorUpdatedAt) || 0)
    )
      stations.set(s.id, s);
  }
  if (!stations.size) throw new Error("UPSTREAM_SCHEMA_INVALID");
  return [...stations.values()];
}

export function nearbyStations(stations, location, radius, now = Date.now()) {
  return stations
    .map((s) => {
      const age = s.sensorUpdatedAt
        ? now - Date.parse(s.sensorUpdatedAt)
        : Infinity;
      return {
        ...s,
        distanceKm:
          Math.round(
            distanceKm(location.lat, location.lon, s.lat, s.lon) * 100,
          ) / 100,
        dataQuality:
          s.waterLevelMsl === null && s.waterLevelLocal === null
            ? "missing"
            : !Number.isFinite(age) || age < -300000
              ? "unknown"
              : s.sourceStatus === "stale" || age > SENSOR_MAX_AGE_MS
                ? "stale"
                : "fresh",
      };
    })
    .filter((s) => s.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function assess(stations, sourceStatus) {
  const limitations = [
    "ยังไม่มีระดับความสูงของตำแหน่งคุณ แนวคันกั้นน้ำ และเส้นทางน้ำที่เชื่อมกับตำแหน่งนี้",
    "คะแนนยังไม่รวมฝน น้ำทะเลหนุน การระบายน้ำ และระดับน้ำท่วมในอดีต",
    "ระยะทางเป็นเส้นตรง ไม่ได้ยืนยันว่าสถานีอยู่ต้นน้ำหรือปลายน้ำของคุณ",
  ];
  const valid = stations.filter(
    (s) =>
      s.dataQuality === "fresh" &&
      (s.waterLevelMsl !== null ||
        (s.waterLevelLocal !== null &&
          s.thresholdDatum === "local" &&
          s.warningLevel != null &&
          s.criticalLevel != null)) &&
      s.situation !== "unknown",
  );
  if (sourceStatus !== "fresh" || !valid.length)
    return {
      score: null,
      level: "unknown",
      label: "ข้อมูลยังไม่เพียงพอสำหรับประเมิน",
      confidence: "insufficient",
      reasons: [
        sourceStatus === "unavailable"
          ? "ยังไม่มีข้อมูลต้นทางสำหรับประเมิน กรุณาตรวจอีกครั้งเมื่อแหล่งข้อมูลพร้อม"
          : sourceStatus !== "fresh"
            ? "ข้อมูลต้นทางไม่พร้อมใช้งาน ใช้ค่าล่าสุดที่เก็บไว้เพื่อดูประกอบเท่านั้น"
            : "ไม่พบสถานีที่มีข้อมูลล่าสุดและสถานะครบในรัศมีนี้",
      ],
      limitations,
    };
  let score = 0;
  const evidence = [];
  for (const s of valid) {
    let signal = ["overflow", "critical"].includes(s.situation)
      ? 90
      : s.situation === "high"
        ? 50
        : 12;
    if (s.bankGapM !== null)
      signal = Math.max(
        signal,
        s.bankGapM <= 0 ? 90 : s.bankGapM <= 0.3 ? 65 : signal,
      );
    if (s.riseRateCmPerHour !== null && s.riseRateCmPerHour >= 5)
      signal = Math.min(100, signal + 10);
    const weighted = Math.round(signal * Math.max(0.5, 1 - s.distanceKm / 200));
    score = Math.max(score, weighted);
    if (signal >= 50)
      evidence.push({
        weight: weighted,
        distance: s.distanceKm,
        text: `${s.name}: ${s.situationLabel} ห่าง ${s.distanceKm.toFixed(1)} กม.${s.bankGapM !== null ? ` • ${s.bankGapM > 0 ? "ต่ำกว่าตลิ่ง" : "ถึงหรือเกินตลิ่ง"} ${Math.abs(s.bankGapM).toFixed(2)} ม.` : ""}${s.riseRateCmPerHour !== null && s.riseRateCmPerHour >= 5 ? ` • น้ำเพิ่ม ${s.riseRateCmPerHour.toFixed(1)} ซม./ชม. จากเวลาที่ตรวจวัดสองครั้ง` : ""}`,
      });
  }
  // Always explain the station responsible for the gauge, even beyond the first six nearest stations.
  const reasons = evidence
    .sort((a, b) => b.weight - a.weight || a.distance - b.distance)
    .slice(0, 5)
    .map((e) => e.text);
  if (!reasons.length)
    reasons.push(
      `สถานีข้อมูลล่าสุด ${valid.length} แห่งยังไม่แสดงภาวะน้ำมากหรือล้นตลิ่ง`,
    );
  const incomplete = stations.length - valid.length;
  if (incomplete)
    reasons.push(
      `${incomplete} สถานีมีข้อมูลเก่าหรือไม่ครบ จึงไม่ใช้คำนวณคะแนน`,
    );
  return {
    score,
    level:
      score >= 75
        ? "high"
        : score >= 50
          ? "elevated"
          : score >= 25
            ? "watch"
            : "low",
    label:
      score >= 75
        ? "พบสัญญาณน้ำสูง ควรติดตามคำเตือน"
        : score >= 50
          ? "สถานีรอบพื้นที่มีน้ำสูง ควรเฝ้าระวัง"
          : score >= 25
            ? "ตำแหน่งนี้ควรเฝ้าระวัง"
            : "จากข้อมูลที่มี ยังไม่พบสัญญาณเสี่ยงสูง",
    confidence: "low",
    reasons: reasons.slice(0, 6),
    limitations,
  };
}
