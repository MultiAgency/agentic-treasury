import type { ServerResponse } from "node:http";
import { extname } from "node:path";
import { compatibleRelease } from "../payee-contract.js";
import { sendJson } from "../http.js";

export type OwnerFrontend = { origin: string; product: string; provided: readonly string[] };
const LIMIT = 8 * 1024 * 1024;
const CSP = "frame-ancestors 'none'; default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https:; connect-src 'self' https: wss:; frame-src https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** HTTPS, or loopback HTTP for development; never credentials, a path, query or fragment. */
export function frontendOrigin(value: string): URL {
  const base = new URL(value);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
    !(base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))) throw new Error("Invalid frontend origin");
  return base;
}

const unavailable = (res: ServerResponse, product: string) => sendJson(res, 503, { error: `The ${product} interface is unavailable or incompatible with this platform. Your records and any submitted actions are unchanged; reload later and check an action's existing status before repeating it.` });
const get = async (base: URL, path: string) => {
  const answer = await fetch(new URL(path, base), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const bytes = Buffer.from(await answer.arrayBuffer());
  if (bytes.byteLength > LIMIT) throw new Error("Frontend asset too large");
  return { answer, bytes };
};

/**
 * Presentation only, from the owner app's own release process. The release server resolves its declared
 * entries; platform routes never reach this function. Cookies and authorization headers are never sent.
 * HTML is served only when the release's contract is compatible and names the same release (`x-release-id`)
 * as the HTML itself, so a pointer switch between the two reads cannot pass an unchecked release.
 * Returns false when the release has no such file, so the caller may serve Proto's shared consent assets.
 */
export async function serveOwnerFrontend(res: ServerResponse, path: string, frontend: OwnerFrontend): Promise<boolean> {
  try {
    const base = frontendOrigin(frontend.origin);
    const { answer, bytes } = await get(base, path);
    if (answer.status === 404) return false;
    if (!answer.ok) throw new Error("Frontend unavailable");
    const type = answer.headers.get("content-type") ?? "application/octet-stream";
    // Page routes, any HTML answer and the app's own skill pass the contract check; content type cannot skip it.
    if (type.startsWith("text/html") || !extname(path) || path === "/skill.md") {
      const release = answer.headers.get("x-release-id");
      const contract = await get(base, "/contract.json");
      if (!release || !contract.answer.ok || contract.answer.headers.get("x-release-id") !== release ||
        !compatibleRelease(JSON.parse(contract.bytes.toString("utf8")), frontend.product, frontend.provided)) throw new Error("Unsupported or unbound release");
    }
    res.writeHead(200, { "content-type": type, "cache-control": answer.headers.get("cache-control") ?? "no-store", "x-content-type-options": "nosniff", "content-security-policy": CSP })
      .end(bytes);
  } catch {
    unavailable(res, frontend.product);
  }
  return true;
}
