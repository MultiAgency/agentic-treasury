import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId } from "./agent.js";
import { agreed, file, mine, validate } from "./invoices.js";
import { BadRequest, readJson } from "./http.js";
import { chainKeyLookup, clientAddress, hourlyLimit, issueChallenge, sessions, verifySignIn, ChallengeLimit } from "./signin.js";

/**
 * The public invoice listener in the payout executor process. It uses the same grant, database,
 * money lock and reconciliation loop as the dashboard; it never runs a separate payment writer.
 *
 * Only a payee can use it: a contractor signs in with the NEAR account being paid (a NEP-413
 * signature by a full-access key, see signin.ts), and only an account the owner agreed to gets a
 * session. An invoice always pays the signed-in account, so no one can invoice for someone else,
 * and strangers never reach the queue or the list of payees.
 */

const PORT = Number(process.env.INVOICES_PORT ?? 8791);
const HOST = process.env.INVOICES_HOST ?? "127.0.0.1";
const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost";
/** The host contractors see, which every sign-in signature is bound to; never taken from a request. */
const PUBLIC_HOST = process.env.INVOICES_PUBLIC_HOST ?? (LOOPBACK ? `localhost:${PORT}` : "");
/** Signs session cookies. A loopback instance may use a throwaway one: its sessions end with it. */
const SECRET = process.env.INVOICES_SESSION_SECRET ?? (LOOPBACK ? randomBytes(32).toString("base64") : "");
const TITLE = process.env.INVOICES_TITLE ?? "Submit an invoice";

if (!PUBLIC_HOST || !SECRET) throw new Error("Set INVOICES_PUBLIC_HOST and INVOICES_SESSION_SECRET before listening beyond loopback");
agentId(); // fail at start, not on the first request, when no agent is configured
const ORIGIN = `${LOOPBACK ? "http" : "https"}://${PUBLIC_HOST}`;
const session = sessions({ cookie: "invoices_session", secret: SECRET, secure: !LOOPBACK });

/** Attempts allowed per hour: sign-ins per address, invoices per signed-in account. */
const LIMITS = { signin: hourlyLimit(10), file: hourlyLimit(10) };
const allowed = (kind: keyof typeof LIMITS, who: string) => LIMITS[kind](who);

const address = clientAddress;

const send = (res: ServerResponse, code: number, value: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(value));

export const invoiceHandler = async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  const ip = address(req);
  try {
    // A malformed request target (`GET http://[/`) throws here: answered 400 below, never a crash.
    const url = URL.parse(req.url ?? "/", ORIGIN);
    if (!url) throw new BadRequest("Malformed request.");
    if (req.method === "GET" && url.pathname === "/") {
      // The wallet connector loads from jsDelivr, fetches its wallet list over https, and runs each
      // wallet as inline script in a sandboxed srcdoc frame, which inherits this policy: so inline
      // scripts must be allowed. The page never writes untrusted text as HTML (textContent only).
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https:; connect-src 'self' https: wss:; frame-src https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'",
      );
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
    }
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

    // Same-origin writes only: with a SameSite cookie this closes cross-site requests outright.
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: "Wrong origin." });

    if (req.method === "GET" && url.pathname === "/api/session") return send(res, 200, { account: session.account(req) });

    if (req.method === "POST" && url.pathname === "/api/signin/challenge") {
      if (!allowed("signin", ip)) return send(res, 429, { error: "Too many attempts. Try again later." });
      try {
        return send(res, 200, issueChallenge(PUBLIC_HOST));
      } catch (error) {
        if (error instanceof ChallengeLimit) return send(res, 429, { error: error.message });
        throw error;
      }
    }

    // A signature by a full-access key of an agreed payee opens a session; anyone else is told why not.
    if (req.method === "POST" && url.pathname === "/api/signin") {
      const input = await readJson(req);
      const signIn = { accountId: input.accountId, publicKey: input.publicKey, signature: input.signature, nonce: input.nonce };
      if (Object.values(signIn).some((v) => typeof v !== "string")) return send(res, 400, { error: "Sign in with your wallet." });
      // Some wallets also sign the page's URL as NEP-413's callbackUrl without saying so: the page
      // offers the URLs it may have used, and signin.ts accepts only ones on this site.
      const callbackUrls = Array.isArray(input.callbackUrls) ? input.callbackUrls.filter((u): u is string => typeof u === "string").slice(0, 3) : [];
      let account: string;
      try {
        account = await verifySignIn({ ...(signIn as Record<keyof typeof signIn, string>), callbackUrls }, PUBLIC_HOST, chainKeyLookup);
      } catch (error) {
        // Everything here is public (account, public key, signature, nonce): kept to diagnose wallets.
        console.warn("sign-in refused", JSON.stringify({ ...signIn, host: PUBLIC_HOST, reason: String(error) }));
        return send(res, 403, { error: error instanceof Error ? error.message : "Sign-in failed." });
      }
      if (!(await agreed()).has(account))
        return send(res, 403, { error: `${account} isn't on the agreed list. A new agreement has to be approved first.` });
      return send(res, 200, { account }, { "set-cookie": session.open(account) });
    }

    if (req.method === "POST" && url.pathname === "/api/signout")
      return send(res, 200, { account: null }, { "set-cookie": session.close() });

    const payee = session.account(req);
    if (url.pathname.startsWith("/api/") && !payee) return send(res, 401, { error: "Sign in with the account being paid." });

    // Files the confirmed invoice once, always paying the signed-in account.
    if (req.method === "POST" && url.pathname === "/api/invoices") {
      if (!allowed("file", payee!)) return send(res, 429, { error: "Too many attempts. Try again later." });
      const input = await readJson(req);
      const invoice = validate({ ...input, payee });
      if ("invalid" in invoice) return send(res, 400, { error: `Check the ${invoice.invalid}.` });
      return send(res, 200, await file(invoice, payee!));
    }

    // The signed-in payee's invoices, with their current status.
    if (req.method === "GET" && url.pathname === "/api/invoices") return send(res, 200, { invoices: await mine(payee!) });
    send(res, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof BadRequest) return send(res, 400, { error: error.message });
    // Payees see no internals: accounts, policy and API errors stay in this process's log.
    console.error(error);
    send(res, 500, { error: "Something went wrong. Try again later." });
  }
};

export function startInvoiceServer() {
  return createServer(invoiceHandler).listen(PORT, HOST, () => console.log(`Invoices on http://${HOST}:${PORT}, signing for ${PUBLIC_HOST}`));
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * near-connect's wallet list, pinned to a reviewed commit (2026-09-24). Each wallet's own code still
 * loads from the URL the list names (mostly raw.githubusercontent.com), so that code can change under
 * the same URL: wallets run sandboxed and every signature is verified here, so the remaining risk is
 * a wallet that phishes for keys. Bump this only after reviewing the new manifest.
 */
const WALLET_MANIFEST = "https://cdn.jsdelivr.net/gh/fastnear/near-connect@d277b41263a8ea0a6892236b22824d46c2c3c377/repository/manifest.json";

/** The one page: sign in as the payee, enter an amount and what it's for, submit, and follow your invoices. */
function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(TITLE)}</title>
<style>
:root{--bg:#fafafa;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--accent:#18181b;--ok:#15803d;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--accent:#fafafa;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:40px 16px;display:flex;flex-direction:column;gap:20px}
h1{font-size:22px;margin:0}p{margin:0;color:var(--muted)}label{display:flex;flex-direction:column;gap:6px;font-size:14px}
textarea,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:12px;padding:10px 12px}
textarea{min-height:140px}button{font:inherit;border:0;border-radius:999px;padding:10px 18px;background:var(--accent);color:var(--bg);cursor:pointer;align-self:flex-start}
button.link{background:transparent;color:var(--muted);padding:0;text-decoration:underline}
button:disabled{opacity:.5}.card{border:1px solid var(--line);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:14px}
.status{font-weight:600}.ok{color:var(--ok)}.warn{color:var(--warn)}[hidden]{display:none}code{word-break:break-all}
</style></head><body><main>
<h1>${escape(TITLE)}</h1>
<p>Sign in with the NEAR account you want to be paid to, enter the amount, and submit. You're paid in USDC once the invoice is approved.</p>
<section class="card" id="step-signin">
<p>Your wallet signs a message proving you control the account. It doesn't send a transaction or spend anything.</p>
<button id="signin">Sign in with NEAR</button>
</section>
<section class="card" id="step-invoice" hidden>
<p>Signed in as <code id="account"></code>. <button class="link" id="signout">Sign out</button></p>
<label>Amount (USDC)<input id="amount" inputmode="decimal" autocomplete="off" placeholder="250"></label>
<label>What's it for? (optional)<input id="note" maxlength="200" autocomplete="off" placeholder="October design work"></label>
<button id="submit">Submit invoice</button>
</section>
<section class="card" id="list" hidden><h2 style="font-size:16px;margin:0">Your invoices</h2><ul id="invoices" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px"></ul><p id="none">None yet.</p></section>
<p id="error" class="warn" hidden></p>
<script type="module">
import { NearConnector } from "https://cdn.jsdelivr.net/npm/@fastnear/near-connect@0.14.1/+esm";
// The wallet list is pinned to one commit of near-connect's manifest, not its moving main branch.
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true },
  manifest: "${WALLET_MANIFEST}" });
const $ = (id) => document.getElementById(id);
const WORDS = {
  needs_agreement: ["This account isn't on the agreed list. A new agreement has to be approved first.", "warn"],
  refused: ["Refused: the invoice is outside what this treasury may pay (for example over its limits).", "warn"],
  busy: ["Too many invoices are waiting right now. Try again later.", "warn"],
  waiting: ["Waiting for approval. The treasury has 24 hours to approve it.", ""],
  paying: ["The payment is processing. Settlement is not yet confirmed.", ""],
  prepared: ["Recorded, not submitted. Retry this invoice to continue.", ""],
  unknown: ["The payment outcome is unknown. It needs reconciliation; do not create a replacement invoice.", "warn"],
  needs_review: ["This invoice needs review. An existing payment may still be pending; do not file it again as a new invoice.", "warn"],
  paid: ["Paid.", "ok"],
  failed: ["The payment didn't go through.", "warn"],
};
const fromBase64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
function fail(message) { $("error").textContent = message; $("error").hidden = false; }
async function call(method, path, payload) {
  $("error").hidden = true;
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: payload && JSON.stringify(payload) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Something went wrong.");
  return json;
}
function signedIn(account) {
  $("step-signin").hidden = !!account; $("step-invoice").hidden = !account; $("list").hidden = !account;
  $("account").textContent = account || "";
  if (account) {
    const saved = JSON.parse(localStorage.getItem("invoice-draft:" + account) || "null");
    submission = saved?.submission || crypto.randomUUID();
    $("amount").value = saved?.amount || ""; $("note").value = saved?.note || "";
    refresh();
  }
}
const usdc = (raw) => raw === null ? "" : (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }) + " USDC";
let timer;
// Lists the payee's invoices; while any can still change, checks again every 15 seconds.
async function refresh() {
  clearTimeout(timer);
  const res = await fetch("/api/invoices");
  if (!res.ok) return;
  const { invoices } = await res.json();
  $("none").hidden = invoices.length > 0;
  $("invoices").replaceChildren(...invoices.map((invoice) => {
    const [text, tone] = WORDS[invoice.status] || [invoice.status, ""];
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.textContent = [usdc(invoice.amount), invoice.note, new Date(invoice.filedAt).toLocaleString()].filter(Boolean).join(" · ");
    const status = document.createElement("div");
    status.textContent = text + (invoice.revisionConflict ? " Changed invoice details require review; the original payment is unchanged." : ""); status.className = "status " + tone;
    item.append(head, status);
    return item;
  }));
  if (invoices.some((invoice) => ["waiting", "paying", "unknown", "needs_review"].includes(invoice.status))) timer = setTimeout(refresh, 15000);
}
$("signin").onclick = async () => {
  $("signin").disabled = true;
  try {
    const challenge = await call("POST", "/api/signin/challenge");
    await connector.connect();
    const { wallet } = await connector.getConnectedWallet();
    const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
    const callbackUrls = [...new Set([location.origin + location.pathname, location.href.split("#")[0], location.origin + "/"])];
    const { account } = await call("POST", "/api/signin", { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, callbackUrls });
    signedIn(account);
  } catch (e) { fail(e.message); } finally { $("signin").disabled = false; }
};
$("signout").onclick = async () => { await call("POST", "/api/signout"); await connector.disconnect().catch(() => {}); signedIn(null); };
// One id per filled-in form: a retry or double click files once; the next invoice gets a new one.
let submission = crypto.randomUUID();
$("submit").onclick = async () => {
  $("submit").disabled = true;
  // Filing waits for the API to confirm the payout is held, which can take half a minute.
  $("submit").textContent = "Submitting… this can take up to a minute";
  try {
    const draft = { amount: $("amount").value, note: $("note").value, submission };
    const draftKey = "invoice-draft:" + $("account").textContent;
    localStorage.setItem(draftKey, JSON.stringify(draft));
    const result = await call("POST", "/api/invoices", draft);
    // Turned away before filing (not agreed, or the queue is full): say so, since it isn't listed.
    if (result.status === "needs_agreement" || result.status === "busy") fail(WORDS[result.status][0]);
    if (["waiting", "paying", "paid", "failed", "refused"].includes(result.status) && !result.revisionConflict) {
      localStorage.removeItem(draftKey); submission = crypto.randomUUID(); $("amount").value = ""; $("note").value = "";
    }
    if (["unknown", "prepared", "needs_review"].includes(result.status)) fail(WORDS[result.status][0]);
    if (result.status === "refused") fail(WORDS.refused[0]);
    await refresh();
  } catch (e) { fail(e.message); } finally { $("submit").disabled = false; $("submit").textContent = "Submit invoice"; }
};
const { account } = await call("GET", "/api/session");
signedIn(account);
</script>
</main></body></html>`;
}
