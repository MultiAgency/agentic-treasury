import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId } from "./agent.js";
import { file, read, status, validate } from "./intake.js";

/**
 * The intake's public face: one page and three JSON routes. It holds only the intake's grant on the
 * payout agent, so the worst it can do is file payouts to agreed payees, each waiting for the owner.
 *
 * Abuse: every write needs a Cloudflare Turnstile token, and each address gets a few writes an hour.
 * Without a Turnstile secret it listens on loopback only, for local use.
 */

const PORT = Number(process.env.PORT ?? 8791);
const HOST = process.env.INTAKE_HOST ?? "127.0.0.1";
const SITE_KEY = process.env.TURNSTILE_SITE_KEY ?? "";
const SECRET = process.env.TURNSTILE_SECRET_KEY ?? "";
const TITLE = process.env.INTAKE_TITLE ?? "Payment requests";
/** Behind a proxy (Railway), the client's address is the first in X-Forwarded-For. */
const TRUST_PROXY = process.env.INTAKE_TRUST_PROXY === "true";
const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost";

if (!LOOPBACK && !SECRET) throw new Error("Set TURNSTILE_SECRET_KEY before listening beyond loopback");
agentId(); // fail at start, not on the first request, when no agent is configured

/** Writes allowed per address per hour: reading a request, and filing one. */
const LIMITS = { read: 10, file: 5 } as const;
const hits = new Map<string, number[]>();
function allowed(kind: keyof typeof LIMITS, address: string) {
  const key = `${kind}:${address}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= LIMITS[kind]) return false;
  hits.set(key, [...recent, now]);
  return true;
}

const address = (req: IncomingMessage) =>
  (TRUST_PROXY && String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim()) || req.socket.remoteAddress || "unknown";

async function human(token: unknown, ip: string) {
  if (!SECRET) return LOOPBACK;
  if (typeof token !== "string" || !token) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: SECRET, response: token, remoteip: ip }),
  });
  return ((await response.json()) as { success?: boolean }).success === true;
}

/** A body the requester got wrong: answered 400, unlike a failure on this side. */
class BadRequest extends Error {}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
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

const send = (res: ServerResponse, code: number, value: unknown) =>
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));

createServer(async (req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  const url = new URL(req.url ?? "/", "http://intake");
  const ip = address(req);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      res.setHeader(
        "content-security-policy",
        `default-src 'self'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self'`,
      );
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(nonce));
    }
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

    // Reads a free-form request into fields for the requester to check. Files nothing.
    if (req.method === "POST" && url.pathname === "/api/read") {
      if (!allowed("read", ip)) return send(res, 429, { error: "Too many requests. Try again later." });
      const input = await body(req);
      if (!(await human(input.token, ip))) return send(res, 403, { error: "Verification failed. Reload and try again." });
      if (typeof input.text !== "string" || !input.text.trim()) return send(res, 400, { error: "Paste the request or invoice text." });
      return send(res, 200, await read(input.text));
    }

    // Files the confirmed fields once; the same request returns the same id and status.
    if (req.method === "POST" && url.pathname === "/api/requests") {
      if (!allowed("file", ip)) return send(res, 429, { error: "Too many requests. Try again later." });
      const input = await body(req);
      if (!(await human(input.token, ip))) return send(res, 403, { error: "Verification failed. Reload and try again." });
      const request = validate(input);
      if ("invalid" in request) return send(res, 400, { error: `Check the ${request.invalid}.` });
      return send(res, 200, await file(request));
    }

    const match = /^\/api\/requests\/([0-9a-f]{32})$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const current = await status(match[1]!);
      return current ? send(res, 200, { id: match[1], status: current }) : send(res, 404, { error: "No such request." });
    }
    send(res, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof BadRequest) return send(res, 400, { error: error.message });
    // Requesters see no internals: accounts, policy and API errors stay in this process's log.
    console.error(error);
    send(res, 500, { error: "Something went wrong. Try again later." });
  }
}).listen(PORT, HOST, () => console.log(`Intake on http://${HOST}:${PORT}${SECRET ? "" : " (no Turnstile: loopback only)"}`));

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The one page: paste a request, check what was read, submit, and see its status. */
function page(nonce: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(TITLE)}</title>
${SITE_KEY ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
<style>
:root{--bg:#fafafa;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--accent:#18181b;--ok:#15803d;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--accent:#fafafa;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:40px 16px;display:flex;flex-direction:column;gap:20px}
h1{font-size:22px;margin:0}p{margin:0;color:var(--muted)}label{display:flex;flex-direction:column;gap:6px;font-size:14px}
textarea,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:12px;padding:10px 12px}
textarea{min-height:140px}button{font:inherit;border:0;border-radius:999px;padding:10px 18px;background:var(--accent);color:var(--bg);cursor:pointer;align-self:flex-start}
button:disabled{opacity:.5}.card{border:1px solid var(--line);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:14px}
.status{font-weight:600}.ok{color:var(--ok)}.warn{color:var(--warn)}[hidden]{display:none}
</style></head><body><main>
<h1>${escape(TITLE)}</h1>
<p>Paste an invoice or describe the payment. You'll check the details before anything is sent. Payments are made in USDC to NEAR accounts that have already been agreed, and each one is approved before it's paid.</p>
<section class="card" id="step-read">
<label>Request<textarea id="text" maxlength="4000" placeholder="Invoice 1042: 250 USDC to alice.near for October design work"></textarea></label>
<button id="read">Read request</button>
</section>
<section class="card" id="step-confirm" hidden>
<label>Pay to (NEAR account)<input id="payee" autocomplete="off"></label>
<label>Amount (USDC)<input id="amount" inputmode="decimal" autocomplete="off"></label>
<label>Reference<input id="reference" maxlength="120" autocomplete="off"></label>
<button id="submit">Submit request</button>
</section>
<section class="card" id="step-status" hidden><p>Request <code id="rid"></code></p><p class="status" id="status"></p></section>
${SITE_KEY ? `<div class="cf-turnstile" data-sitekey="${escape(SITE_KEY)}" data-callback="onToken"></div>` : ""}
<p id="error" class="warn" hidden></p>
<script nonce="${nonce}">
let token = "";
window.onToken = (t) => { token = t; };
const $ = (id) => document.getElementById(id);
const WORDS = {
  needs_agreement: ["This payee isn't on the agreed list. A new agreement has to be approved first.", "warn"],
  refused: ["Refused: the request is outside what this treasury may pay (for example over its limits).", "warn"],
  busy: ["Too many requests are waiting right now. Try again later.", "warn"],
  waiting: ["Received. It waits for approval.", ""],
  paying: ["Approved. The payment is on its way.", ""],
  paid: ["Paid.", "ok"],
  failed: ["The payment didn't go through.", "warn"],
};
function fail(message) { $("error").textContent = message; $("error").hidden = false; }
async function post(path, payload) {
  $("error").hidden = true;
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, token }) });
  const json = await res.json();
  if (window.turnstile) { window.turnstile.reset(); token = ""; }
  if (!res.ok) throw new Error(json.error || "Something went wrong.");
  return json;
}
function show(id, status) {
  $("step-status").hidden = false; $("rid").textContent = id;
  const [text, tone] = WORDS[status] || [status, ""];
  $("status").textContent = text; $("status").className = "status " + tone;
  history.replaceState(null, "", "#" + id);
  if (status === "waiting" || status === "paying") setTimeout(() => poll(id), 15000);
}
async function poll(id) {
  const res = await fetch("/api/requests/" + id);
  if (res.ok) { const json = await res.json(); show(json.id, json.status); }
}
$("read").onclick = async () => {
  $("read").disabled = true;
  try {
    const fields = await post("/api/read", { text: $("text").value });
    for (const key of ["payee", "amount", "reference"]) $(key).value = fields[key] || "";
    $("step-confirm").hidden = false;
  } catch (e) { fail(e.message); } finally { $("read").disabled = false; }
};
$("submit").onclick = async () => {
  $("submit").disabled = true;
  try {
    const result = await post("/api/requests", { payee: $("payee").value, amount: $("amount").value, reference: $("reference").value });
    show(result.id, result.status);
  } catch (e) { fail(e.message); } finally { $("submit").disabled = false; }
};
if (/^#[0-9a-f]{32}$/.test(location.hash)) poll(location.hash.slice(1));
</script>
</main></body></html>`;
}
