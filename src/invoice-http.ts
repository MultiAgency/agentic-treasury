import { payeeContract } from "./payee-contract.js";
import { servePayeeFrontend } from "./gateway/payee-frontend.js";
import { invoiceBrowser, invoicePage } from "./invoice-page.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId } from "./env.js";
import { agreements, localStore, requestAgreement } from "./agreements.js";
import { getInvoice, invoiceId } from "./invoice-store.js";
import { agreed, file, mine, validate } from "./invoices.js";
import { BadRequest, readJson, SECURITY_HEADERS, sendFailure, sendJson as send } from "./http.js";
import { compensationList, compensationHistory, saveCompensationRequest, CompensationError } from "./compensation-store.js";
import { reportCommand } from "./compensation-contract.js";
import { payeeWorkOrderRequest } from "./contract/payee.js";
import { localCompensation, compensationOwnerCommand } from "./compensation.js";
import { chainKeyLookup, challengeAnswer, clientAddress, hourlyLimit, parseSignIn, sessions, verifySignIn } from "./signin.js";
import { getWorkOrder, listWorkOrders } from "./work-order-store.js";
import { callWorkOrder } from "./work-order-pool.js";
import { publicWorkOrder, WorkOrderRefusal } from "./work-order-protocol.js";
import { localWorkOrders, workOrderRequest } from "./work-orders.js";
import { AgentConnections, connectionMay } from "./agent-connections.js";
import { agentConnectionIssue, PAYEE_REPORT_PERMISSIONS, PAYEE_ROLE, type AgentConnection, type AgentConnectionPermission } from "./contract/agent-connection.js";
import { appendSynced } from "./synced.js";

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
const SECURE = !LOOPBACK || process.env.INVOICES_HTTPS === "true";
const ORIGIN = `${SECURE ? "https" : "http"}://${PUBLIC_HOST}`;
const session = sessions({ cookie: process.env.INVOICES_SESSION_COOKIE ?? "invoices_session", secret: SECRET, secure: SECURE });

/** Attempts allowed per hour: sign-ins per address, invoices per signed-in account. */
const LIMITS = { signin: hourlyLimit(10), file: hourlyLimit(10), connect: hourlyLimit(20) };
/** Agent connections for this payee entry: bound to its public host, its instance and its payout agent. */
const connections = new AgentConnections(".agent-connections");
const INSTANCE = process.env.HOSTED_INVOICE_BASE || "/";
const connectionUse = hourlyLimit(600);
/** The only routes an agent connection reaches, each by one explicit permission. Everything else is refused. */
const CONNECTION_ROUTES: Record<string, AgentConnectionPermission> = {
  "GET /api/compensation": "compensation.read", "POST /api/compensation": "compensation.submit", "GET /api/compensation/session": "compensation.read",
};
const attribute = (connection: AgentConnection, method: string, path: string, write?: { commandId: string; id: string }) =>
  appendSynced(".agent-connections/access.jsonl", { at: new Date().toISOString(), account: connection.account, host: connection.host,
    instance: connection.instance, agentId: connection.agentId, connectionId: connection.id, method, path, ...write });
const allowed = (kind: keyof typeof LIMITS, who: string) => LIMITS[kind](who);

// Serialize public intake across awaited owner reads, so parallel requests cannot bypass slot limits.
let orderIntake = Promise.resolve();
function requestWorkOrder(payee: string, raw: unknown) {
  const run = orderIntake.then(async () => {
    const parsed = payeeWorkOrderRequest.safeParse(raw);
    if (!parsed.success) throw new BadRequest("Enter an amount, work description and deadline. Work order recipients are fixed to your signed-in account.");
    const draft = parsed.data;
    const valid = validate({ ...draft, payee });
    if ("invalid" in valid) throw new BadRequest(`Check the ${valid.invalid}.`);
    // Scope the retained client identity to this account; another payee cannot probe or claim it.
    const hex = createHash("sha256").update(JSON.stringify([payee, draft.submission])).digest("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const orders = listWorkOrders(agentId());
    const known = orders.find(order => order.id === id);
    if (known) {
      if (known.payee !== payee || known.amount !== valid.amount || known.note !== valid.note || known.until !== draft.until)
        return { conflict: true } as const;
      return { id, status: "requested" } as const;
    }
    if (Date.parse(draft.until) <= Date.now() || Date.parse(draft.until) > Date.now() + 365 * 86_400_000)
      throw new BadRequest("Choose a future deadline within 365 days.");
    const active = orders.filter(order => Date.parse(order.until) > Date.now());
    if (active.length >= 50 || active.filter(order => order.payee === payee).length >= 3) return { full: true } as const;
    // This records proposed terms only. Agent creation, grant and payment approval remain owner-signed.
    await localWorkOrders(agentId(), { type: "create", input: { id, payee, amount: valid.amount, note: valid.note, until: draft.until } });
    return { id, status: "requested" } as const;
  });
  orderIntake = run.then(() => undefined, () => undefined);
  return run;
}

export const invoiceHandler = async (req: IncomingMessage, res: ServerResponse) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const ip = clientAddress(req);
  try {
    // A malformed request target (`GET http://[/`) throws here: answered 400 below, never a crash.
    const url = URL.parse(req.url ?? "/", ORIGIN);
    if (!url) throw new BadRequest("Malformed request.");
    if (req.method === "GET" && url.pathname === "/api/capabilities") return send(res, 200, payeeContract);
    if (req.method === "GET" && await servePayeeFrontend(res, url.pathname)) return;
    if (req.method === "GET" && url.pathname === "/api/compensation/schema")
      return send(res, 200, { version: 2, submit: z.toJSONSchema(reportCommand), reads: ["GET /api/compensation"], writes: ["POST /api/compensation"], authentication: "Contributor NEP-413 session; no anonymous private reads or writes", semantics: "Atomic USDC strings; expectedVersion and commandId required. Submission never sends a payment." });
    if (req.method === "GET" && url.pathname === "/") {
      // The wallet connector loads from jsDelivr, fetches its wallet list over https, and runs each
      // wallet as inline script in a sandboxed srcdoc frame, which inherits this policy: so inline
      // scripts must be allowed. The page never writes untrusted text as HTML (textContent only).
      res.setHeader(
        "content-security-policy",
        "frame-ancestors 'none'; default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https:; connect-src 'self' https: wss:; frame-src https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'",
      );
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(invoicePage(TITLE, process.env.HOSTED_INVOICE_BASE ?? ""));
    }
    if (req.method === "GET" && url.pathname === "/invoice-browser.js")
      return res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(invoiceBrowser);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

    // Same-origin writes only: with a SameSite cookie this closes cross-site requests outright.
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: "Wrong origin." });

    if (url.pathname.startsWith("/internal/agreements") || url.pathname === "/internal/work-orders" || url.pathname === "/internal/compensation") return await internal(req, res, url.pathname);

    // Agent connections are managed only from the contractor's own browser session; an agent can never mint one.
    const managed = url.pathname.match(/^\/api\/agent-connections(?:\/([0-9a-f-]{36}))?$/);
    if (managed) {
      if (req.headers.authorization !== undefined) return send(res, 403, { error: "Manage agent connections from your signed-in browser session." });
      const account = session.account(req);
      if (!account) return send(res, 401, { error: "Sign in with the account being paid." });
      const principal = { role: PAYEE_ROLE, account, host: PUBLIC_HOST, instance: INSTANCE, agentId: agentId() };
      if (req.method === "GET" && !managed[1]) return send(res, 200, { connections: connections.list(principal) });
      if (req.method === "DELETE" && managed[1]) return connections.revoke(managed[1], principal) ? send(res, 200, { revoked: true }) : send(res, 404, { error: "No such agent connection." });
      if (req.method === "POST" && !managed[1]) {
        if (!allowed("connect", account)) return send(res, 429, { error: "Too many agent connections started. Try again later." });
        const parsed = agentConnectionIssue.safeParse(await readJson(req));
        if (!parsed.success) throw new BadRequest("Choose a label and a duration between one minute and 24 hours.");
        if (session.account(req) !== account) return send(res, 401, { error: "Sign in again before connecting an agent." });
        return send(res, 201, connections.issue({ ...principal, ...parsed.data, permissions: PAYEE_REPORT_PERMISSIONS }));
      }
      return send(res, 405, { error: "Use GET or POST, or DELETE on an existing connection." });
    }
    // A request carrying credentials is an agent connection or nothing: the cookie is never consulted, and only
    // the connection's explicitly permitted routes are reachable. It can never open or become a browser session.
    let viaConnection: AgentConnection | null = null;
    if (url.pathname.startsWith("/api/") && req.headers.authorization !== undefined) {
      viaConnection = connections.authenticate(req.headers.authorization, { host: PUBLIC_HOST, instance: INSTANCE, agentId: agentId() });
      if (!viaConnection) return send(res, 401, { error: "Invalid, expired or revoked agent connection." });
      if (!connectionUse(viaConnection.id)) return send(res, 429, { error: "Request limit reached." });
      const permission = CONNECTION_ROUTES[`${req.method} ${url.pathname}`];
      if (!permission || !connectionMay(viaConnection, permission)) return send(res, 403, { error: "This agent connection does not permit that action." });
      if (req.method === "GET") attribute(viaConnection, req.method, url.pathname);
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const account = session.account(req);
      return send(res, 200, { account, agreed: account ? (await agreed()).has(account) : false });
    }

    if (req.method === "POST" && url.pathname === "/api/signin/challenge") return send(res, ...challengeAnswer(PUBLIC_HOST, allowed("signin", ip)));

    // Report intake needs its authenticated recipient and retained terms, not provider availability.
    if (req.method === "GET" && url.pathname === "/api/compensation/session") return send(res, 200, { account: viaConnection?.account ?? session.account(req) });

    // A signature by a full-access key opens a session; whether the account is agreed decides what it files.
    if (req.method === "POST" && ["/api/signin", "/api/compensation/signin"].includes(url.pathname)) {
      const signIn = parseSignIn(await readJson(req));
      let account: string;
      try {
        account = await verifySignIn(signIn, PUBLIC_HOST, chainKeyLookup);
      } catch (error) {
        // Everything here is public (account, public key, signature, nonce, URLs): kept to diagnose wallets.
        console.warn("sign-in refused", JSON.stringify({ ...signIn, host: PUBLIC_HOST, reason: String(error) }));
        return send(res, 403, { error: error instanceof Error ? error.message : "Sign-in failed." });
      }
      return send(res, 200, { account, ...(url.pathname === "/api/signin" && { agreed: (await agreed()).has(account) }) }, { "set-cookie": session.open(account) });
    }

    if (req.method === "POST" && url.pathname === "/api/signout")
      return send(res, 200, { account: null }, { "set-cookie": session.close() });

    const payee = viaConnection ? viaConnection.account : session.account(req);
    if (url.pathname.startsWith("/api/") && !payee) return send(res, 401, { error: "Sign in with the account being paid." });

    if (req.method === "GET" && url.pathname === "/api/compensation") {
      const view = compensationList(payee!);
      const redact = (record: unknown) => {
        const r = record as Record<string, unknown>;
        return { ...r, ...("recordedBy" in r && { recordedBy: "owner" }), ...("reviewedBy" in r && { reviewedBy: r.reviewedBy ? "owner" : null }) };
      };
      const invoices = await mine(payee!);
      return send(res, 200, { account: payee, agreements: view.agreements.map(redact), requests: view.requests.map(redact),
        history: compensationHistory(payee!).map(h => ({ ...h, actor: h.actor === payee ? payee : "owner", record: redact(h.record) })),
        payments: await Promise.all(view.requests.filter(r => r.payment).map(async r => {
          if (r.payment!.mode === "isolated") {
            try {
              const order = getWorkOrder(agentId(), r.payment!.id);
              if (order.payee !== payee || order.id !== r.id) throw new Error("Payout binding unavailable");
              const snapshot = publicWorkOrder(await callWorkOrder(agentId(), order.id, { type: "snapshot" }));
              return { requestId: r.id, id: order.id, status: snapshot.unavailable ? "unavailable" : snapshot.invoice?.status ?? (Date.parse(order.until) <= Date.now() ? "expired" : "preparing") };
            } catch { return { requestId: r.id, id: r.payment!.id, status: "unavailable" }; }
          }
          const id = invoiceId({ payee: r.payee, submission: r.id });
          return { requestId: r.id, id, status: invoices.find(i => i.id === id)?.status ?? "preparation_incomplete" };
        })) });
    }
    if (req.method === "POST" && url.pathname === "/api/compensation") {
      if (!allowed("file", payee!)) return send(res, 429, { code: "rate_limited", error: "Too many attempts. Keep this draft and try later." });
      const parsed = reportCommand.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Check your request.", issues: parsed.error.issues });
      if (viaConnection) {
        // Re-checked immediately before acting: a connection revoked or expired since admission sends nothing.
        if (!connections.authenticate(req.headers.authorization, { host: PUBLIC_HOST, instance: INSTANCE, agentId: agentId() }))
          return send(res, 401, { error: "Invalid, expired or revoked agent connection." });
        attribute(viaConnection, req.method, url.pathname, { commandId: parsed.data.commandId, id: parsed.data.id });
      }
      return send(res, 200, saveCompensationRequest(payee!, parsed.data));
    }

    if (req.method === "GET" && url.pathname === "/api/work-orders") {
      const orders = listWorkOrders(agentId()).filter(order => order.payee === payee);
      return send(res, 200, { orders: orders.map(({ id, amount, note, until, createdAt }) => ({ id, amount, note, until, createdAt })) });
    }
    if (req.method === "POST" && url.pathname === "/api/work-orders") {
      const body = await readJson(req);
      if (!payeeWorkOrderRequest.safeParse(body).success) throw new BadRequest("Enter an amount, work description and deadline. Work order recipients are fixed to your signed-in account.");
      if (!allowed("file", payee!)) return send(res, 429, { error: "Too many attempts. Try again later." });
      const result = await requestWorkOrder(payee!, body);
      if ("conflict" in result) return send(res, 409, { error: "This request already has different terms. Review the existing work order before starting another." });
      if ("full" in result) return send(res, 429, { error: "The work order request queue is full. Review your existing requests or contact the owner." });
      return send(res, 200, result);
    }
    const workOrder = url.pathname.match(/^\/api\/work-orders\/([0-9a-f-]{36})(\/file)?$/);
    if (workOrder && (req.method === "GET" || req.method === "POST")) {
      const id = workOrder[1]!;
      const order = listWorkOrders(agentId()).find(order => order.id === id && order.payee === payee);
      if (!order) return send(res, 404, { error: "Work order not found." });
      if (req.method === "GET" && !workOrder[2])
        return send(res, 200, publicWorkOrder(await callWorkOrder(agentId(), id, { type: "snapshot" })));
      if (req.method === "POST" && workOrder[2]) {
        if (!allowed("file", payee!)) return send(res, 429, { error: "Too many attempts. Try again later." });
        // The authenticated account and durable order determine every term. Body overrides are rejected.
        const body = await readJson(req);
        if (Object.keys(body).length) return send(res, 400, { error: "Work order terms cannot be changed when filing an invoice." });
        getWorkOrder(agentId(), id);
        try { return send(res, 200, await callWorkOrder(agentId(), id, { type: "file", payee: payee! })); }
        catch (error) {
          // Refused before any send. Disconnects and timeouts are not refusals and stay generic.
          if (error instanceof WorkOrderRefusal) return send(res, 409, { code: error.code,
            error: "This order can't be filed yet: the owner must authorize it and fund exactly the agreed amount. Nothing was sent. Check this order again later." });
          throw error;
        }
      }
    }

    // Files the confirmed invoice once, always paying the signed-in account; an account the owner
    // hasn't agreed to pay files an agreement request instead, and nothing is paid.
    if (req.method === "POST" && url.pathname === "/api/invoices") {
      if (!allowed("file", payee!)) return send(res, 429, { error: "Too many attempts. Try again later." });
      const input = await readJson(req);
      const invoice = validate({ ...input, payee });
      if ("invalid" in invoice) return send(res, 400, { error: `Check the ${invoice.invalid}.` });
      if (compensationList(payee!).agreements.length && !getInvoice(invoiceId(invoice)))
        return send(res, 409, { code: "review_required", error: "Submit a report & payment request under your recorded agreement before payment preparation." });
      const payees = await agreed();
      if (!payees.has(payee!)) return send(res, 200, requestAgreement(invoice, payees));
      return send(res, 200, await file(invoice, payee!));
    }

    // Continue only the authenticated payee's durable, never-submitted identity.
    // Client-supplied terms are ignored; file() rechecks state and serializes concurrent requests.
    const continuation = url.pathname.match(/^\/api\/invoices\/([0-9a-f]{32})\/continue$/);
    if (req.method === "POST" && continuation) {
      if (!allowed("file", payee!)) return send(res, 429, { error: "Too many attempts. Try again later." });
      const invoice = getInvoice(continuation[1]!);
      if (!invoice || invoice.payee !== payee) return send(res, 404, { error: "Invoice not found." });
      if (invoice.review || invoice.operation.submissionState !== "PREPARED")
        return send(res, 409, { error: "This invoice cannot be continued. Review its existing payment status; do not create a replacement." });
      return send(res, 200, await file({ payee: invoice.payee, submission: invoice.submission, amount: invoice.amount, note: invoice.note }, payee!));
    }

    // The signed-in payee's invoices and agreements, with their current status.
    if (req.method === "GET" && url.pathname === "/api/invoices") {
      const payees = await agreed();
      const own = agreements(payees).filter((a) => a.payee === payee && a.status !== "filed")
        .map(({ id, origin, amount, note, submission, terms, status, at }) => ({ id, origin, amount, note, submission, terms, status, at }));
      return send(res, 200, { invoices: await mine(payee!), agreements: own, agreed: payees.has(payee!) });
    }
    send(res, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof CompensationError) return send(res, error.code === "not_found" ? 404 : 409, { code: error.code, error: error.message });
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
    if (path === "/internal/compensation") {
      const body = await readJson(req);
      if (body.parentAgentId !== agentId() || typeof body.actor !== "string" || !body.actor) throw new BadRequest("Compensation owner binding unavailable.");
      return send(res, 200, { result: await localCompensation(agentId(), body.actor, compensationOwnerCommand.parse(body.command)) });
    }
    if (path === "/internal/work-orders") {
      const body = await readJson(req) as Record<string, unknown>;
      if (body.parentAgentId !== agentId()) throw new BadRequest("Work order parent does not match this executor.");
      return send(res, 200, { result: await localWorkOrders(agentId(), workOrderRequest.parse(body.request)) });
    }
    return await answerInternal(res, path, (await readJson(req)) as Record<string, unknown>);
  } catch (error) {
    // The caller is this agent's own dashboard: it sees why, unlike a payee.
    return send(res, 400, { error: error instanceof Error ? error.message : "Malformed request.", ...(error instanceof CompensationError && { code: error.code }),
      // A work order's proven pre-send refusal crosses to the approve-only host; nothing else is marked as one.
      ...(error instanceof WorkOrderRefusal && { refusal: error.code }) });
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
