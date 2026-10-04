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
  const areas = [
    ...Object.entries(presets).map(([id, p]) => ({
      ...p,
      id,
      name: p.label.replace(/^จุดอ้างอิง/, ""),
      province: id === "maeklong" ? "สมุทรสงคราม" : "ราชบุรี",
      reference: "จุดอ้างอิงเดิม",
      keywords: "",
    })),
    ...(window.WATER_AREAS || []).filter(
      (a) =>
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        typeof a.province === "string" &&
        Number.isFinite(a.lat) &&
        Number.isFinite(a.lon) &&
        a.lat >= 5 &&
        a.lat <= 21 &&
        a.lon >= 97 &&
        a.lon <= 106,
    ),
  ];
  let here = null,
    lastData = null,
    timer = null,
    active = null,
    serial = 0,
    locationSerial = 0,
    shown = 6;
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
        ? "ผลกระทบที่ตำแหน่งคุณ: ความเชื่อมั่นต่ำ"
        : "ข้อมูลประเมินยังไม่พอ";
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
      `${s.source === "RID" ? "สถานีรายงาน" : "ตรวจวัด"} ${formatTime(s.sensorUpdatedAt)}`,
      s.river,
      s.waterRoute?.summary,
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
  function paintAreaChoices() {
    const tokens = $("area-search")
      .value.trim()
      .normalize("NFC")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const province = $("area-province").value;
    const matches = areas.filter(
      (a) =>
        (!province || a.province === province) &&
        tokens.every((t) =>
          `${a.name} ${a.province} ${a.keywords || ""}`
            .normalize("NFC")
            .toLowerCase()
            .includes(t),
        ),
    );
    if (tokens.length) {
      const rank = (a) =>
        tokens.every((t) => a.name.toLowerCase().includes(t)) ? 0 : 1;
      matches.sort((a, b) => rank(a) - rank(b));
    }
    if (here && !tokens.length && !province)
      matches.sort(
        (a, b) =>
          Math.hypot(
            a.lat - here.lat,
            (a.lon - here.lon) * Math.cos((here.lat * Math.PI) / 180),
          ) -
          Math.hypot(
            b.lat - here.lat,
            (b.lon - here.lon) * Math.cos((here.lat * Math.PI) / 180),
          ),
      );
    const visible = matches.slice(0, 12);
    $("area-count").textContent = !matches.length
      ? "ไม่พบชื่อพื้นที่ ลองชื่อจังหวัด หรือใส่พิกัดเอง"
      : tokens.length || province
        ? `พบ ${matches.length} จุดอ้างอิง${matches.length > 12 ? " · แสดง 12 จุดแรก ลองระบุชื่อให้เจาะจง" : ""}`
        : `${areas.length} จุดอ้างอิง · แนะนำใกล้พื้นที่ที่ดู`;
    $("area-results").replaceChildren(
      ...visible.map((a) => {
        const button = element("button", "area-choice");
        button.type = "button";
        button.setAttribute("aria-label", `เลือก ${a.name} ${a.province}`);
        button.append(
          element("strong", "", a.name),
          element("span", "", a.province),
        );
        button.onclick = () => {
          setLocation({
            lat: a.lat,
            lon: a.lon,
            label: a.label || `จุดอ้างอิง${a.name}`,
            reference: a.reference,
          });
          closeAreaPicker();
        };
        return button;
      }),
    );
  }
  function closeAreaPicker() {
    $("manual-location").hidden = true;
    $("manual-toggle").setAttribute("aria-expanded", "false");
    $("manual-toggle").focus?.();
  }
  function initAreaPicker() {
    $("area-province").append(
      ...[...new Set(areas.map((a) => a.province))]
        .sort((a, b) => a.localeCompare(b, "th"))
        .map((name) => {
          const option = element("option", "", name);
          option.value = name;
          return option;
        }),
    );
    $("area-search").oninput = paintAreaChoices;
    $("area-province").onchange = paintAreaChoices;
    paintAreaChoices();
  }
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
  const stationTimeText = (s, measured = false) =>
    s.dataQuality === "missing"
      ? "ยังไม่มีค่าตรวจวัดล่าสุด"
      : s.source === "RID" && !measured
        ? measuredAgo(s.sensorUpdatedAt)
            .replace(/^วัดล่าสุด/, "สถานีรายงานล่าสุด")
            .replace(/^วัดเมื่อ/, "สถานีรายงานเมื่อ")
        : measuredAgo(s.sensorUpdatedAt);
  let stationTimes = [],
    stationDetails = [];
  const historyResponses = new Map(),
    historyPending = new Set();
  let historyModule, historyImport, historyObserver;
  let historyRows = new Map(),
    visibleHistory = new Set();
  const historyPeriods = [1, 3, 6, 24];
  let forecastModule,
    forecastStationId = null,
    forecastOptionsKey = "",
    forecastRequestFailed = false;
  let contextModule,
    contextImport,
    contextState = null,
    contextActive = null;
  function paintRate() {
    const s = lastData?.stations[0],
      fresh = lastData?.source.status === "fresh" && s?.dataQuality === "fresh";
    const response = s && historyResponses.get(s.id);
    const rate =
      fresh && response?.status === "ready" && historyModule
        ? historyModule.hourlyRate(s, response.data, {
            sourceStatus: lastData.source.status,
          })
        : null;
    if (rate) {
      $("rise-rate").textContent =
        `${rate.rateCmPerHour > 0 ? "↑ เพิ่ม" : rate.rateCmPerHour < 0 ? "↓ ลด" : "→ คงที่"} ${Math.abs(rate.rateCmPerHour).toFixed(1)} ซม./ชม.`;
      $("trend").textContent =
        `${s.name} · เฉลี่ยช่วง ${Math.round(rate.actualMinutes)} นาที · ${formatTime(rate.baselineAt)} → ${formatTime(rate.anchorAt)}`;
    } else if (fresh && Number.isFinite(s.riseRateCmPerHour)) {
      $("rise-rate").textContent =
        `${s.riseRateCmPerHour > 0 ? "↑ เพิ่ม" : s.riseRateCmPerHour < 0 ? "↓ ลด" : "→ คงที่"} ${Math.abs(s.riseRateCmPerHour).toFixed(1)} ซม./ชม.`;
      $("trend").textContent =
        `${s.name} · เทียบเวลาวัดสองครั้ง ${formatTime(s.previousSensorUpdatedAt)} → ${formatTime(s.sensorUpdatedAt)}`;
    } else {
      $("rise-rate").textContent =
        fresh && historyPending.has(s.id)
          ? "กำลังเทียบย้อนหลัง 1 ชม.…"
          : "ยังเทียบย้อนหลังไม่ได้";
      $("trend").textContent = s
        ? `${s.name} · ${fresh ? "ต้องมีค่าของจุดวัดเดียวกันและเวลาครบ" : "ข้อมูลล่าสุดเก่าหรือไม่ครบ"}`
        : "ยังไม่มีสถานีที่เทียบได้";
    }
    paintForecast();
  }
  function paintForecast() {
    const stations = lastData?.stations || [];
    const picker = $("forecast-station");
    const key = JSON.stringify(
      stations.map((s) => [s.id, s.name, s.distanceKm]),
    );
    if (key !== forecastOptionsKey) {
      forecastOptionsKey = key;
      picker.replaceChildren(
        ...(stations.length
          ? stations.map((s) => {
              const option = element(
                "option",
                "",
                `${s.name} · ${s.distanceKm.toFixed(1)} กม.`,
              );
              option.value = s.id;
              return option;
            })
          : [element("option", "", "รอข้อมูลสถานี")]),
      );
    }
    if (!stations.some((s) => s.id === forecastStationId))
      forecastStationId = stations[0]?.id || null;
    picker.value = forecastStationId || "";
    picker.disabled = !stations.length;
    const station = stations.find((s) => s.id === forecastStationId);
    const response = station && historyResponses.get(station.id);
    const pending =
      (!!station && historyPending.has(station.id)) || (!lastData && !!active);
    const result =
      station &&
      response?.status === "ready" &&
      forecastModule &&
      navigator.onLine &&
      !forecastRequestFailed
        ? forecastModule.forecastWaterLevel(station, response.data, {
            sourceStatus: lastData.source.status,
          })
        : null;
    const ready = result?.status === "ready";
    const reasons = {
      old_reading: "ค่าตรวจวัดเกิน 1 ชั่วโมง หรือเวลายังไม่ตรง",
      sparse_history: "ข้อมูลชั่วโมงล่าสุดไม่ต่อเนื่องพอ",
      missing_baseline: "ไม่มีค่าที่เทียบย้อนหลัง 1 ชั่วโมง",
      incompatible: "ระดับน้ำหรือจุดวัดในกราฟยังไม่ตรงข้อมูลล่าสุด",
      stale: "ข้อมูลล่าสุดเก่าหรือเส้นทางต้นทางยังไม่พร้อม",
    };
    $("forecast-status").textContent = ready
      ? "เทียบกับค่าที่วัดล่าสุดของสถานีนี้"
      : !station
        ? pending
          ? "กำลังค้นหาสถานีและข้อมูลย้อนหลัง…"
          : "รอข้อมูลสถานีของพื้นที่ที่เลือก"
        : !navigator.onLine || forecastRequestFailed
          ? "หยุดคาดการณ์ชั่วคราว · ยังตรวจข้อมูลล่าสุดไม่ได้"
          : pending
            ? "กำลังโหลดกราฟจริงเพื่อคำนวณแนวโน้ม…"
            : `ยังคาดการณ์ไม่ได้ · ${reasons[result?.reason] || "ต้องมีกราฟย้อนหลังที่เทียบได้และค่าตรวจวัดใหม่"}`;
    $("forecast-grid").setAttribute("aria-busy", String(pending));
    $("forecast-grid").replaceChildren(
      ...[1, 3, 6].map((hours) => {
        const point = result?.projections?.find((p) => p.hours === hours);
        const cell = element("article", "forecast-cell");
        cell.append(element("p", "label", `อีก ${hours} ชม.`));
        cell.append(
          element(
            "strong",
            `forecast-level${pending && !ready ? " skeleton skeleton-history" : ""}`,
            ready ? `≈ ${point.level.toFixed(2)} ม.` : pending ? "" : "—",
          ),
        );
        cell.append(
          element(
            "p",
            "muted",
            ready
              ? new Date(point.at).toLocaleString("th-TH", {
                  timeZone: "Asia/Bangkok",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : "ยังไม่มีค่า",
          ),
        );
        if (ready) {
          const delta = Math.round(point.deltaCm * 10) / 10 || 0;
          cell.append(
            element(
              "p",
              "muted",
              `${delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} ซม.`,
            ),
          );
        }
        return cell;
      }),
    );
    $("forecast-basis").textContent = ready
      ? `ตั้งต้น ${result.baseLevel.toFixed(3)} ม. · ${result.datum === "msl" ? "เทียบระดับทะเลปานกลาง" : "เทียบจุดอ้างอิงเฉพาะสถานี"} · วัด ${formatTime(result.anchorAt)} · อัตราเฉลี่ย ${(result.rateMPerHour * 100).toFixed(2)} ซม./ชม. จาก ${result.sampleCount} ค่า ใน ${Math.round(result.actualMinutes)} นาที · คำนวณระดับล่าสุด + อัตรา × เวลาถึงเป้าหมาย`
      : "";
  }
  function paintContext(rain) {
    if (!contextModule || !here) return;
    rain = contextModule.cachedRainfallContext(rain, here, +$("radius").value);
    const tide = contextModule.tideContext(here);
    $("tide-value").textContent =
      tide.status === "available"
        ? `${tide.current.levelMsl.toFixed(2)} เมตร`
        : tide.status === "no_nearby"
          ? "ไม่มีจุดอ้างอิงใกล้พื้นที่"
          : "ไม่มีตารางของช่วงเวลานี้";
    $("tide-station").textContent = tide.station
      ? `${tide.station.name} · ห่าง ${tide.station.distanceKm.toFixed(1)} กม.`
      : "ครอบคลุมปากน้ำแม่กลองและปากน้ำท่าจีน";
    $("tide-detail").textContent = tide.current
      ? `ตามตาราง ${formatTime(tide.current.at)} · เทียบระดับทะเลปานกลาง`
      : "ตรวจตารางล่าสุดจากกรมอุทกศาสตร์";
    $("tide-high").textContent = tide.high
      ? `สูงสุดตามตาราง 24 ชม.ข้างหน้า ${tide.high.levelMsl.toFixed(2)} ม. · ${formatTime(tide.high.at)}`
      : "";
    const station = rain?.station;
    $("rain-value").textContent = station
      ? `${rain.status === "stale" ? "ข้อมูลเก่า · " : ""}${station.rain24hMm.toFixed(1)} มม.`
      : rain?.status === "no_nearby"
        ? "ไม่พบสถานีฝนในรัศมี"
        : rain
          ? "ยังรับข้อมูลฝนไม่ได้"
          : "กำลังโหลดข้อมูลฝน…";
    $("rain-station").textContent = station
      ? `${station.name} · ห่าง ${station.distanceKm.toFixed(1)} กม.`
      : rain?.status === "no_nearby"
        ? `ลองขยายรัศมีจาก ${rain.radiusKm} กม.`
        : "";
    $("rain-time").textContent = station
      ? `สะสม 24 ชม.สิ้นสุด ${formatTime(station.periodEndAt || station.measuredAt)}${station.periodEndAt ? ` · รายงาน ${formatTime(station.measuredAt)}` : ""} · ${station.agency || "ThaiWater"}`
      : rain
        ? "ต้นทางยังไม่พร้อม ลองใหม่ภายหลัง"
        : "";
    const rid = station?.source === "RID";
    $("rain-source-link").href = rid
      ? contextModule.RID_RAIN_PAGE
      : contextModule.RAIN_PAGE;
    $("rain-source-link").textContent = rid
      ? "ตรวจข้อมูลฝนจากกรมชลประทาน ↗"
      : "ตรวจข้อมูลฝนจาก ThaiWater ↗";
  }
  async function loadContext() {
    if (!here || document.hidden || !navigator.onLine) return;
    const location = { lat: here.lat, lon: here.lon },
      radiusKm = +$("radius").value;
    const key = `${location.lat},${location.lon},${radiusKm}`,
      requestId = serial;
    if (contextState?.key === key && contextState.expiresAt > Date.now()) {
      paintContext(contextState.rain);
      return;
    }
    if (contextActive?.key === key) return;
    contextActive?.controller.abort();
    const controller = new AbortController(),
      work = { key, controller };
    contextActive = work;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      contextImport ||= import("./context.js?v=20261004-context-rid");
      contextModule = await contextImport;
      if (requestId !== serial || controller.signal.aborted) return;
      paintContext(contextState?.key === key ? contextState.rain : null);
      let rain;
      try {
        const query = new URLSearchParams({ ...location, radius: radiusKm });
        const response = await fetch(
          `${config.apiBase || ""}/api/context?${query}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
            cache: "no-store",
            headers: { Accept: "application/json" },
          },
        );
        const body = await response.json();
        if (!response.ok || !body.context?.rainfall)
          throw new Error("CONTEXT_UNAVAILABLE");
        rain = body.context.rainfall;
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      if (!rain || rain.status === "unavailable" || rain.status === "stale") {
        const national = await contextModule.browserRainSource.get();
        const browser = contextModule.rainfallContext(
          national,
          location,
          radiusKm,
        );
        if (
          !rain ||
          browser.status === "available" ||
          (rain.status === "unavailable" && browser.station)
        )
          rain = browser;
      }
      if (!rain?.station || rain.status === "stale") {
        const national = await contextModule.browserRidRainSource.get();
        const rid = contextModule.rainfallContext(national, location, radiusKm);
        if (rid.status === "available" || (!rain?.station && rid.station))
          rain = rid;
      }
      if (requestId !== serial || controller.signal.aborted) return;
      contextState = {
        key,
        rain,
        expiresAt:
          Date.now() +
          (rain.status === "available"
            ? (rain.cacheSeconds || 300) * 1000
            : 60000),
      };
      paintContext(rain);
    } catch {
      if (requestId === serial) {
        contextState = {
          key,
          rain:
            contextState?.key === key && contextState.rain.station
              ? { ...contextState.rain, status: "stale" }
              : { status: "unavailable" },
          expiresAt: Date.now() + 60000,
        };
        paintContext(contextState.rain);
      }
    } finally {
      clearTimeout(timeout);
      if (contextActive === work) contextActive = null;
    }
  }
  function paintHistory(row) {
    const response = historyResponses.get(row.station.id);
    const result =
      response?.status === "ready" && historyModule
        ? historyModule.compareHistory(row.station, response.data, {
            sourceStatus: lastData?.source.status,
          })
        : null;
    const fresh =
      lastData?.source.status === "fresh" &&
      row.station.dataQuality === "fresh";
    const pending = fresh && historyPending.has(row.station.id);
    row.grid.setAttribute("aria-busy", String(pending));
    row.grid.replaceChildren(
      ...historyPeriods.map((hours) => {
        const value = result?.comparisons.find((c) => c.hours === hours);
        const cell = element("div", "history-cell");
        cell.append(element("span", "history-period", `${hours} ชม.`));
        const available = value?.status === "available";
        const label = available
          ? `${value.approximate ? "≈ " : ""}${value.direction === "rising" ? "↑ เพิ่ม" : value.direction === "falling" ? "↓ ลด" : "→ คงที่"}${value.deltaCm ? ` ${Math.abs(value.deltaCm).toFixed(1)} ซม.` : ""}`
          : "—";
        const reading = element(
          "strong",
          `history-value ${available ? value.direction : pending ? "skeleton skeleton-history" : "missing"}`,
          !available && pending ? "" : label,
        );
        if (!available && pending) reading.setAttribute("aria-hidden", "true");
        cell.append(reading);
        if (available)
          cell.setAttribute(
            "title",
            `${formatTime(value.baselineAt)} → ${formatTime(result.anchorAt)} · ${value.baselineLevel.toFixed(3)} → ${value.currentLevel.toFixed(3)} เมตร`,
          );
        else
          cell.setAttribute(
            "title",
            pending
              ? "กำลังโหลดข้อมูลย้อนหลัง"
              : "ไม่มีค่าที่เทียบได้ในช่วงเวลานี้",
          );
        return cell;
      }),
    );
    const missing = result?.comparisons?.some((v) => v.status === "missing");
    const approximate = result?.comparisons?.some((v) => v.approximate);
    row.caption.hidden = result?.status === "ready" && !missing && !approximate;
    row.caption.textContent =
      !fresh || result?.status === "stale"
        ? "ข้อมูลล่าสุดเก่าหรือไม่ครบ ยังเทียบการเปลี่ยนแปลงไม่ได้"
        : result?.status === "ready"
          ? `${missing ? "— ไม่มีค่าเทียบ" : ""}${missing && approximate ? " · " : ""}${approximate ? "≈ ใช้เวลาใกล้เคียง" : ""}`
          : pending
            ? "กำลังโหลดข้อมูลย้อนหลัง…"
            : response?.status === "rate_limited"
              ? "ต้นทางจำกัดการเรียกข้อมูลย้อนหลัง จะลองใหม่เมื่อครบเวลารอ"
              : response || result?.status === "incompatible"
                ? "ยังไม่มีข้อมูลย้อนหลังที่เทียบกับจุดวัดนี้ได้"
                : typeof IntersectionObserver === "undefined"
                  ? "กดดูข้อมูลย้อนหลังเพื่อโหลดค่าจริง"
                  : "ข้อมูลย้อนหลังจะโหลดเมื่อเลื่อนมาถึงจุดนี้";
    row.button.hidden = typeof IntersectionObserver !== "undefined" || !fresh;
    row.button.disabled =
      historyPending.has(row.station.id) || response?.expiresAt > Date.now();
    row.facts.replaceChildren();
    if (result?.status === "ready" || result?.anchorFromHistory) {
      row.time.textContent = stationTimeText(
        {
          ...row.station,
          sensorUpdatedAt: result.anchorAt,
        },
        true,
      );
      row.time.setAttribute("datetime", result.anchorAt);
      row.time.setAttribute(
        "title",
        `เวลาวัดของจุดนี้ ${formatTime(result.anchorAt)} · เวลารายงานร่วมของสถานี ${formatTime(result.reportedAt)}`,
      );
    }
    if (result?.status === "ready") {
      if (result.anchorFromHistory)
        row.facts.append(
          element(
            "p",
            "station-note",
            `เวลาวัดจุดนี้ ${formatTime(result.anchorAt)} ต่างจากเวลารายงานร่วมของสถานี ${formatTime(result.reportedAt)} จึงเทียบจากเวลาวัดจริงในกราฟของจุดนี้`,
          ),
        );
      row.facts.append(
        element(
          "p",
          "station-note",
          "เทียบค่าของจุดวัดเดียวกันและระดับอ้างอิงเดียวกัน ใช้ค่าใกล้เวลาเป้าหมายไม่เกิน 15 นาที ไม่ประมาณค่าที่ขาดหาย",
        ),
      );
      const values = element("dl", "station-facts");
      for (const value of result.comparisons) {
        values.append(
          element("dt", "", `ย้อนหลัง ${value.hours} ชม.`),
          element(
            "dd",
            "",
            value.status === "available"
              ? `${formatTime(value.baselineAt)} · ${value.baselineLevel.toFixed(3)} → ${value.currentLevel.toFixed(3)} เมตร${value.approximate ? ` · ช่วงจริง ${(value.actualMinutes / 60).toFixed(2)} ชม.` : ""}`
              : "ไม่มีค่าภายในช่วงเวลาที่เทียบได้",
          ),
        );
      }
      row.facts.append(values);
    }
  }
  async function loadHistory(id) {
    const row = historyRows.get(id),
      old = historyResponses.get(id),
      station = row?.station || lastData?.stations.find((s) => s.id === id);
    if (
      !station ||
      document.hidden ||
      lastData?.source.status !== "fresh" ||
      station.dataQuality !== "fresh" ||
      historyPending.has(id) ||
      old?.expiresAt > Date.now()
    )
      return;
    historyPending.add(id);
    if (row) paintHistory(row);
    paintForecast();
    try {
      historyImport ||= Promise.all([
        import("./history.js?v=20261004-forecast"),
        import("./forecast.js?v=20261004-forecast"),
      ]);
      [historyModule, forecastModule] = await historyImport;
      const response = await historyModule.historySource.get(station);
      if (historyResponses.size >= 256 && !historyResponses.has(id))
        historyResponses.delete(historyResponses.keys().next().value);
      historyResponses.set(id, response);
    } catch {
      historyResponses.set(id, {
        status: "unavailable",
        expiresAt: Date.now() + 60000,
      });
    } finally {
      historyPending.delete(id);
      if (historyRows.has(id)) paintHistory(historyRows.get(id));
      if (lastData?.stations[0]?.id === id) paintRate();
      else if (forecastStationId === id) paintForecast();
    }
  }
  function appendRoute(card, s, expanded) {
    const route = s.waterRoute || {
      status: "unknown",
      summary: "ยังไม่มีข้อมูลเส้นทางน้ำของจุดนี้",
      origin: "ยังยืนยันต้นทางของจุดนี้ไม่ได้",
      nodes: [],
      sources: [],
    };
    const preview = element("div", "station-route-preview");
    if (route.status === "documented")
      preview.append(element("strong", "", route.waterway));
    preview.append(
      element(
        "p",
        "",
        route.status === "documented" ? route.summary : route.origin,
      ),
    );
    // Keep the documented route in its disclosure instead of repeating its prose.

    const details = element("details", "station-route-details");
    details.open = expanded.has(`${s.id}:route`);
    details.append(
      element("summary", "", "น้ำจุดนี้มาจากไหน"),
      element("p", "route-summary", route.summary),
    );
    if (route.nodes?.length) {
      const path = element("ol", "water-route");
      route.nodes.forEach((name, i) => {
        const node = element(
          "li",
          name.includes("จุดวัด") ? "route-current" : "",
        );
        if (i) {
          const arrow = element("span", "route-arrow", route.connector || "→");
          arrow.setAttribute("aria-hidden", "true");
          node.append(arrow);
        }
        node.append(element("span", "", name));
        path.append(node);
      });
      details.append(path);
    }
    details.append(preview);
    const facts = element("dl", "station-facts");
    facts.append(
      element(
        "dt",
        "",
        route.kind === "connection" ? "ฝั่งที่เชื่อมกัน" : "ต้นทางหลัก",
      ),
      element("dd", "", route.origin),
    );
    if (route.destination)
      facts.append(
        element("dt", "", "ปลายทาง / การเชื่อมต่อ"),
        element("dd", "", route.destination),
      );
    details.append(facts);
    if (route.note) details.append(element("p", "station-note", route.note));
    const links = element("div", "route-sources");
    for (const source of route.sources || []) {
      if (!/^https:\/\//.test(source.url)) continue;
      const link = element("a", "", source.label);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    details.append(links);
    card.append(details);
    stationDetails.push({ id: `${s.id}:route`, node: details });
  }
  function renderStations() {
    const rows = lastData?.stations || [];
    for (const { node, station } of stationTimes)
      node.textContent = stationTimeText(station);
    const fingerprint = JSON.stringify(rows) + shown + lastData?.source.status;
    if (fingerprint === stationFingerprint) {
      for (const [id, row] of historyRows) {
        paintHistory(row);
        if (visibleHistory.has(id)) void loadHistory(id);
      }
      return;
    }
    stationFingerprint = fingerprint;
    const expanded = new Set(
      stationDetails.filter(({ node }) => node.open).map(({ id }) => id),
    );
    stationTimes = [];
    stationDetails = [];
    historyObserver?.disconnect();
    historyRows = new Map();
    visibleHistory = new Set();
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
        `ห่าง ${s.distanceKm.toFixed(1)} กม.`,
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
      const history = element("div", "station-history");
      history.append(element("p", "history-heading", "เทียบย้อนหลัง"));
      const grid = element("div", "history-grid"),
        caption = element("p", "history-caption"),
        historyFacts = element("div", "history-facts");
      const historyButton = element(
        "button",
        "history-button",
        "ดูข้อมูลย้อนหลัง",
      );
      historyButton.type = "button";
      historyButton.setAttribute("aria-label", `ดูข้อมูลย้อนหลัง ${s.name}`);
      historyButton.onclick = () => void loadHistory(s.id);
      history.append(grid, caption, historyButton);
      card.append(history);
      const historyRow = {
        station: s,
        grid,
        caption,
        facts: historyFacts,
        button: historyButton,
        time,
      };
      historyRows.set(s.id, historyRow);
      paintHistory(historyRow);
      appendRoute(card, s, expanded);
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
        [
          s.source === "RID" ? "เวลารายงานของสถานี" : "ตรวจวัดเมื่อ",
          formatTime(s.sensorUpdatedAt),
        ],
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
        historyFacts,
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
    if (typeof IntersectionObserver !== "undefined") {
      historyObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = entry.target.getAttribute("data-station-id");
            if (entry.isIntersecting) {
              visibleHistory.add(id);
              void loadHistory(id);
            } else visibleHistory.delete(id);
          }
        },
        { rootMargin: "160px" },
      );
      for (const card of cards) historyObserver.observe(card);
    }
    $("show-more").hidden = shown >= rows.length;
  }
  function render(data) {
    forecastRequestFailed = false;
    lastData = data;
    assessment(data.assessment);
    const sourceName = data.source.name?.includes(" + ")
      ? "ThaiWater + กรมชลประทาน"
      : data.source.name?.startsWith("RID")
        ? "กรมชลประทาน"
        : data.source.name?.startsWith("ThaiWater")
          ? "ThaiWater"
          : data.source.name || "ข้อมูลสถานี";
    $("source-status").textContent =
      data.source.status === "fresh"
        ? "● รับข้อมูลแล้ว"
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
          ? `${data.stations.length} สถานี · ${data.stations.filter((s) => s.dataQuality === "fresh").length} จุดมีข้อมูลล่าสุด${data.stations.some((s) => s.dataQuality !== "fresh") ? " · สีเทาคือข้อมูลเก่า/ไม่ครบ" : ""}`
          : "ไม่พบสถานีในรัศมีนี้ ลองขยายรัศมีหรือเลือกพื้นที่อื่น";
    if (data.source.partial)
      $("data-status").textContent += " · รายการอาจยังไม่ครบ";
    $("source-details").hidden = false;
    $("source-detail").textContent =
      `${data.source.name || sourceName} · ${data.source.message || "ข้อมูลจากหน่วยงานเจ้าของสถานี"}${data.source.fetchedAt ? " · แอปรับข้อมูลเมื่อ " + formatTime(data.source.fetchedAt) : ""}`;
    if (data.source.sources)
      $("source-detail").textContent +=
        " · " +
        data.source.sources
          .map(
            (s) =>
              `${s.name}: ${{ fresh: "เชื่อมต่อได้", stale: "ข้อมูลที่เก็บไว้", unavailable: "ยังไม่พร้อม" }[s.status] || s.status}${s.transport === "browser" ? " ผ่านเบราว์เซอร์" : ""}`,
          )
          .join(" · ");
    const s = data.stations[0];
    $("nearest").textContent =
      s?.name || (unavailable ? "ยังไม่มีข้อมูล" : "ไม่พบสถานี");
    $("near-distance").textContent = s
      ? `${s.distanceKm.toFixed(1)} กม. · ${stationState(s).label}`
      : unavailable
        ? "ต้นทางไม่พร้อมใช้งาน"
        : "ลองขยายรัศมีค้นหา";
    $("near-level").textContent = s ? levelText(s) : "—";
    $("sensor-time").textContent = s
      ? `${s.source === "RID" ? "สถานีรายงาน" : "ตรวจวัด"}: ${formatTime(s.sensorUpdatedAt)}`
      : "เวลาตรวจวัด: —";
    $("checked-time").textContent =
      `หน้าเว็บตรวจล่าสุด: ${formatTime(data.checkedAt)}`;
    $("fetched-time").textContent =
      `แอปรับข้อมูลต้นทาง: ${formatTime(data.updatedAt)}`;
    renderStations();
    if (s) void loadHistory(s.id);
    if (forecastStationId && forecastStationId !== s?.id)
      void loadHistory(forecastStationId);
    paintRate();
    void loadContext();
    updateMap(data.stations);
  }
  function schedule(delay = 5000) {
    clearTimeout(timer);
    if (here && !document.hidden && navigator.onLine)
      timer = setTimeout(load, delay);
  }
  function initLoading() {
    $("stations-loading").replaceChildren(
      ...Array.from({ length: 6 }, () => {
        const card = element("div", "station station-skeleton");
        for (const shape of [
          "heading",
          "line skeleton-short",
          "badge",
          "reading",
          "line",
          "line skeleton-short",
        ])
          card.append(element("span", `skeleton skeleton-${shape}`));
        const grid = element("div", "history-grid");
        for (let i = 0; i < 4; i++)
          grid.append(element("span", "skeleton skeleton-tile"));
        card.append(grid, element("span", "skeleton skeleton-line"));
        return card;
      }),
    );
  }
  function setLoading(busy) {
    const initial = busy && !lastData;
    $("stations-loading").hidden = !initial;
    $("assessment-loading").hidden = !initial;
    $("assessment-result").hidden = initial;
    $("station-readings").setAttribute("aria-busy", String(busy));
    $("observations").setAttribute("aria-busy", String(busy));
    $("observations").setAttribute("data-loading", String(initial));
    $("refresh").disabled = busy;
    $("refresh").textContent = busy ? "กำลังโหลด…" : "↻ ตรวจใหม่";
    paintForecast();
  }
  async function load() {
    clearTimeout(timer);
    if (!here || document.hidden || active) return;
    if (!navigator.onLine) {
      showOffline();
      return;
    }
    const requestId = serial;
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), 65000);
    setLoading(true);
    if (!lastData) {
      $("source-status").textContent = "● กำลังโหลดข้อมูล";
      $("source-status").className = "badge gray";
      $("data-status").textContent =
        "กำลังตรวจข้อมูลสถานี… การเชื่อมต่อครั้งแรกอาจใช้เวลาประมาณหนึ่งนาที";
    }
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
          const { browserSource } = await import(
            "./browser-source.js?v=20261004-context-rid"
          );
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
      const ridStatus = data.source.sources?.find(
        (s) => s.name === "RID",
      )?.status;
      if (
        (ridStatus && ridStatus !== "fresh") ||
        (!data.source.sources && data.source.name?.startsWith("ThaiWater"))
      ) {
        try {
          const { browserRidSource, mergeWaterResponses } = await import(
            "./browser-source.js?v=20261004-context-rid"
          );
          const rid = await browserRidSource.get({
            location: { lat: here.lat, lon: here.lon },
            radiusKm: +$("radius").value,
            version: data.version,
            signal: controller.signal,
          });
          if (requestId !== serial) return;
          data = mergeWaterResponses(data, rid);
        } catch (error) {
          if (requestId !== serial) return;
          if (controller.signal.aborted) throw error;
          data.source.partial = true;
          data.source.message +=
            " · ยังเติมสถานี RID ไม่สำเร็จ รายการสถานีอาจไม่ครบ";
        }
      }
      render(data);
    } catch (error) {
      if (requestId !== serial) return;
      forecastRequestFailed = true;
      paintForecast();
      $("source-status").textContent = "● ยังตรวจข้อมูลล่าสุดไม่ได้";
      $("source-status").className = "badge yellow";
      assessment({
        score: null,
        level: "unknown",
        confidence: "insufficient",
        label: "ยังตรวจข้อมูลล่าสุดไม่ได้",
        reasons: [
          lastData
            ? "ค่าที่เห็นเป็นข้อมูลจากการตรวจครั้งก่อน กรุณาตรวจอีกครั้งเมื่อเชื่อมต่อได้"
            : "ยังไม่มีข้อมูลสถานี กรุณาตรวจอีกครั้งเมื่อเชื่อมต่อได้",
        ],
      });
      $("data-status").textContent =
        (error.name === "AbortError"
          ? "การเชื่อมต่อใช้เวลานาน กรุณาตรวจอีกครั้ง"
          : "เชื่อมต่อข้อมูลไม่สำเร็จ ระบบจะลองตรวจอีกครั้ง") +
        (lastData ? " · ข้อมูลที่แสดงอาจเก่าแล้ว" : "");
    } finally {
      clearTimeout(timeout);
      if (active === controller) {
        active = null;
        setLoading(false);
        schedule();
      }
    }
  }
  function resetRequest() {
    serial++;
    if (active) active.abort();
    contextActive?.controller.abort();
    contextActive = null;
    active = null;
    clearTimeout(timer);
    setLoading(false);
  }
  function setLocation(location) {
    locationSerial++;
    resetRequest();
    here = location;
    lastData = null;
    forecastStationId = null;
    forecastRequestFailed = false;
    paintForecast();
    contextState = null;
    shown = 6;
    $("place").textContent = here.label.replace(/^จุดอ้างอิง/, "");
    $("coords").textContent =
      `${here.lat.toFixed(5)}, ${here.lon.toFixed(5)}${here.accuracy != null ? ` · คลาดเคลื่อน ±${Math.round(here.accuracy)} ม.` : here.default ? " · จุดอ้างอิงเริ่มต้น" : here.reference ? " · จุดอ้างอิงพื้นที่" : " · พิกัดที่เลือกเอง"}${here.reference ? ` · จุดอ้างอิง: ${here.reference}` : ""}`;
    $("location-status").textContent =
      here.accuracy != null
        ? "ได้รับตำแหน่ง GPS แล้ว"
        : here.default
          ? "จุดอ้างอิงดำเนินสะดวกอัตโนมัติ · ไม่ใช่ GPS"
          : "จุดอ้างอิงพื้นที่ · ไม่ใช่ GPS ของคุณ";
    $("manual-lat").value = here.lat;
    $("manual-lon").value = here.lon;
    $("nearest").textContent = $("near-level").textContent = "—";
    $("near-distance").textContent = "กำลังค้นหาสถานี";
    $("sensor-time").textContent = "เวลาตรวจวัด: —";
    $("rise-rate").textContent = "ยังไม่มีค่าต่อชั่วโมง";
    $("trend").textContent = "ต้องมีเวลาตรวจวัดสองครั้ง";
    $("rain-value").textContent = "กำลังโหลดข้อมูลฝน…";
    $("tide-value").textContent = "กำลังอ่านตารางน้ำ…";
    for (const id of [
      "rain-station",
      "rain-time",
      "tide-station",
      "tide-detail",
      "tide-high",
    ])
      $(id).textContent = "";
    $("checked-time").textContent = "หน้าเว็บตรวจล่าสุด: —";
    $("fetched-time").textContent = "แอปรับข้อมูลต้นทาง: —";
    $("station-count").textContent = "กำลังค้นหา";
    $("source-details").hidden = true;
    assessment();
    renderStations();
    updateMap([]);
    void loadContext();
    load();
  }
  function locationUnavailable(reason) {
    if (!here) setLocation({ ...presets.damnoen, default: true });
    $("location-status").textContent =
      `${reason} · ${here.default ? "ใช้จุดอ้างอิงดำเนินสะดวกอัตโนมัติ · ไม่ใช่ GPS" : "ยังใช้พื้นที่เดิม"}`;
  }
  function locate() {
    if (requestingGps) return;
    if (!navigator.geolocation || !window.isSecureContext) {
      locationUnavailable(
        "เบราว์เซอร์นี้ไม่รองรับ GPS หรือไม่ได้เปิดผ่าน HTTPS",
      );
      return;
    }
    requestingGps = true;
    $("locate").disabled = true;
    $("location-status").textContent = "กำลังขออนุญาตและค้นหาตำแหน่ง GPS…";
    const gpsSerial = locationSerial;
    let finished = false,
      gpsTimeout;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(gpsTimeout);
      requestingGps = false;
      $("locate").disabled = false;
      return gpsSerial === locationSerial;
    };
    const fail = (error) => {
      if (!finish()) return;
      locationUnavailable(
        {
          1: "ไม่ได้รับอนุญาตใช้ตำแหน่ง",
          2: "ไม่สามารถหาตำแหน่ง GPS ได้",
          3: "การค้นหาตำแหน่ง GPS หมดเวลา",
        }[error?.code] || "อ่านตำแหน่งไม่ได้",
      );
    };
    // Browser GPS timeouts can exclude time spent waiting for permission.
    gpsTimeout = setTimeout(() => fail({ code: 3 }), 15000);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (!finish()) return;
          setLocation({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracy: position.coords.accuracy,
            label: "ตำแหน่ง GPS ปัจจุบัน",
          });
        },
        fail,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
      );
    } catch (error) {
      fail(error);
    }
  }
  $("locate").onclick = locate;
  $("manual-toggle").onclick = () => {
    const open = $("manual-location").hidden;
    $("manual-location").hidden = !open;
    $("manual-toggle").setAttribute("aria-expanded", String(open));
    if (open) {
      paintAreaChoices();
      $("area-search").focus?.();
    }
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
    ) {
      setLocation({ lat, lon, label: "พิกัดที่เลือกเอง" });
      closeAreaPicker();
    }
  };
  $("refresh").onclick = () => load();
  $("forecast-station").onchange = () => {
    forecastStationId = $("forecast-station").value;
    paintForecast();
    void loadHistory(forecastStationId);
  };
  $("radius").onchange = () => {
    if (!here) return;
    setLocation({ ...here });
  };
  $("show-more").onclick = () => {
    shown += 6;
    renderStations();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resetRequest();
    } else load();
  });
  function showOffline() {
    resetRequest();
    forecastRequestFailed = true;
    paintForecast();
    $("data-status").textContent = lastData
      ? "ออฟไลน์ ข้อมูลที่แสดงเป็นการตรวจครั้งก่อน"
      : "ออฟไลน์ เชื่อมต่ออินเทอร์เน็ตเพื่อโหลดข้อมูลสถานี";
    assessment({
      score: null,
      level: "unknown",
      label: "ออฟไลน์ ยังตรวจข้อมูลล่าสุดไม่ได้",
      confidence: "insufficient",
      reasons: ["เชื่อมต่ออินเทอร์เน็ตเพื่อตรวจข้อมูลอีกครั้ง"],
    });
    $("source-status").textContent = "● ออฟไลน์";
    $("source-status").className = "badge yellow";
  }
  window.addEventListener("offline", showOffline);
  window.addEventListener("online", load);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("manual-location").hidden)
      closeAreaPicker();
  });
  initAreaPicker();
  initMap();
  initLoading();
  locate();
})();
