import {
  compareHistory,
  historyReference,
} from "./history.js?v=20261004-forecast";

export const FORECAST_HOURS = [1, 3, 6];
const HOUR = 3600000;

// A conditional extrapolation of measured stage, not a discharge/routing model.
// No confidence interval is claimed without a calibrated error distribution.
export function forecastWaterLevel(
  station,
  history,
  { now = Date.now(), sourceStatus = "fresh" } = {},
) {
  const unavailable = (reason) => ({
    status: "unavailable",
    reason,
    projections: [],
  });
  if (!station || !history) return unavailable("missing_history");
  if (!Number.isFinite(now) || station.sourceStatus === "stale")
    return unavailable("stale");
  const comparison = compareHistory(station, history, { now, sourceStatus });
  if (comparison.status !== "ready") return unavailable(comparison.status);
  const recent = comparison.comparisons.find(
    (c) => c.hours === 1 && c.status === "available",
  );
  if (!recent) return unavailable("missing_baseline");
  const anchor = Date.parse(comparison.anchorAt);
  if (now < anchor || now - anchor > HOUR) return unavailable("old_reading");
  const ref = historyReference(station);
  const samples = history.channels
    .find((c) => c.index === ref.index && c.datum === comparison.datum)
    .points.filter(
      (p) =>
        Date.parse(p.at) >= Date.parse(recent.baselineAt) &&
        Date.parse(p.at) <= anchor,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (
    samples.length < 3 ||
    samples.some(
      (p, i) =>
        i && Date.parse(p.at) - Date.parse(samples[i - 1].at) > HOUR / 2,
    )
  )
    return unavailable("sparse_history");
  const rateMPerHour =
    (recent.currentLevel - recent.baselineLevel) / (recent.actualMinutes / 60);
  const projections = FORECAST_HOURS.map((hours) => {
    const target = now + hours * HOUR;
    const delta = (rateMPerHour * (target - anchor)) / HOUR;
    return {
      hours,
      at: new Date(target).toISOString(),
      level: recent.currentLevel + delta,
      deltaCm: delta * 100,
    };
  });
  if (
    !Number.isFinite(rateMPerHour) ||
    projections.some(
      (p) => !Number.isFinite(p.level) || Math.abs(p.level) >= 10000,
    )
  )
    return unavailable("invalid_projection");
  return {
    status: "ready",
    model: "constant_level_change_rate",
    stationId: station.id,
    datum: comparison.datum,
    issuedAt: new Date(now).toISOString(),
    anchorAt: comparison.anchorAt,
    baselineAt: recent.baselineAt,
    baseLevel: recent.currentLevel,
    rateMPerHour,
    actualMinutes: recent.actualMinutes,
    sampleCount: samples.length,
    projections,
  };
}
