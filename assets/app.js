(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const config = window.WATER_CONFIG || {};
  const colors = {
    green: "#168254",
    yellow: "#b37e10",
    orange: "#d9671f",
    red: "#ce3d50",
    gray: "#697483",
    blue: "#2877bf",
  };
  const presets = {
    damnoen: { lat: 13.518, lon: 99.954, label: "จุดอ้างอิงดำเนินสะดวก" },
    ratchaburi: { lat: 13.5367, lon: 99.8172, label: "จุดอ้างอิงเมืองราชบุรี" },
    maeklong: {
      lat: 13.4098,
      lon: 100.0023,
      label: "จุดอ้างอิงเมืองสมุทรสงคราม",
    },
  };
  let here = null,
    lastData = null,
    timer = null,
    active = null,
    serial = 0,
    locationSerial = 0,
    shown = 12;
  let map = null,
    stationLayer = null,
    userLayer = null,
    lastView = "",
    markers = new Map(),
    requestingGps = false;
  let stationFingerprint = "",
    mapFingerprint = "";
  const formatTime = (value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return "ไม่ทราบเวลา";
    return new Date(value).toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };
  const levelText = (s) =>
    s.waterLevelMsl !== null
      ? `${s.waterLevelMsl.toFixed(2)} ม.รทก.`
      : s.waterLevelLocal !== null
        ? `${s.waterLevelLocal.toFixed(2)} ม. (ระดับอ้างอิงเฉพาะสถานี)`
        : "ไม่มีค่าระดับน้ำ";
  const trendText = (s) =>
    ({
      rising: "↑ เพิ่มขึ้นจากค่าก่อนหน้า",
      falling: "↓ ลดลงจากค่าก่อนหน้า",
      stable: "→ คงที่จากค่าก่อนหน้า",
      unknown: "ไม่มีค่าเทียบก่อนหน้า",
    })[s.trend] || "ไม่มีค่าเทียบก่อนหน้า";
  const qualityText = (s) =>
    ({
      stale: "ข้อมูลตรวจวัดเก่า",
      missing: "ไม่มีค่าตรวจวัด",
      unknown: "เวลาตรวจวัดไม่ครบ",
    })[s.dataQuality] || s.situationLabel;
  function list(id, items) {
    $(id).replaceChildren(
      ...items.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
  }
  function assessment(value) {
    const a = value || {
      score: null,
      level: "unknown",
      label: "ข้อมูลยังไม่เพียงพอสำหรับประเมิน",
      confidence: "insufficient",
      reasons: ["รอข้อมูลสถานีล่าสุด"],
    };
    $("score").textContent = a.score === null ? "—" : a.score;
    $("verdict").textContent = a.label;
    const color =
      {
        high: "var(--red)",
        elevated: "var(--orange)",
        watch: "var(--yellow)",
        low: "var(--green)",
      }[a.level] || "var(--gray)";
    $("gauge").style.setProperty("--signal", a.score ?? 0);
    $("gauge").style.setProperty("--signal-color", color);
    $("gauge").setAttribute(
      "aria-label",
      a.score === null ? a.label : `คะแนนสัญญาณ ${a.score} จาก 100 ${a.label}`,
    );
    $("verdict").style.color = color;
    $("confidence").textContent =
      a.confidence === "low"
        ? "ความเชื่อมั่นต่อผลกระทบตำแหน่งนี้: ต่ำ"
        : "ความเชื่อมั่น: ข้อมูลไม่เพียงพอ";
    list("reasons", a.reasons);
    if (a.limitations) list("limitations", a.limitations);
    const observedWarning = lastData?.stations?.some(
      (s) =>
        s.dataQuality === "fresh" &&
        ["overflow", "critical", "high"].includes(s.situation),
    );
    $("emergency").hidden = !(
      observedWarning || ["high", "elevated"].includes(a.level)
    );
  }
  function initMap() {
    if (!window.L) {
      $("map-status").textContent =
        "แผนที่ไม่พร้อมใช้งาน ยังดูข้อมูลสถานีด้านล่างได้";
      return;
    }
    map = L.map("map", { scrollWheelZoom: false }).setView([13.518, 99.954], 9);
    L.tileLayer(
      config.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 18,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    )
      .on("tileerror", () => {
        $("map-status").textContent =
          "ภาพแผนที่บางส่วนไม่พร้อมใช้งาน ตำแหน่งสถานีและรายการด้านล่างยังใช้ได้";
      })
      .addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    userLayer = L.layerGroup().addTo(map);
  }
  function popup(s) {
    const box = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = s.name;
    box.append(title);
    for (const value of [
      qualityText(s),
      levelText(s),
      `ห่าง ${s.distanceKm.toFixed(1)} กม.`,
      `ตรวจวัด ${formatTime(s.sensorUpdatedAt)}`,
      s.river,
      `${s.source} · ${s.agency || "ไม่ระบุหน่วยงาน"}`,
    ]) {
      if (!value) continue;
      const p = document.createElement("p");
      p.textContent = value;
      box.append(p);
    }
    return box;
  }
  function updateMap(stations) {
    if (!map || !here) return;
    const key = `${here.lat},${here.lon},${$("radius").value}`;
    if (key !== lastView) {
      userLayer.clearLayers();
      const point = [here.lat, here.lon];
      L.circle(point, {
        radius: +$("radius").value * 1000,
        color: colors.blue,
        weight: 1,
        fillOpacity: 0.035,
      }).addTo(userLayer);
      const label = document.createElement("span");
      label.textContent = here.label;
      L.circleMarker(point, {
        radius: 9,
        color: "#fff",
        weight: 3,
        fillColor: colors.blue,
        fillOpacity: 1,
      })
        .bindPopup(label)
        .addTo(userLayer);
      if (here.accuracy)
        L.circle(point, {
          radius: here.accuracy,
          color: colors.blue,
          weight: 1,
          fillOpacity: 0.1,
        }).addTo(userLayer);
      map.setView(
        point,
        +$("radius").value === 20 ? 10 : +$("radius").value === 50 ? 9 : 8,
      );
      lastView = key;
    }
    const fingerprint = JSON.stringify(stations);
    if (fingerprint === mapFingerprint) return;
    mapFingerprint = fingerprint;
    stationLayer.clearLayers();
    markers = new Map();
    for (const s of stations) {
      const color =
        s.dataQuality === "fresh"
          ? colors[s.color] || colors.gray
          : colors.gray;
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: "#fff",
        weight: 1.5,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindPopup(popup(s))
        .addTo(stationLayer);
      markers.set(s.id, marker);
    }
  }
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  function stationState(s) {
    if (lastData?.source.status !== "fresh")
      return { label: "ข้อมูลที่เก็บไว้", color: "gray", current: false };
    if (s.dataQuality !== "fresh")
      return {
        label: s.dataQuality === "stale" ? "ข้อมูลเก่า" : "ข้อมูลไม่ครบ",
        color: "gray",
        current: false,
      };
    return {
      label:
        s.source === "RID"
          ? {
              critical: "ถึงเกณฑ์วิกฤติ",
              high: "เฝ้าระวัง",
              normal: "ต่ำกว่าเกณฑ์เฝ้าระวัง",
              unknown: "ยังไม่มีเกณฑ์เทียบ",
            }[s.situation] || "ยังไม่มีเกณฑ์เทียบ"
          : {
              overflow: "น้ำล้นตลิ่ง",
              high: "น้ำมาก",
              normal: "ระดับน้ำปกติ",
              low: "น้ำน้อย",
              critical_low: "น้ำน้อยวิกฤติ",
              unknown: "ยังไม่มีเกณฑ์เทียบ",
            }[s.situation] || "ยังไม่มีเกณฑ์เทียบ",
      color: s.situation === "unknown" ? "gray" : s.color || "gray",
      current: true,
    };
  }
  function comparison(s, current) {
    if (!current)
      return { text: "รอข้อมูลล่าสุดเพื่อเทียบกับเกณฑ์", scale: null };
    const level =
      s.thresholdDatum === "local" ? s.waterLevelLocal : s.waterLevelMsl;
    const known =
      [level, s.warningLevel, s.criticalLevel].every(
        (v) => typeof v === "number" && Number.isFinite(v),
      ) &&
      ["msl", "local"].includes(s.thresholdDatum) &&
      s.criticalLevel > s.warningLevel;
    const distance = (value) =>
      Math.abs(value) < 0.01
        ? "น้อยกว่า 1 ซม."
        : `${Math.round(Math.abs(value) * 100)} ซม.`;
    if (known) {
      const critical = level >= s.criticalLevel,
        watching = level >= s.warningLevel;
      const boundary = critical ? s.criticalLevel : s.warningLevel;
      const difference = level - boundary;
      const boundaryName = critical ? "เกณฑ์วิกฤติ" : "เกณฑ์เฝ้าระวัง";
      const low = Math.min(level, s.warningLevel),
        high = Math.max(level, s.criticalLevel);
      const span = Math.max(high - low, 0.3),
        min = low - span * 0.2,
        max = high + span * 0.2;
      const position = (value) => ((value - min) / (max - min)) * 100;
      return {
        text:
          Math.abs(difference) < 1e-8
            ? `ระดับน้ำถึง${boundaryName}`
            : `${critical || watching ? "สูงกว่า" : "ยังต่ำกว่า"}${boundaryName} ${distance(difference)}`,
        scale: {
          level: position(level),
          watch: position(s.warningLevel),
          critical: position(s.criticalLevel),
          value: level,
        },
      };
    }
    if (
      typeof s.waterLevelMsl === "number" &&
      Number.isFinite(s.waterLevelMsl) &&
      typeof s.bankGapM === "number" &&
      Number.isFinite(s.bankGapM)
    ) {
      return {
        text:
          Math.abs(s.bankGapM) < 1e-8
            ? "ระดับน้ำเท่าตลิ่งที่สถานีนี้"
            : `${s.bankGapM > 0 ? "ยังต่ำกว่า" : "สูงกว่า"}ตลิ่งที่สถานี ${distance(s.bankGapM)}`,
        scale: null,
      };
    }
    return { text: "ยังไม่มีเกณฑ์เทียบระดับน้ำของสถานีนี้", scale: null };
  }
  function measuredAgo(value) {
    const at = Date.parse(value),
      checked = Date.parse(lastData?.checkedAt);
    if (
      !Number.isFinite(at) ||
      !Number.isFinite(checked) ||
      at - checked > 5 * 60000
    )
      return "ไม่ทราบเวลาตรวจวัด";
    const minutes = Math.max(0, Math.floor((checked - at) / 60000));
    if (minutes < 1) return "เพิ่งตรวจวัด";
    if (minutes < 60) return `วัดล่าสุด ${minutes} นาทีที่แล้ว`;
    if (minutes < 1440)
      return `วัดล่าสุด ${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาทีที่แล้ว`;
    return `วัดเมื่อ ${Math.floor(minutes / 1440)} วันที่แล้ว`;
  }
  const stationTimeText = (s) =>
    s.dataQuality === "missing"
      ? "ยังไม่มีค่าตรวจวัดล่าสุด"
      : measuredAgo(s.sensorUpdatedAt);
  let stationTimes = [],
    stationDetails = [];
  function renderStations() {
    const rows = lastData?.stations || [];
    for (const { node, station } of stationTimes)
      node.textContent = stationTimeText(station);
    const fingerprint = JSON.stringify(rows) + shown + lastData?.source.status;
    if (fingerprint === stationFingerprint) return;
    stationFingerprint = fingerprint;
    const expanded = new Set(
      stationDetails.filter(({ node }) => node.open).map(({ id }) => id),
    );
    stationTimes = [];
    stationDetails = [];
    const cards = rows.slice(0, shown).map((s) => {
      const state = stationState(s),
        relative = comparison(s, state.current);
      const card = element("article", `station station-${state.color}`);
      card.setAttribute("data-station-id", s.id);
      const head = element("div", "station-head");
      const point =
        s.source === "RID"
          ? s.name.match(/ · (เหนือน้ำ|ท้ายน้ำ|จุด \d+)$/)?.[1]
          : null;
      const name = point ? s.name.slice(0, s.name.lastIndexOf(" · ")) : s.name;
      head.append(element("h3", "", name));
      if (point)
        head.append(
          element(
            "span",
            "station-point",
            point.startsWith("จุด") ? point : `ด้าน${point}`,
          ),
        );
      card.append(head);
      const context = element(
        "p",
        "station-context",
        `ห่าง ${s.distanceKm.toFixed(1)} กม. จากจุดที่เลือก`,
      );
      card.append(
        context,
        element("span", `badge station-status ${state.color}`, state.label),
      );
      const observation = element("div", "station-observation");
      observation.append(element("p", "label", "ระดับน้ำที่สถานี"));
      const reading = element("div", "reading");
      const level = s.waterLevelMsl ?? s.waterLevelLocal;
      reading.append(
        element(
          "strong",
          "",
          typeof level === "number" ? level.toFixed(2) : "—",
        ),
        element("span", "reading-unit", "เมตร"),
      );
      observation.append(
        reading,
        element(
          "p",
          "station-datum",
          s.waterLevelMsl != null
            ? "เทียบระดับทะเลปานกลาง"
            : s.waterLevelLocal != null
              ? "เทียบจุดอ้างอิงเฉพาะสถานี"
              : "ยังไม่มีค่าตรวจวัด",
        ),
      );
      card.append(observation);
      const comparisonBox = element("div", `station-comparison ${state.color}`);
      comparisonBox.append(element("p", "station-difference", relative.text));
      if (relative.scale) {
        const scale = element("div", "station-scale");
        scale.setAttribute("role", "img");
        scale.setAttribute(
          "aria-label",
          `ระดับน้ำ ${relative.scale.value.toFixed(2)} เมตร เกณฑ์เฝ้าระวัง ${s.warningLevel.toFixed(2)} เมตร เกณฑ์วิกฤติ ${s.criticalLevel.toFixed(2)} เมตร ในระดับอ้างอิงเดียวกัน`,
        );
        scale.style.setProperty("--watch-at", `${relative.scale.watch}%`);
        scale.style.setProperty("--critical-at", `${relative.scale.critical}%`);
        scale.style.setProperty("--level-at", `${relative.scale.level}%`);
        const track = element("div", "station-scale-track");
        track.setAttribute("aria-hidden", "true");
        track.append(
          element("span", "station-scale-tick watch"),
          element("span", "station-scale-tick critical"),
          element("span", "station-scale-level"),
        );
        const labels = element("div", "station-scale-labels");
        labels.setAttribute("aria-hidden", "true");
        labels.append(
          element("span", "", `เฝ้าระวัง ${s.warningLevel.toFixed(2)} ม.`),
          element("span", "", `วิกฤติ ${s.criticalLevel.toFixed(2)} ม.`),
        );
        scale.append(track, labels);
        comparisonBox.append(scale);
      }
      card.append(comparisonBox);
      if (state.current && s.riseRateCmPerHour != null)
        card.append(
          element(
            "p",
            "station-trend",
            `${s.riseRateCmPerHour > 0 ? "↑ เพิ่มขึ้น" : s.riseRateCmPerHour < 0 ? "↓ ลดลง" : "→ คงที่"} ${Math.abs(s.riseRateCmPerHour).toFixed(1)} ซม./ชม.`,
          ),
        );
      const time = element("time", "station-time", stationTimeText(s));
      if (s.sensorUpdatedAt) time.setAttribute("datetime", s.sensorUpdatedAt);
      time.setAttribute("title", formatTime(s.sensorUpdatedAt));
      card.append(time);
      stationTimes.push({ node: time, station: s });
      const details = element("details", "station-details");
      details.open = expanded.has(s.id);
      details.append(element("summary", "", "เกณฑ์และข้อมูลสถานี"));
      const info = element("dl", "station-facts");
      const datum =
        s.waterLevelMsl != null
          ? "เมตรจากระดับทะเลปานกลาง (ม.รทก.) ไม่ใช่ความลึกของน้ำ"
          : s.waterLevelLocal != null
            ? "เมตรจากจุดอ้างอิงเฉพาะสถานี เทียบข้ามสถานีโดยตรงไม่ได้"
            : "ยังไม่ทราบระดับอ้างอิง";
      for (const [label, value] of [
        ["ระดับอ้างอิง", datum],
        [
          "เกณฑ์เฝ้าระวัง",
          s.warningLevel != null
            ? `${s.warningLevel.toFixed(2)} เมตร`
            : "ไม่มีข้อมูล",
        ],
        [
          "เกณฑ์วิกฤติ",
          s.criticalLevel != null
            ? `${s.criticalLevel.toFixed(2)} เมตร`
            : "ไม่มีข้อมูล",
        ],
        ["ตรวจวัดเมื่อ", formatTime(s.sensorUpdatedAt)],
        ["ทางน้ำ / ลุ่มน้ำ", s.river || s.basin || "ไม่ระบุ"],
        ["แนวโน้ม", trendText(s)],
        [
          "แหล่งข้อมูล",
          `${s.agency || s.source || "ไม่ระบุ"}${s.source ? " · " + s.source : ""}`,
        ],
        ["รหัสสถานี", s.code || "ไม่ระบุ"],
      ])
        info.append(element("dt", "", label), element("dd", "", value));
      details.append(
        info,
        element(
          "p",
          "station-note",
          "เกณฑ์นี้ใช้กับจุดวัดของสถานี ไม่ได้ยืนยันว่าจะท่วมจุดที่คุณเลือก",
        ),
      );
      card.append(details);
      stationDetails.push({ id: s.id, node: details });
      if (map) {
        const button = element("button", "station-button", "ดูบนแผนที่ ↗");
        button.type = "button";
        button.setAttribute("aria-label", `ดู ${s.name} บนแผนที่`);
        button.onclick = () => {
          $("map").scrollIntoView({ block: "center", behavior: "auto" });
          map.setView([s.lat, s.lon], 12);
          markers.get(s.id)?.openPopup();
        };
        card.append(button);
      }
      return card;
    });
    $("stations").replaceChildren(...cards);
    $("show-more").hidden = shown >= rows.length;
  }
  function render(data) {
    lastData = data;
    assessment(data.assessment);
    const sourceName = data.source.name?.startsWith("RID")
      ? "กรมชลประทาน"
      : data.source.name?.startsWith("ThaiWater")
        ? "ThaiWater"
        : data.source.name || "ข้อมูลสถานี";
    $("source-status").textContent =
      data.source.status === "fresh"
        ? `● ${sourceName}${data.source.fallback ? " · ข้อมูลสำรอง" : ""}`
        : data.source.status === "stale"
          ? "● ใช้ข้อมูลที่เก็บไว้"
          : "● ต้นทางไม่พร้อมใช้งาน";
    $("source-status").className =
      `badge ${data.source.status === "fresh" ? "green" : "yellow"}`;
    const unavailable = data.source.status === "unavailable";
    $("station-count").textContent = unavailable
      ? "ยังไม่มีข้อมูลสถานี"
      : `${data.stations.length} จุดตรวจวัด · รัศมี ${data.radiusKm} กม.`;
    $("data-status").textContent =
      data.source.status !== "fresh"
        ? data.source.status === "stale"
          ? "กำลังใช้ข้อมูลที่เก็บไว้ กรุณาตรวจเวลาวัดของแต่ละสถานี"
          : "ยังรับข้อมูลสถานีไม่ได้ กรุณาตรวจอีกครั้งภายหลัง"
        : data.stations.length
          ? `พบ ${data.stations.length} จุดตรวจวัดใน ${data.radiusKm} กม. · ${data.stations.filter((s) => s.dataQuality === "fresh").length} จุดมีข้อมูลล่าสุด${data.stations.some((s) => s.dataQuality !== "fresh") ? " · ป้ายสีเทาคือข้อมูลเก่าหรือไม่ครบ" : ""}`
          : "ไม่พบสถานีในรัศมีนี้ ลองขยายรัศมีหรือเลือกพื้นที่อื่น";
    $("source-details").hidden = false;
    $("source-detail").textContent =
      `${data.source.name || sourceName} · ${data.source.message || "ข้อมูลจากหน่วยงานเจ้าของสถานี"}${data.source.fetchedAt ? " · แอปรับข้อมูลเมื่อ " + formatTime(data.source.fetchedAt) : ""}`;
    const s = data.stations[0];
    $("nearest").textContent =
      s?.name || (unavailable ? "ยังไม่มีข้อมูล" : "ไม่พบสถานี");
    $("near-distance").textContent = s
      ? `${s.distanceKm.toFixed(1)} กม. · ${qualityText(s)}`
      : unavailable
        ? "ต้นทางไม่พร้อมใช้งาน"
        : "ลองขยายรัศมีค้นหา";
    $("near-level").textContent = s ? levelText(s) : "—";
    $("sensor-time").textContent = s
      ? `ตรวจวัด: ${formatTime(s.sensorUpdatedAt)}`
      : "เวลาตรวจวัด: —";
    $("rise-rate").textContent =
      s?.riseRateCmPerHour != null
        ? `${s.riseRateCmPerHour > 0 ? "+" : ""}${s.riseRateCmPerHour.toFixed(1)} ซม./ชม.`
        : "ยังไม่มีค่าต่อชั่วโมง";
    $("trend").textContent = s
      ? `${trendText(s)}${s.riseRateCmPerHour == null ? " • ไม่ทราบช่วงเวลาของค่าก่อนหน้า" : ""}`
      : "ต้องมีเวลาตรวจวัดสองครั้ง";
    $("checked-time").textContent =
      `หน้าเว็บตรวจล่าสุด: ${formatTime(data.checkedAt)}`;
    $("fetched-time").textContent =
      `แอปรับข้อมูลต้นทาง: ${formatTime(data.updatedAt)}`;
    renderStations();
    updateMap(data.stations);
  }
  function schedule(delay = 5000) {
    clearTimeout(timer);
    if (here && !document.hidden && navigator.onLine)
      timer = setTimeout(load, delay);
  }
  async function load() {
    clearTimeout(timer);
    if (!here || document.hidden || !navigator.onLine || active) return;
    const requestId = serial;
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), 65000);
    $("refresh").disabled = true;
    if (!lastData)
      $("data-status").textContent =
        "กำลังตรวจข้อมูลสถานี… การเชื่อมต่อครั้งแรกอาจใช้เวลาประมาณหนึ่งนาที";
    try {
      const query = new URLSearchParams({
        lat: here.lat,
        lon: here.lon,
        radius: $("radius").value,
      });
      const response = await fetch(
        `${config.apiBase || ""}/api/water?${query}`,
        {
          signal: controller.signal,
          headers: { Accept: "application/json" },
          cache: "no-store",
        },
      );
      let data = await response.json();
      if (requestId !== serial) return;
      if (!data.source || !Array.isArray(data.stations) || !data.assessment)
        throw new Error(data.message || "ข้อมูลจากบริการไม่ครบ");
      if (!response.ok && response.status !== 503)
        throw new Error(data.message || "บริการไม่พร้อมใช้งาน");
      if (response.status === 503 && data.source.status === "unavailable") {
        try {
          const { browserSource } = await import("./browser-source.js");
          data = await browserSource.get({
            location: { lat: here.lat, lon: here.lon },
            radiusKm: +$("radius").value,
            version: data.version,
            signal: controller.signal,
          });
          if (requestId !== serial) return;
        } catch (error) {
          if (requestId !== serial) return;
          console.warn(
            "water_browser_source_unavailable",
            error?.cause?.name || error?.name,
            error?.cause?.message || error?.message,
          );
          data.source.message += " • เส้นทางสำรองผ่านเบราว์เซอร์ยังไม่พร้อม";
        }
      }
      render(data);
    } catch (error) {
      if (requestId !== serial) return;
      $("source-status").textContent = "● ยังตรวจข้อมูลล่าสุดไม่ได้";
      $("source-status").className = "badge yellow";
      assessment({
        score: null,
        level: "unknown",
        confidence: "insufficient",
        label: "ยังตรวจข้อมูลล่าสุดไม่ได้",
        reasons: [
          "ค่าที่เห็นเป็นข้อมูลจากการตรวจครั้งก่อน กรุณาตรวจอีกครั้งเมื่อเชื่อมต่อได้",
        ],
      });
      $("data-status").textContent =
        error.name === "AbortError"
          ? "การเชื่อมต่อใช้เวลานาน กรุณาตรวจอีกครั้ง ข้อมูลที่แสดงอาจเก่าแล้ว"
          : "เชื่อมต่อข้อมูลไม่สำเร็จ ข้อมูลที่แสดงอาจเก่าแล้ว ระบบจะลองตรวจอีกครั้ง";
    } finally {
      clearTimeout(timeout);
      if (active === controller) {
        active = null;
        $("refresh").disabled = false;
        schedule();
      }
    }
  }
  function resetRequest() {
    serial++;
    if (active) active.abort();
    active = null;
    clearTimeout(timer);
    $("refresh").disabled = false;
  }
  function setLocation(location) {
    locationSerial++;
    resetRequest();
    here = location;
    lastData = null;
    shown = 12;
    $("place").textContent = here.label;
    $("coords").textContent =
      `${here.lat.toFixed(5)}, ${here.lon.toFixed(5)}${here.accuracy ? ` · คลาดเคลื่อน ±${Math.round(here.accuracy)} ม.` : " · พิกัดที่เลือกเอง"}`;
    $("location-status").textContent = here.accuracy
      ? "ได้รับตำแหน่ง GPS แล้ว"
      : "กำลังตรวจพื้นที่ที่เลือก ไม่ใช่ตำแหน่ง GPS ของคุณ";
    $("manual-lat").value = here.lat;
    $("manual-lon").value = here.lon;
    $("nearest").textContent = $("near-level").textContent = "—";
    $("near-distance").textContent = "กำลังค้นหาสถานี";
    $("sensor-time").textContent = "เวลาตรวจวัด: —";
    $("rise-rate").textContent = "ยังไม่มีค่าต่อชั่วโมง";
    $("trend").textContent = "ต้องมีเวลาตรวจวัดสองครั้ง";
    $("checked-time").textContent = "หน้าเว็บตรวจล่าสุด: —";
    $("fetched-time").textContent = "แอปรับข้อมูลต้นทาง: —";
    $("station-count").textContent = "กำลังค้นหา";
    assessment();
    renderStations();
    updateMap([]);
    load();
  }
  function openManual() {
    $("manual-location").hidden = false;
    $("manual-toggle").setAttribute("aria-expanded", "true");
  }
  function locate() {
    if (requestingGps) return;
    if (!navigator.geolocation || !window.isSecureContext) {
      $("location-status").textContent =
        "เบราว์เซอร์นี้ไม่รองรับ GPS หรือไม่ได้เปิดผ่าน HTTPS กรุณาเลือกพื้นที่หรือใส่พิกัด";
      openManual();
      return;
    }
    requestingGps = true;
    $("locate").disabled = true;
    $("location-status").textContent = "กำลังขออนุญาตและค้นหาตำแหน่ง GPS…";
    const gpsSerial = locationSerial;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        requestingGps = false;
        $("locate").disabled = false;
        if (gpsSerial !== locationSerial) return;
        setLocation({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          label: "ตำแหน่ง GPS ปัจจุบัน",
        });
      },
      (error) => {
        requestingGps = false;
        $("locate").disabled = false;
        if (gpsSerial !== locationSerial) return;
        $("location-status").textContent =
          {
            1: "ไม่ได้รับอนุญาตใช้ตำแหน่ง เปิดสิทธิ์ Location ในการตั้งค่าเบราว์เซอร์ หรือเลือกพื้นที่ด้านล่าง",
            2: "ไม่สามารถหาตำแหน่ง GPS ได้ ลองใหม่หรือเลือกพื้นที่ด้านล่าง",
            3: "การค้นหาตำแหน่ง GPS หมดเวลา ลองใหม่หรือเลือกพื้นที่ด้านล่าง",
          }[error.code] || "อ่านตำแหน่งไม่ได้ กรุณาเลือกพื้นที่หรือใส่พิกัด";
        openManual();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }
  $("locate").onclick = locate;
  $("manual-toggle").onclick = () => {
    const open = $("manual-location").hidden;
    $("manual-location").hidden = !open;
    $("manual-toggle").setAttribute("aria-expanded", String(open));
  };
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.onclick = () => setLocation({ ...presets[button.dataset.preset] });
  });
  $("location-form").onsubmit = (event) => {
    event.preventDefault();
    const lat = Number($("manual-lat").value),
      lon = Number($("manual-lon").value);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    )
      setLocation({ lat, lon, label: "พิกัดที่เลือกเอง" });
  };
  $("refresh").onclick = () => load();
  $("radius").onchange = () => {
    if (!here) return;
    setLocation({ ...here });
  };
  $("show-more").onclick = () => {
    shown += 12;
    renderStations();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resetRequest();
    } else load();
  });
  window.addEventListener("offline", () => {
    resetRequest();
    $("data-status").textContent = "ออฟไลน์ ข้อมูลที่แสดงเป็นการตรวจครั้งก่อน";
    assessment({
      score: null,
      level: "unknown",
      label: "ออฟไลน์ ยังตรวจข้อมูลล่าสุดไม่ได้",
      confidence: "insufficient",
      reasons: ["เชื่อมต่ออินเทอร์เน็ตเพื่อตรวจข้อมูลอีกครั้ง"],
    });
    $("source-status").textContent = "● ออฟไลน์";
    $("source-status").className = "badge yellow";
  });
  window.addEventListener("online", load);
  initMap();
  locate();
})();
