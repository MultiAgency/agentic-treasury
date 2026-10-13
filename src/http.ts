import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

/** A body the client got wrong: answered 400, unlike a failure on this side. */
export class BadRequest extends Error {}

/** A JSON answer, never cached: every one may carry a member's or payee's data. */
export const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));

/** What every public answer says to browsers about itself; see the gateway for why each matters. */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
};

/** A request a page on another site sent: its Origin names another host, or is malformed (`null`). */
export const crossSite = (req: IncomingMessage, host = req.headers.host) =>
  req.headers.origin !== undefined && URL.parse(req.headers.origin)?.host !== host;

/**
 * The answer to a request that failed: the client's own mistake as a 400 with its reason, anything
 * else as a 500 that shows no internals (they stay in this process's log).
 */
export function sendFailure(res: ServerResponse, error: unknown) {
  // A failure after the answer started can't change it: end it rather than crash the server.
  if (res.headersSent) return void res.end();
  if (error instanceof BadRequest) return sendJson(res, 400, { error: error.message });
  console.error(error);
  sendJson(res, 500, { error: "Something went wrong. Try again later." });
}

/** A request's JSON object body, at most 16 KB; anything but an object reads as `{}`. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) throw new BadRequest("The request is too large.");
  }
  try {
    const value: unknown = JSON.parse(text || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    throw new BadRequest("The request isn't valid JSON.");
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Serves the built dashboard: a path without an extension is a client route, answered with index.html. */
export async function serveStatic(res: ServerResponse, dist: string, pathname: string, notFound = "Not found") {
  // URL parsing resolves dot segments, so the path cannot climb out of dist.
  const file = join(dist, extname(pathname) ? pathname : "index.html");
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    return res.writeHead(404).end(notFound);
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(content);
}
