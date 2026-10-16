import { createHmac } from "node:crypto";
import type { HostedAgent } from "./hosted-agents.js";

export const supplierBase = (name: string) => `/i/${name}`;
export const supplierCookie = (name: string) => `__Host-invoice_${name}`;

/** Only a managed payout instance receives its own supplier audience and session key. */
export function supplierEnvironment(agent: HostedAgent, host: string | undefined, secret: string): NodeJS.ProcessEnv {
  if (agent.area !== "payables" || !host) return {};
  return {
    HOSTED_INVOICE_BASE: supplierBase(agent.name),
    INVOICES_PUBLIC_HOST: host,
    INVOICES_HTTPS: "true",
    INVOICES_SESSION_COOKIE: supplierCookie(agent.name),
    INVOICES_SESSION_SECRET: createHmac("sha256", secret).update(`supplier:${host}:${agent.name}`).digest("hex"),
  };
}

/** A missing instance never falls back to the original agency payout executor. */
export function supplierRoute(pathname: string) {
  const match = pathname.match(/^\/i\/(own-[a-f0-9]{24})(\/.*)?$/);
  if (!match) return null;
  const path = match[2] || "/";
  if (path !== "/" && path !== "/invoice-browser.js" && path !== "/report" && path !== "/report/" && !path.startsWith("/api/")) return null;
  return { name: match[1]!, path };
}
