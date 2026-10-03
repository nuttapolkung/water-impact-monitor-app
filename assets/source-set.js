import { nearbyStations, assess } from "./water.js?v=20261003-sources";

const newest = (values) =>
  values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ||
  null;
const rank = { unavailable: 0, stale: 1, fresh: 2 };

// Keep independent source freshness; a working source must not make another
// source's saved measurements appear current, or replace its station coverage.
export function combineSnapshots(snapshots, primaryName = "ThaiWater") {
  const sources = new Map(),
    stations = new Map();
  for (const snapshot of snapshots) {
    const metadata = {
      name: snapshot.sourceName,
      url: snapshot.sourceUrl,
      status: snapshot.status,
      fetchedAt: snapshot.fetchedAt,
      nextRefreshAt: snapshot.nextRefreshAt,
      transport: snapshot.transport || "server",
    };
    const oldSource = sources.get(metadata.name);
    const newer =
      !oldSource ||
      rank[metadata.status] > rank[oldSource.status] ||
      (metadata.status === oldSource.status &&
        Date.parse(metadata.fetchedAt) > Date.parse(oldSource.fetchedAt));
    if (newer) sources.set(metadata.name, metadata);
    if (snapshot.status === "unavailable") continue;
    for (const station of snapshot.stations || []) {
      const candidate = { ...station, sourceStatus: snapshot.status };
      const old = stations.get(station.id);
      if (
        !old ||
        rank[candidate.sourceStatus] > rank[old.sourceStatus] ||
        (candidate.sourceStatus === old.sourceStatus &&
          Date.parse(candidate.sensorUpdatedAt) >=
            Date.parse(old.sensorUpdatedAt))
      )
        stations.set(station.id, candidate);
    }
  }
  const entries = [...sources.values()],
    usable = entries.filter((s) => s.status !== "unavailable");
  const status = usable.some((s) => s.status === "fresh")
    ? "fresh"
    : usable.length
      ? "stale"
      : "unavailable";
  return {
    stations: [...stations.values()],
    sources: entries,
    sourceName: usable.map((s) => s.name).join(" + ") || primaryName,
    sourceUrl: usable[0]?.url || entries[0]?.url,
    fetchedAt: newest(usable.map((s) => s.fetchedAt)),
    lastFailureAt: newest(snapshots.map((s) => s.lastFailureAt)),
    nextRefreshAt:
      entries
        .map((s) => s.nextRefreshAt)
        .filter(Boolean)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null,
    status,
    partial: entries.some((s) => s.status !== "fresh"),
    fallback: !entries.some(
      (s) => s.name === primaryName && s.status === "fresh",
    ),
  };
}

export function mergeWaterResponses(base, extra, now = Date.now()) {
  const snapshots = [base, extra].flatMap((data) => {
    const entries = data.source.sources || [
      {
        name: data.source.name?.startsWith("RID") ? "RID" : "ThaiWater",
        status: data.source.status,
        fetchedAt: data.source.fetchedAt || data.updatedAt,
        url: data.source.url,
        transport: data.source.transport,
      },
    ];
    return entries.map((source) => ({
      ...source,
      sourceName: source.name,
      sourceUrl: source.url,
      stations: data.stations.filter(
        (s) => s.source === source.name || entries.length === 1,
      ),
    }));
  });
  const combined = combineSnapshots(snapshots);
  const stations = nearbyStations(
    combined.stations,
    base.location,
    base.radiusKm,
    now,
  );
  return {
    ...base,
    stations,
    updatedAt: combined.fetchedAt,
    checkedAt: new Date(now).toISOString(),
    source: {
      ...base.source,
      name: combined.sourceName,
      url: combined.sourceUrl,
      fetchedAt: combined.fetchedAt,
      status: combined.status,
      sources: combined.sources,
      partial: combined.partial,
      fallback: combined.fallback,
      message: "รวมข้อมูลสถานี ThaiWater และ RID · ตรวจสถานะแต่ละแหล่งแยกกัน",
    },
    assessment: assess(stations, combined.status),
  };
}
