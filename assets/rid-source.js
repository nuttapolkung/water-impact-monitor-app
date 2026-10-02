export const RID_URL = "wss://telerid.rid.go.th/ws/public/";

// Read one public national INIT snapshot, then close. No location, subscription
// message, credentials or persistent connection is supplied by this client.
function readRidSocket(
  url,
  accept,
  { signal, timeoutMs = 10000, Socket = WebSocket } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(url);
    let settled = false;
    const finish = (error, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.close();
      if (error) reject(error);
      else resolve(payload);
    };
    const abort = () =>
      finish(new DOMException("Request aborted", "AbortError"));
    const timer = setTimeout(
      () => finish(new Error("RID_SNAPSHOT_TIMEOUT")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("error", () =>
      finish(new Error("RID_CONNECTION_FAILED")),
    );
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("RID_CLOSED"));
    });
    socket.addEventListener("message", (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > 8 * 1024 * 1024 ||
          new TextEncoder().encode(event.data).byteLength > 8 * 1024 * 1024
        )
          throw new Error("RID_PAYLOAD_INVALID");
        const envelope = JSON.parse(event.data);
        const payload =
          typeof envelope.message === "string"
            ? JSON.parse(envelope.message)
            : null;
        if (accept(payload)) finish(null, payload);
      } catch (error) {
        finish(error);
      }
    });
    if (signal?.aborted) abort();
  });
}

export function fetchRidBrowserSnapshot(options = {}) {
  return readRidSocket(RID_URL, (p) => p?.type === "INIT", options);
}

// This is the public station-detail socket used by the official dashboard.
// It provides timestamped graph values for each separate gauge point.
export function fetchRidBrowserStation({ stationId, ...options } = {}) {
  if (!/^\d{1,8}$/.test(String(stationId)))
    return Promise.reject(new Error("HISTORY_STATION_INVALID"));
  return readRidSocket(
    `wss://telerid.rid.go.th/ws/station/${stationId}/`,
    (p) => !p?.type && p?.values && Array.isArray(p.cross_section),
    options,
  );
}
