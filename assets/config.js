// Keep the existing Render static URL. The existing Node service owns /api/water.
// A local or single-service Node deployment uses its own origin automatically.
window.WATER_CONFIG = {
  apiBase:
    location.hostname === "water-impact-monitor.onrender.com"
      ? "https://water-impact-monitor-app.onrender.com"
      : "",
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
};
