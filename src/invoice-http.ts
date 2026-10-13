import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId } from "./env.js";
import { type AgreementStatus, agreements, localStore, requestAgreement } from "./agreements.js";
import { agreed, file, mine, type Status, validate } from "./invoices.js";
import { BadRequest, readJson, SECURITY_HEADERS, sendFailure, sendJson as send } from "./http.js";
import { chainKeyLookup, challengeAnswer, clientAddress, hourlyLimit, parseSignIn, sessions, verifySignIn } from "./signin.js";

/**
 * The public invoice listener in the payout executor process. It uses the same grant, database,
 * money lock and reconciliation loop as the dashboard; it never runs a separate payment writer.
 *
 * Anyone signs in with the NEAR account to be paid (a NEP-413 signature by a full-access key, see
 * signin.ts). An agreed payee files an invoice; anyone else files an agreement request, which is never
 * a payment (agreements.ts). An invoice always pays the signed-in account, so no one can invoice for
 * someone else, and no one sees other payees, the list of agreed payees, or the DAO's members.
 *
 * `/internal/agreements` lets the approve-only dashboard of the same agent read and answer agreements,
 * with `AGREEMENTS_SECRET` as a bearer token; without the secret it doesn't exist.
 */

const PORT = Number(process.env.INVOICES_PORT ?? 8791);
const HOST = process.env.INVOICES_HOST ?? "127.0.0.1";
const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost";
/** The host contractors see, which every sign-in signature is bound to; never taken from a request. */
const PUBLIC_HOST = process.env.INVOICES_PUBLIC_HOST ?? (LOOPBACK ? `localhost:${PORT}` : "");
/** Signs session cookies. A loopback instance may use a throwaway one: its sessions end with it. */
const SECRET = process.env.INVOICES_SESSION_SECRET ?? (LOOPBACK ? randomBytes(32).toString("base64") : "");
const TITLE = process.env.INVOICES_TITLE ?? "Submit an invoice";
const AGREEMENTS_SECRET = process.env.AGREEMENTS_SECRET ?? "";
const store = localStore(agreed);

if (!PUBLIC_HOST || !SECRET) throw new Error("Set INVOICES_PUBLIC_HOST and INVOICES_SESSION_SECRET before listening beyond loopback");
agentId(); // fail at start, not on the first request, when no agent is configured
const ORIGIN = `${LOOPBACK ? "http" : "https"}://${PUBLIC_HOST}`;
const session = sessions({ cookie: "invoices_session", secret: SECRET, secure: !LOOPBACK });

/** Attempts allowed per hour: sign-ins per address, invoices per signed-in account. */
const LIMITS = { signin: hourlyLimit(10), file: hourlyLimit(10) };
const allowed = (kind: keyof typeof LIMITS, who: string) => LIMITS[kind](who);

export const invoiceHandler = async (req: IncomingMessage, res: ServerResponse) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const ip = clientAddress(req);
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
        "frame-ancestors 'none'; default-src 'self'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https:; connect-src 'self' https: wss:; frame-src https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'",
      );
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
    }
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

    // Same-origin writes only: with a SameSite cookie this closes cross-site requests outright.
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: "Wrong origin." });

    if (url.pathname.startsWith("/internal/agreements")) return await internal(req, res, url.pathname);

    if (req.method === "GET" && url.pathname === "/api/session") {
      const account = session.account(req);
      return send(res, 200, { account, agreed: account ? (await agreed()).has(account) : false });
    }

    if (req.method === "POST" && url.pathname === "/api/signin/challenge") return send(res, ...challengeAnswer(PUBLIC_HOST, allowed("signin", ip)));

    // A signature by a full-access key opens a session; whether the account is agreed decides what it files.
    if (req.method === "POST" && url.pathname === "/api/signin") {
      const signIn = parseSignIn(await readJson(req));
      let account: string;
      try {
        account = await verifySignIn(signIn, PUBLIC_HOST, chainKeyLookup);
      } catch (error) {
        // Everything here is public (account, public key, signature, nonce, URLs): kept to diagnose wallets.
        console.warn("sign-in refused", JSON.stringify({ ...signIn, host: PUBLIC_HOST, reason: String(error) }));
        return send(res, 403, { error: error instanceof Error ? error.message : "Sign-in failed." });
      }
      return send(res, 200, { account, agreed: (await agreed()).has(account) }, { "set-cookie": session.open(account) });
    }

    if (req.method === "POST" && url.pathname === "/api/signout")
      return send(res, 200, { account: null }, { "set-cookie": session.close() });

    const payee = session.account(req);
    if (url.pathname.startsWith("/api/") && !payee) return send(res, 401, { error: "Sign in with the account being paid." });

    // Files the confirmed invoice once, always paying the signed-in account; an account the owner
    // hasn't agreed to pay files an agreement request instead, and nothing is paid.
    if (req.method === "POST" && url.pathname === "/api/invoices") {
      if (!allowed("file", payee!)) return send(res, 429, { error: "Too many attempts. Try again later." });
      const input = await readJson(req);
      const invoice = validate({ ...input, payee });
      if ("invalid" in invoice) return send(res, 400, { error: `Check the ${invoice.invalid}.` });
      const payees = await agreed();
      if (!payees.has(payee!)) return send(res, 200, requestAgreement(invoice, payees));
      return send(res, 200, await file(invoice, payee!));
    }

    // The signed-in payee's invoices and agreements, with their current status.
    if (req.method === "GET" && url.pathname === "/api/invoices") {
      const own = agreements(await agreed()).filter((a) => a.payee === payee && a.status !== "filed")
        .map(({ id, origin, amount, note, submission, terms, status, at }) => ({ id, origin, amount, note, submission, terms, status, at }));
      return send(res, 200, { invoices: await mine(payee!), agreements: own });
    }
    send(res, 404, { error: "Not found." });
  } catch (error) {
    // Payees see no internals: accounts, policy and API errors stay in this process's log.
    sendFailure(res, error);
  }
};

/** The approve-only dashboard's access to this host's agreements: bearer secret, or not found. */
async function internal(req: IncomingMessage, res: ServerResponse, path: string) {
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(AGREEMENTS_SECRET);
  if (!AGREEMENTS_SECRET || given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 404, { error: "Not found." });
  if (req.method === "GET" && path === "/internal/agreements") return send(res, 200, { agreements: await store.list() });
  if (req.method !== "POST") return send(res, 404, { error: "Not found." });
  try {
    return await answerInternal(res, path, (await readJson(req)) as Record<string, unknown>);
  } catch (error) {
    // The caller is this agent's own dashboard: it sees why, unlike a payee.
    return send(res, 400, { error: error instanceof Error ? error.message : "Malformed request." });
  }
}

async function answerInternal(res: ServerResponse, path: string, body: Record<string, unknown>) {
  const id = typeof body.id === "string" && /^[0-9a-f]{32}$/.test(body.id) ? body.id : null;
  const until = typeof body.until === "string" ? new Date(body.until) : null;
  if (path === "/internal/agreements/propose" && id && until) return send(res, 200, await store.propose(id, until) ?? { ok: true });
  if (path === "/internal/agreements/decline" && id) return send(res, 200, await store.decline(id) ?? { ok: true });
  if (path === "/internal/agreements/offer" && until)
    return send(res, 200, { id: await store.offer({ payee: String(body.payee ?? ""), amount: String(body.amount ?? ""), note: String(body.note ?? ""), until }) });
  throw new BadRequest("Malformed request.");
}

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
/** What the page says for each invoice status, and its tone: one entry per `Status`, checked here. */
const WORDS: Record<Status, [string, "" | "ok" | "warn"]> = {
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

/** What the page says for each agreement status; a filed one shows as its invoice instead. */
const AGREEMENT_WORDS: Record<Exclude<AgreementStatus, "filed">, string> = {
  requested: "Waiting for the DAO to agree to pay you. Nothing is paid until it does and you file the invoice.",
  proposed: "The DAO is voting on an agreement to pay you.",
  agreed: "Agreed. File the invoice to be paid.",
  declined: "The DAO declined this request.",
};

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(TITLE)}</title>
<style>
/* The dashboard's tokens (web/src/styles.css), so the payee sees the same product. */
:root{--bg:oklch(0.99 0.003 251);--card:oklch(1 0 0);--fg:oklch(0.22 0.02 251);--muted:oklch(0.5 0.016 251);--line:oklch(0.92 0.006 251);--strong:oklch(0.78 0.012 251);--accent:oklch(0.25 0.035 252);--on-accent:oklch(0.99 0 0);--ok-bg:oklch(0.96 0.035 158);--ok:oklch(0.38 0.09 158);--warn-bg:oklch(0.97 0.04 85);--warn:oklch(0.44 0.1 60);--chip:oklch(0.965 0.005 251)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.16 0.012 251);--card:oklch(0.2 0.014 251);--fg:oklch(0.96 0.004 251);--muted:oklch(0.72 0.012 251);--line:oklch(1 0 0 / 10%);--strong:oklch(1 0 0 / 22%);--accent:oklch(0.96 0.004 251);--on-accent:oklch(0.2 0.02 252);--ok-bg:oklch(0.27 0.05 158);--ok:oklch(0.86 0.1 158);--warn-bg:oklch(0.29 0.05 70);--warn:oklch(0.9 0.1 85);--chip:oklch(1 0 0 / 8%)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:40px 16px;display:flex;flex-direction:column;gap:20px}
h1{font-size:26px;font-weight:600;letter-spacing:-.01em;margin:0}h2{font-size:17px;font-weight:600;margin:0}p{margin:0;color:var(--muted)}
label{display:flex;flex-direction:column;gap:6px;font-size:14px}
input{font:inherit;color:inherit;background:transparent;border:1px solid var(--strong);border-radius:999px;height:44px;padding:0 16px}
button{font:inherit;font-weight:500;border:0;border-radius:999px;height:44px;padding:0 20px;background:var(--accent);color:var(--on-accent);cursor:pointer;align-self:flex-start}
button.link{background:transparent;color:var(--muted);height:auto;padding:0;text-decoration:underline}
button:disabled{opacity:.5;cursor:default}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.chip{display:inline-block;min-height:24px;padding:3px 10px;border-radius:12px;font-size:12px;line-height:18px;font-weight:500;background:var(--chip);color:var(--muted)}
.chip.ok{background:var(--ok-bg);color:var(--ok)}.chip.warn{background:var(--warn-bg);color:var(--warn)}
ul.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}ul.items li{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid var(--line)}ul.items li:first-child{border-top:0;padding-top:0}
.when{font-size:13px;color:var(--muted)}.notice{border-radius:12px;padding:12px 16px;font-size:14px;background:var(--warn-bg);color:var(--warn)}
[hidden]{display:none!important}code{word-break:break-all}
</style></head><body><main>
<h1>${escape(TITLE)}</h1>
<p>Sign in with the NEAR account you want to be paid to, enter the amount, and submit. You're paid in USDC once the invoice is approved.</p>
<section class="card" id="step-signin">
<p>Your wallet signs a message proving you control the account. It doesn't send a transaction or spend anything.</p>
<button id="signin">Sign in with NEAR</button>
</section>
<section class="card" id="step-invoice" hidden>
<div class="row"><span>Signed in as <code id="account"></code></span><span class="chip" id="agreed-chip"></span><button class="link" id="signout">Sign out</button></div>
<p id="not-agreed" class="notice" hidden>The DAO hasn't agreed to pay this account yet. Submitting sends it a request; you're paid only after it agrees and you file the invoice.</p>
<label>Amount (USDC)<input id="amount" inputmode="decimal" autocomplete="off" placeholder="250"></label>
<label>What's it for? (optional)<input id="note" maxlength="200" autocomplete="off" placeholder="October design work"></label>
<button id="submit">Submit invoice</button>
</section>
<p id="error" class="notice" role="alert" hidden></p>
<section class="card" id="agreements-card" hidden><h2>Your agreements</h2><ul class="items" id="agreements"></ul></section>
<section class="card" id="list" hidden><h2>Your invoices</h2><ul class="items" id="invoices"></ul><p id="none" hidden>None yet.</p></section>
<script type="module">
import { NearConnector } from "https://cdn.jsdelivr.net/npm/@fastnear/near-connect@0.14.1/+esm";
// The wallet list is pinned to one commit of near-connect's manifest, not its moving main branch.
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true },
  manifest: "${WALLET_MANIFEST}" });
const $ = (id) => document.getElementById(id);
const WORDS = ${JSON.stringify(WORDS)};
const AGREEMENT_WORDS = ${JSON.stringify(AGREEMENT_WORDS)};
const fromBase64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
function fail(message) { $("error").textContent = message; $("error").hidden = false; }
async function call(method, path, payload) {
  $("error").hidden = true;
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: payload && JSON.stringify(payload) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Something went wrong.");
  return json;
}
function signedIn(account, agreed) {
  $("step-signin").hidden = !!account; $("step-invoice").hidden = !account; $("list").hidden = !account;
  $("account").textContent = account || "";
  $("not-agreed").hidden = !account || agreed;
  $("agreed-chip").textContent = agreed ? "Agreed payee" : "Not agreed yet"; $("agreed-chip").className = "chip " + (agreed ? "ok" : "warn");
  $("submit").textContent = agreed ? "Submit invoice" : "Send request";
  if (account) {
    const saved = JSON.parse(localStorage.getItem("invoice-draft:" + account) || "null");
    submission = saved?.submission || crypto.randomUUID();
    $("amount").value = saved?.amount || ""; $("note").value = saved?.note || "";
    refresh();
  }
}
const usdc = (raw) => raw === null ? "" : (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }) + " USDC";
const decimal = (raw) => String(Number(raw) / 1e6);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
// One row: what it is, its status as a chip with the page's words, and when.
function row(title, status, tone, at) {
  const item = document.createElement("li");
  const head = document.createElement("div"); head.textContent = title;
  const chip = document.createElement("span"); chip.textContent = status; chip.className = "chip " + tone; chip.style.alignSelf = "flex-start";
  const time = document.createElement("span"); time.textContent = when(at); time.className = "when";
  item.append(head, chip, time);
  return item;
}
// An agreed request files under its own submission (the same invoice); an offer fills in the form.
async function fileAgreement(agreement) {
  if (agreement.origin === "owner") {
    $("amount").value = decimal(agreement.terms.maxAmount); $("note").value = agreement.note; submission = crypto.randomUUID();
    $("amount").focus(); return;
  }
  try { await call("POST", "/api/invoices", { amount: decimal(agreement.amount), note: agreement.note, submission: agreement.submission }); }
  catch (e) { fail(e.message); }
  await refresh();
}
let timer;
// Lists the payee's invoices; while any can still change, checks again every 15 seconds.
async function refresh() {
  clearTimeout(timer);
  const res = await fetch("/api/invoices");
  if (!res.ok) return;
  const { invoices, agreements } = await res.json();
  $("agreements-card").hidden = agreements.length === 0;
  $("agreements").replaceChildren(...agreements.map((agreement) => {
    const terms = agreement.terms ? "up to " + usdc(agreement.terms.maxAmount) + " until " + new Date(agreement.terms.until).toLocaleDateString() : usdc(agreement.amount);
    const title = [agreement.origin === "owner" ? "Offered by the DAO" : "Requested", terms, agreement.note].filter(Boolean).join(" · ");
    const tone = agreement.status === "declined" ? "warn" : agreement.status === "agreed" ? "ok" : "";
    const item = row(title, AGREEMENT_WORDS[agreement.status] || agreement.status, tone, agreement.at);
    if (agreement.status === "agreed") {
      const button = document.createElement("button");
      button.textContent = agreement.origin === "owner" ? "Use these terms" : "File this invoice";
      button.onclick = () => fileAgreement(agreement);
      item.append(button);
    }
    return item;
  }));
  $("none").hidden = invoices.length > 0;
  $("invoices").replaceChildren(...invoices.map((invoice) => {
    const [text, tone] = WORDS[invoice.status] || [invoice.status, ""];
    const title = [usdc(invoice.amount), invoice.note].filter(Boolean).join(" · ");
    return row(title, text + (invoice.revisionConflict ? " Changed invoice details require review; the original payment is unchanged." : ""), tone, invoice.filedAt);
  }));
  if (invoices.some((invoice) => ["waiting", "paying", "unknown", "needs_review"].includes(invoice.status)) ||
      agreements.some((agreement) => ["requested", "proposed"].includes(agreement.status))) timer = setTimeout(refresh, 15000);
}
$("signin").onclick = async () => {
  $("signin").disabled = true;
  try {
    const challenge = await call("POST", "/api/signin/challenge");
    await connector.connect();
    const { wallet } = await connector.getConnectedWallet();
    const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
    const callbackUrls = [...new Set([location.origin + location.pathname, location.href.split("#")[0], location.origin + "/"])];
    const { account, agreed } = await call("POST", "/api/signin", { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, callbackUrls });
    signedIn(account, agreed);
  } catch (e) { fail(e.message); } finally { $("signin").disabled = false; }
};
$("signout").onclick = async () => { await call("POST", "/api/signout"); await connector.disconnect().catch(() => {}); signedIn(null, false); };
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
    // A request from an account not yet agreed: recorded, listed under agreements, nothing paid.
    if (result.status === "requested" || result.status === "proposed") {
      localStorage.removeItem(draftKey); submission = crypto.randomUUID(); $("amount").value = ""; $("note").value = "";
    }
    // Turned away before filing (not agreed, or the queue is full): say so, since it isn't listed.
    if (result.status === "needs_agreement" || result.status === "busy") fail(WORDS[result.status][0]);
    if (["waiting", "paying", "paid", "failed", "refused"].includes(result.status) && !result.revisionConflict) {
      localStorage.removeItem(draftKey); submission = crypto.randomUUID(); $("amount").value = ""; $("note").value = "";
    }
    if (["unknown", "prepared", "needs_review"].includes(result.status)) fail(WORDS[result.status][0]);
    if (result.status === "refused") fail(WORDS.refused[0]);
    await refresh();
  } catch (e) { fail(e.message); } finally { $("submit").disabled = false; $("submit").textContent = $("not-agreed").hidden ? "Submit invoice" : "Send request"; }
};
const { account, agreed } = await call("GET", "/api/session");
signedIn(account, agreed);
</script>
</main></body></html>`;
}
