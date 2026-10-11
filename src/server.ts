import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { RPCHandler } from "@orpc/server/node";
import { startAutopilot } from "./autopilot.js";
import { startReconciliation } from "./recover.js";
import { router } from "./router.js";

const PORT = Number(process.env.PORT ?? 8787);
const DIST = "web/dist";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const handler = new RPCHandler(router);

// This process holds the agent's grant: answer only same-origin requests on loopback.
createServer(async (req, res) => {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (origin && new URL(origin).host !== host)) {
    res.writeHead(403).end();
    return;
  }
  const { matched } = await handler.handle(req, res, { prefix: "/rpc" });
  if (matched) return;

  // URL parsing resolves dot segments, so the path cannot climb out of DIST.
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const file = join(DIST, extname(pathname) ? pathname : "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found. Run `pnpm build:web` first, or use `pnpm web` in development.");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Treasury dashboard on http://localhost:${PORT}`);
  // Ticks only once the owner turns the autopilot on and an agent exists.
  if (process.env.AGENT_ID) { startReconciliation(); startAutopilot(); }
});
