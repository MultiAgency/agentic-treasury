import { compatibleSupplierFrontend } from "../supplier-contract.js";
import type { ServerResponse } from "node:http";
import { sendJson } from "../http.js";

/** Presentation only. API traffic and cookies never reach the independent frontend service. */
export function supplierAsset(path: string): string | null {
  if (["/", "/submit", "/submit/"].includes(path)) return "/index.html";
  if (["/report", "/report/"].includes(path)) return "/contributor.html";
  if (path === "/invoice-browser.js") return path;
  if (/^\/invoice-ui\/static\/[a-zA-Z0-9_./-]+\.(js|css|woff2?|svg|png|ico)$/.test(path) && !path.split("/").includes("..")) return path.slice("/invoice-ui".length);
  return null;
}
export async function serveSupplierFrontend(res: ServerResponse, path: string, origin = process.env.INVOICES_FRONTEND_URL): Promise<boolean> {
  const asset = supplierAsset(path);
  if (!origin || !asset) return false;
  try {
    const base = new URL(origin);
    if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
      !(base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))) throw new Error("Invalid frontend origin");
    if (asset.endsWith(".html")) {
      const contract = await fetch(new URL("/contract.json", base), { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!contract.ok || !compatibleSupplierFrontend(await contract.json())) throw new Error("Unsupported frontend contract");
    }
    const answer = await fetch(new URL(asset, base), { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!answer.ok) throw new Error("Frontend unavailable");
    const bytes = await answer.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Frontend asset too large");
    const type = asset.endsWith(".html") ? "text/html; charset=utf-8" : asset.endsWith(".js") ? "text/javascript; charset=utf-8" : asset.endsWith(".css") ? "text/css; charset=utf-8" : answer.headers.get("content-type") ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "frame-ancestors 'none'; default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https:; connect-src 'self' https: wss:; frame-src https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" }).end(Buffer.from(bytes));
  } catch {
    sendJson(res, 503, { error: "Invoices interface unavailable. Your existing records remain with the executor. Reload later; do not replace an unknown submission." });
  }
  return true;
}
