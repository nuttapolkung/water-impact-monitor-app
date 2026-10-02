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
  function renderStations() {
    const rows = lastData?.stations || [];
    const fingerprint = JSON.stringify(rows) + shown;
    if (fingerprint === stationFingerprint) return;
    stationFingerprint = fingerprint;
    const cards = rows.slice(0, shown).map((s) => {
      const card = document.createElement("article");
      card.className = "station";
      const head = document.createElement("div");
      head.className = "station-head";
      const name = document.createElement("h3");
      name.textContent = s.name;
      const badge = document.createElement("span");
      badge.className = `badge ${s.dataQuality === "fresh" ? s.color : "gray"}`;
      badge.textContent = qualityText(s);
      head.append(name, badge);
      card.append(head);
      const reading = document.createElement("div");
      reading.className = "reading";
      reading.textContent = levelText(s);
      card.append(reading);
      const gap =
        s.warningLevel != null && s.criticalLevel != null
          ? `เฝ้าระวัง ${s.warningLevel.toFixed(2)} · วิกฤติ ${s.criticalLevel.toFixed(2)} ${s.thresholdDatum === "msl" ? "ม.รทก." : "ม. ระดับเฉพาะสถานี"}`
          : s.bankGapM === null
            ? "ไม่มีระดับตลิ่งอ้างอิง"
            : `${s.bankGapM > 0 ? "ต่ำกว่าตลิ่ง" : "ถึงหรือเกินตลิ่ง"} ${Math.abs(s.bankGapM).toFixed(2)} ม. ที่สถานี`;
      for (const text of [
        `${s.distanceKm.toFixed(1)} กม. · ${s.river || s.basin || s.province || "ไม่ระบุลำน้ำ"}`,
        trendText(s),
        gap,
        `ตรวจวัด: ${formatTime(s.sensorUpdatedAt)}`,
        `${s.source} · ${s.agency || "ไม่ระบุหน่วยงาน"}${s.code ? " · " + s.code : ""}`,
      ]) {
        const p = document.createElement("p");
        p.textContent = text;
        card.append(p);
      }
      if (map) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "station-button";
        button.textContent = "ดูสถานีนี้บนแผนที่";
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
    $("source-status").textContent =
      data.source.status === "fresh"
        ? `● ${data.source.fallback ? "ข้อมูลสำรอง " : ""}${data.source.name}`
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
        ? `${data.source.message}${data.source.fetchedAt ? " • ข้อมูลที่เก็บไว้เมื่อ " + formatTime(data.source.fetchedAt) : ""}`
        : data.stations.length
          ? `${data.source.message} • พบ ${data.stations.length} จุดตรวจวัดในรัศมี ${data.radiusKm} กม. สีเทาคือข้อมูลเก่าหรือไม่ครบ`
          : "ไม่พบสถานีในรัศมีนี้ ลองขยายรัศมีหรือเลือกพื้นที่อื่น";
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
