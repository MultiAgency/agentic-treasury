import { compatiblePayeeFrontend } from "../payee-contract.js";
import type { ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import { frontendOrigin } from "./owner-frontend.js";

/**
 * Presentation only. API traffic and cookies never reach the independent frontend service. Page paths are
 * forwarded as logical entries, which both the release's own server and the shared release server resolve.
 */
export function payeeAsset(path: string): string | null {
  if (["/", "/submit", "/submit/", "/report", "/report/", "/invoice-browser.js", "/skill.md"].includes(path)) return path;
  if (/^\/invoice-ui\/static\/[a-zA-Z0-9_./-]+\.(js|css|woff2?|svg|png|ico)$/.test(path) && !path.split("/").includes("..")) return path;
  return null;
}
const get = async (base: URL, path: string) => {
  const answer = await fetch(new URL(path, base), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const bytes = Buffer.from(await answer.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Frontend asset too large");
  return { answer, bytes, release: answer.headers.get("x-release-id") };
};
export async function servePayeeFrontend(res: ServerResponse, path: string, origin = process.env.INVOICES_FRONTEND_URL): Promise<boolean> {
  const asset = payeeAsset(path);
  if (!origin || !asset) return false;
  try {
    const base = frontendOrigin(origin);
    const page = await get(base, asset);
    // The app's skill is part of its release: absent means 404, never another copy.
    if (asset === "/skill.md" && page.answer.status === 404) { sendJson(res, 404, { error: "Not found" }); return true; }
    if (!page.answer.ok) throw new Error("Frontend unavailable");
    // Page entries always pass the contract check; the decision never depends on a response header.
    const html = !asset.startsWith("/invoice-ui/") && asset !== "/invoice-browser.js" && asset !== "/skill.md";
    const type = html ? "text/html; charset=utf-8" : page.answer.headers.get("content-type") ?? "application/octet-stream";
    if (html || asset === "/skill.md") {
      // A release server names its release on every response: the checked contract must be the served page's.
      const contract = await get(base, "/contract.json");
      if (!contract.answer.ok || !compatiblePayeeFrontend(JSON.parse(contract.bytes.toString("utf8"))) ||
        ((page.release || contract.release) && page.release !== contract.release)) throw new Error("Unsupported or unbound frontend release");
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "frame-ancestors 'none'; default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https:; connect-src 'self' https: wss:; frame-src https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" }).end(page.bytes);
  } catch {
    sendJson(res, 503, { error: "Invoices interface unavailable. Your existing records remain with the executor. Reload later; do not replace an unknown submission." });
  }
  return true;
}
