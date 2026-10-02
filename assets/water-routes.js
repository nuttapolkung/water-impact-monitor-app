// Geographic connectivity, not a live flow-direction or travel-time model.
// See docs/SOURCES.md for station-code/coordinate checks and official diagrams.
const sources = {
  registry: {
    label: "ทะเบียนสถานี RID",
    url: "https://water.rid.go.th/hyd/download/key_station.pdf",
  },
  maeklong: {
    label: "แผนผังลุ่มน้ำแม่กลอง · RID",
    url: "https://water.rid.go.th/hyd/Diagram/graphic_maeklong.pdf",
  },
  thachin: {
    label: "แผนผังลุ่มน้ำท่าจีน · RID",
    url: "https://water.rid.go.th/hyd/Diagram/graphic_thachin.pdf",
  },
  phetchaburi: {
    label: "แผนผังลุ่มน้ำเพชรบุรี · RID",
    url: "https://water.rid.go.th/hyd/Diagram/graphic_phetchaburi.pdf",
  },
  damnoen: {
    label: "คลองดำเนินสะดวก · กรมศิลปากร",
    url: "https://www.finearts.go.th/ratchaburimuseum/view/21799",
  },
  bangpa: {
    label: "ทางน้ำสองฝั่งแม่กลอง · ชป.13",
    url: "https://rid13.rid.go.th/th/history",
  },
};
const known = {
  "TK.72": [13.4913, 99.9445, "maeklong"],
  "TK.57": [13.4689, 99.9401, "maeklong"],
  "K.57": [13.468574, 99.939382, "maeklong"],
  "K.55A": [13.818668, 99.864743, "maeklong"],
  "TK.55A": [13.830933, 99.86531, "maeklong"],
  "K.2B": [13.541195, 99.824104, "maeklong"],
  TTC09: [13.662052, 100.223332, "thachin"],
  TTC10: [13.530641, 100.265382, "thachin"],
  "T.1": [13.801709, 100.187882, "thachin"],
  TTC08: [13.800896, 100.188057, "thachin"],
  TPB14: [13.122298, 99.953484, "phetchaburi"],
  TPB15: [13.212777, 99.982754, "phetchaburi"],
  TMK03: [13.500218, 99.9273112, "damnoen"],
  MKG005: [13.57563, 100.07884, "damnoen"],
  "TK.75": [13.533404, 99.861115, "bangpa"],
  "TK.76": [13.576265, 99.864137, "bangpa"],
};
function documented(kind) {
  const common = {
    status: "documented",
    kind: "river",
    connector: "→",
    note: "เส้นทางหลักตามภูมิศาสตร์ ทิศไหลขณะนี้อาจเปลี่ยนตามการระบายน้ำและน้ำทะเลหนุน ยังไม่มีการตรวจวัดทิศไหลที่จุดนี้",
  };
  if (kind === "maeklong")
    return {
      ...common,
      waterway: "แม่น้ำแม่กลอง",
      summary: "รับน้ำต้นน้ำจากแควใหญ่และแควน้อย",
      origin: "แควใหญ่ + แควน้อย ผ่านเขื่อนแม่กลอง",
      destination: "ปากแม่น้ำแม่กลอง · สมุทรสงคราม → อ่าวไทย",
      nodes: [
        "แควใหญ่ + แควน้อย",
        "เขื่อนแม่กลอง",
        "แม่น้ำแม่กลอง",
        "จุดวัดนี้",
        "สมุทรสงคราม · อ่าวไทย",
      ],
      sources: [sources.maeklong, sources.registry],
    };
  if (kind === "thachin")
    return {
      ...common,
      waterway: "แม่น้ำท่าจีน",
      summary: "ต้นน้ำแยกจากแม่น้ำเจ้าพระยาที่ชัยนาท",
      origin: "แม่น้ำเจ้าพระยา · ชัยนาท",
      destination: "ปากแม่น้ำท่าจีน · สมุทรสาคร → อ่าวไทย",
      nodes: [
        "แม่น้ำเจ้าพระยา · ชัยนาท",
        "แม่น้ำท่าจีน",
        "จุดวัดนี้",
        "สมุทรสาคร · อ่าวไทย",
      ],
      sources: [sources.thachin, sources.registry],
    };
  if (kind === "phetchaburi")
    return {
      ...common,
      waterway: "แม่น้ำเพชรบุรี",
      summary: "รับน้ำต้นน้ำผ่านเขื่อนแก่งกระจานและเขื่อนเพชร",
      origin: "แม่น้ำเพชรบุรีตอนบน · เขื่อนแก่งกระจาน",
      destination: "บ้านแหลม → อ่าวไทย",
      nodes: [
        "เขื่อนแก่งกระจาน",
        "เขื่อนเพชร",
        "แม่น้ำเพชรบุรี",
        "จุดวัดนี้",
        "บ้านแหลม · อ่าวไทย",
      ],
      sources: [sources.phetchaburi, sources.registry],
    };
  if (kind === "damnoen")
    return {
      ...common,
      kind: "connection",
      connector: "↔",
      waterway: "คลองดำเนินสะดวก",
      summary: "เชื่อมฝั่งแม่กลองกับฝั่งท่าจีน",
      origin: "แม่น้ำแม่กลอง · บางนกแขวก / แม่น้ำท่าจีน · บางยาง",
      destination: "ทางน้ำเชื่อมสองฝั่ง ไม่ยืนยันทิศไหลขณะนี้",
      nodes: [
        "แม่น้ำแม่กลอง · บางนกแขวก",
        "ประตูน้ำบางนกแขวก",
        "คลองดำเนินสะดวก · จุดวัด",
        "แม่น้ำท่าจีน · บางยาง",
      ],
      note: "คลองเชื่อมแม่น้ำสองฝั่ง น้ำอาจเข้าได้ตามระดับน้ำ การเปิดประตูและน้ำทะเลหนุน ป้ายเหนือน้ำ/ท้ายน้ำคือด้านของจุดวัด ไม่ยืนยันว่าขณะนี้น้ำไหลไปทางใด",
      sources: [sources.damnoen],
    };
  return {
    ...common,
    kind: "connection",
    connector: "↔",
    waterway: "คลองบางป่า",
    summary: "คลองฝั่งตะวันออกที่เชื่อมกับแม่กลอง",
    origin: "แม่น้ำแม่กลอง / ทางน้ำในพื้นที่คลองบางป่า",
    destination: "ขึ้นกับการควบคุมประตูน้ำ",
    nodes: ["แม่น้ำแม่กลอง", "คลองบางป่า", "จุดวัดนี้"],
    note: "เป็นข้อมูลทางน้ำที่เชื่อมกัน ยังไม่มีสถานะเปิดประตู ปริมาณระบาย หรือทิศไหลจริงของจุดนี้ จึงยังระบุไม่ได้ว่าขณะนี้รับน้ำจากฝั่งใด",
    sources: [sources.bangpa],
  };
}

export function waterRoute(station) {
  const code = (station.code || "").split("/")[0];
  const record = known[code];
  // A code alone is insufficient if a source reuses it in another location.
  if (
    record &&
    Number.isFinite(station.lat) &&
    Number.isFinite(station.lon) &&
    Math.hypot(
      (station.lat - record[0]) * 111,
      (station.lon - record[1]) * 108,
    ) < 2
  )
    return documented(record[2]);
  const river = (station.river || "").trim().replace(/^แม่น้ำ/, "");
  if (
    station.lat >= 13.25 &&
    station.lat < 13.9 &&
    station.lon > 99.7 &&
    station.lon < 100.06 &&
    river === "แม่กลอง"
  )
    return documented("maeklong");
  if (
    station.lat > 13.4 &&
    station.lat < 13.95 &&
    station.lon > 100.1 &&
    station.lon < 100.4 &&
    river === "ท่าจีน"
  )
    return documented("thachin");
  if (
    station.lat > 13.08 &&
    station.lat < 13.3 &&
    station.lon > 99.85 &&
    station.lon < 100.08 &&
    river === "เพชรบุรี"
  )
    return documented("phetchaburi");
  if (
    station.lat > 13.45 &&
    station.lat < 13.65 &&
    station.lon > 99.9 &&
    station.lon < 100.22 &&
    river === "คลองดำเนินสะดวก"
  )
    return documented("damnoen");
  const basin = (station.basin || "").replace(/^ลุ่มน้ำ/, "").trim();
  const diagram = {
    แม่กลอง: sources.maeklong,
    ท่าจีน: sources.thachin,
    "เพชรบุรี - ประจวบคีรีขันธ์": sources.phetchaburi,
  }[basin];
  return {
    status: "unknown",
    kind: "unknown",
    waterway: station.river || "ยังไม่ยืนยันทางน้ำที่จุดวัด",
    summary: basin
      ? `ลุ่มน้ำ${basin} · เส้นทางถึงจุดวัดยังไม่ยืนยัน`
      : "ยังไม่มีข้อมูลเส้นทางน้ำของจุดนี้",
    origin: "ยังยืนยันต้นทางของจุดนี้ไม่ได้",
    destination: "ยังไม่มีเส้นทางเชื่อมที่ยืนยันได้",
    nodes: [],
    note: "การอยู่ในลุ่มน้ำเดียวกันหรืออยู่ใกล้กัน ไม่ได้ยืนยันว่าน้ำไหลเชื่อมระหว่างสถานี",
    sources: diagram ? [diagram] : [],
  };
}
