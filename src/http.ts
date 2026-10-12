import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

/** A body the client got wrong: answered 400, unlike a failure on this side. */
export class BadRequest extends Error {}

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
