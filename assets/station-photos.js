(() => {
  "use strict";
  // Curated against provider ID, code and coordinates, never a fuzzy name match.
  // Source checked 4 Oct 2026: the public municipality page displays this photo.
  // No capture date or camera angle is published; this is not a live image.
  const bangNokKhwaek = Object.freeze({
    url: "https://bnk.go.th/public/list_upload/backend/list_77/pics_121_1.jpg",
    sourceUrl:
      "https://bnk.go.th/public/list/data/detail/id/77/menu/1545/page/1",
    sourceLabel: "เทศบาลตำบลบางนกแขวก",
    alt: "ภาพมุมสูงประตูน้ำบางนกแขวก จากเทศบาลตำบลบางนกแขวก",
    caption: "ภาพสถานที่ · ไม่ใช่ภาพสด · ไม่ระบุวันที่ถ่าย",
    note: "ภาพรวมประตูน้ำ ไม่ระบุมุมของจุดวัดเหนือน้ำหรือท้ายน้ำ · กล้องสด: ยังไม่พบแหล่งสาธารณะที่ยืนยันตรงประตูน้ำนี้",
  });
  window.WATER_STATION_PHOTO = (station) => {
    if (
      station?.source !== "RID" ||
      station.stationId !== "rid:383" ||
      station.code?.split("/")[0] !== "TMK03" ||
      !Number.isFinite(station.lat) ||
      !Number.isFinite(station.lon) ||
      Math.abs(station.lat - 13.500218) > 0.001 ||
      Math.abs(station.lon - 99.9273112) > 0.001
    )
      return null;
    return bangNokKhwaek;
  };
})();
