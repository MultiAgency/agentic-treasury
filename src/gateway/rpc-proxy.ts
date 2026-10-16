import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { sendJson as json } from "../http.js";
import type { AgentEntry } from "./config.js";

export const RPC_IDLE_TIMEOUT_MS = 15 * 60_000;

/** Forwards a call to an agent server on loopback, streaming both ways (some procedures stream events). */
export function forwardRpc(req: IncomingMessage, res: ServerResponse, agent: AgentEntry, path: string, timeoutMs = RPC_IDLE_TIMEOUT_MS) {
  const headers = { ...req.headers, host: `127.0.0.1:${agent.port}` };
  delete headers.origin;
  delete headers.cookie;
  const upstream = request({ host: "127.0.0.1", port: agent.port, path: `/rpc/${path}`, method: req.method, headers }, (answer) => {
    if ((answer.statusCode ?? 500) >= 300 && (answer.statusCode ?? 500) < 400) {
      answer.resume();
      return json(res, 502, { error: "Agent backend redirected. Check the original record before retrying." });
    }
    res.writeHead(answer.statusCode ?? 502, { ...answer.headers, "cache-control": "private, no-store" });
    answer.on("error", () => res.destroy());
    answer.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: "Agent backend unavailable. A submitted request may have been accepted; check its original record before retrying." });
  });
  // Settlement may wait 180 seconds per leg, with several legs before a response.
  // Allow fifteen minutes of inactivity; longer work remains recoverable by its record.
  // Bound inactivity, not total stream duration. A timeout never establishes non-execution.
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("Agent backend timed out")));
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}
