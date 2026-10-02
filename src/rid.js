import WebSocket from "ws";
export { normalizeRid } from "../assets/rid-water.js";

export const RID_URL = "wss://telerid.rid.go.th/ws/public/";

// The official dashboard consumes this public INIT snapshot. One bounded connection
// retrieves it for the shared server cache and closes immediately.
export function fetchRidSnapshot({
  timeoutMs = 30000,
  logger = console,
  Socket = WebSocket,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(RID_URL, {
      handshakeTimeout: timeoutMs,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    let settled = false,
      opened = false;
    const startedAt = Date.now();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.terminate) socket.terminate();
      else socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            opened ? "UPSTREAM_SNAPSHOT_TIMEOUT" : "UPSTREAM_CONNECT_TIMEOUT",
          ),
        ),
      timeoutMs,
    );
    socket.on?.("unexpected-response", (_request, response) => {
      const error = new Error(`UPSTREAM_HTTP_${response.statusCode}`);
      error.status = response.statusCode;
      error.retryAfter = response.headers["retry-after"];
      response.destroy();
      finish(error);
    });
    socket.addEventListener("open", () => {
      opened = true;
      logger.info(
        JSON.stringify({
          event: "rid_connection_open",
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
    socket.addEventListener("error", (event) => {
      if (settled) return;
      logger.warn(
        JSON.stringify({
          event: "rid_connection_error",
          elapsedMs: Date.now() - startedAt,
          message: String(event.message || event.error?.message || "").slice(
            0,
            200,
          ),
        }),
      );
      const cause = event.error?.cause?.code || event.error?.code;
      const code =
        typeof cause === "string" && /^[A-Z_0-9]+$/.test(cause)
          ? cause
          : "REQUEST_FAILED";
      finish(new Error(`UPSTREAM_${code}`));
    });
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("UPSTREAM_CLOSED"));
    });
    socket.addEventListener("message", (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > 8 * 1024 * 1024
        )
          throw new Error("UPSTREAM_TOO_LARGE");
        const envelope = JSON.parse(event.data);
        const payload =
          typeof envelope.message === "string"
            ? JSON.parse(envelope.message)
            : null;
        if (payload?.type === "INIT") finish(null, payload);
      } catch {
        finish(new Error("UPSTREAM_SCHEMA_INVALID"));
      }
    });
  });
}
