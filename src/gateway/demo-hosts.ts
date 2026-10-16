import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { sessions } from "../signin.js";

export type Demo = "showcase" | "payables" | "treasury" | "invoices";
export type DemoHost = { frontendDist?: string; demo: Demo; agents: string[]; hostedAreas?: ("treasury" | "payables")[] };
export const hostSessionSecret = (secret: string, host: string) => createHmac("sha256", secret).update(`demo-session:${host}`).digest("hex");
export const demoSession = (secret: string, host: string) => sessions({ cookie: "__Host-demo_session", secret: hostSessionSecret(secret, host), secure: true });
/** Actual authority only. Forwarded host headers never select a demo or a signing audience. */
export function demoHost(req: IncomingMessage, hosts: Record<string, DemoHost>) {
  const host = req.headers.host?.toLowerCase();
  return host && Object.hasOwn(hosts, host) ? { host, ...hosts[host]! } : null;
}
/** Sibling subdomains are same-site, but are never same-origin authority. */
export function demoCrossSite(req: IncomingMessage, host: string) {
  const origin = req.headers.origin;
  const write = !["GET", "HEAD"].includes(req.method ?? "");
  return (origin !== undefined && origin !== `https://${host}`)
    || (write && req.headers["sec-fetch-site"] === "cross-site")
    || (write && req.headers["sec-fetch-site"] === "same-site" && origin === undefined);
}

/** Supplier entry belongs to Payables. Only page reads map /submit to the existing intake page. */
export function invoiceRoute(demo: Demo | undefined, url: URL, method: string) {
  if (demo !== "invoices") return null;
  const page = url.pathname === "/" || url.pathname === "/submit";
  if (page && !["GET", "HEAD"].includes(method)) return null;
  if (page || url.pathname === "/invoice-browser.js" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/"))
    return `${page ? "/" : url.pathname}${url.search}`;
  return null;
}

/** Static assignments and owner-created instances share routing, never authorization. */
export function assignedToHost(agent: { name: string; area?: string; kind?: string }, site: DemoHost) {
  return site.agents.includes(agent.name) || Boolean(agent.kind && site.hostedAreas?.some(area => area === agent.area));
}
