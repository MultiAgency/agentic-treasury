import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../src/signin.js";
import { payoutPolicy } from "../src/policy.js";
import { recordCompensationAgreement } from "../src/compensation-store.js";
import { closeWorkOrders } from "../src/work-order-pool.js";
import type { Status, mine } from "../src/invoices.js";
import type { AgreementStatus } from "../src/agreements.js";
import type { PublicWorkOrder as ServedWorkOrder } from "../src/work-order-protocol.js";
import { payeeClient, type Invoice, type InvoiceStatus, type PublicWorkOrder, type Result } from "../src/contract/index.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory } from "./fixtures/harness.js";

// Compile-time: the package's types are exactly what the handlers produce. Drift fails `pnpm typecheck`.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const statuses: Same<InvoiceStatus, Status> = true;
const agreementStatuses: Same<import("../src/contract/index.js").Agreement["status"], AgreementStatus> = true;
const served: (order: ServedWorkOrder) => PublicWorkOrder = order => order;
const invoices: (invoice: Awaited<ReturnType<typeof mine>>[number]) => Invoice = invoice => invoice;
void [statuses, agreementStatuses, served, invoices];

freshDirectory("contract-contributor", { per: "suite" });
const secret = "contract-contributor-test-session-secret";
Object.assign(process.env, { INVOICES_PUBLIC_HOST: "localhost:8791", INVOICES_SESSION_SECRET: secret, AGREEMENTS_SECRET: "contract-test-bridge", AGENT_GRANT_TOKEN: "ngt_test" });
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string, sent = 0;
before(async () => {
  Object.assign(api, { ...authorityFixture(), getPolicy: async () => policyView(payoutPolicy(["alice.near"])),
    forGrant: () => ({ transfer: async () => { sent++; return { correlation_id: `contract-${sent}` }; } }),
    getStatus: async (correlation_id: string) => ({ correlation_id, status: "PENDING_APPROVAL" }),
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await closeWorkOrders(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

/** The package client against Proto's real contributor handler; the cookie stands in for the browser's. */
const as = (account?: string) => payeeClient({ base: origin, fetch: (url, init) =>
  fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...(account && { cookie: `invoices_session=${sessionToken(account, secret)}` }) } }) });
const value = <T>(result: Result<T>): T => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };
/** The handler's raw JSON, to prove the package schemas keep every field they are given. */
const raw = async (path: string, account: string) => (await fetch(`${origin}${path}`, { headers: { cookie: `invoices_session=${sessionToken(account, secret)}` } })).json();

test("capabilities and signed-out reads parse; private reads report a session failure, not a refusal", async () => {
  assert.deepEqual(value(await as().capabilities()).product, "invoices");
  assert.deepEqual(value(await as().session()), { account: null, agreed: false });
  assert.deepEqual(await as().invoices(), { ok: false, kind: "session", status: 401, error: "Sign in with the account being paid." });
  assert.equal((await as().workOrders() as { kind?: string }).kind, "session");
  assert.equal((await as().compensation() as { kind?: string }).kind, "session");
});

test("invoice filing, listing and work-order reads parse against the package schemas", async () => {
  const alice = as("alice.near"), carol = as("carol.near");
  assert.deepEqual(value(await alice.session()), { account: "alice.near", agreed: true });
  const submission = randomUUID();
  const filed = value(await alice.submitInvoice({ submission, amount: "1", note: "Contract check" }));
  assert.equal(value(await alice.submitInvoice({ submission, amount: "1", note: "Contract check" })).id, filed.id);
  assert.equal(sent, 1);
  const listed = value(await alice.invoices());
  assert.deepEqual(listed, await raw("/api/invoices", "alice.near"));
  assert.deepEqual(listed.invoices.map(i => i.id), [filed.id]);
  assert.equal(value(await carol.submitInvoice({ submission: randomUUID(), amount: "2", note: "Not yet agreed" })).status, "requested");
  assert.equal(value(await carol.invoices()).agreements.length, 1);
  assert.deepEqual(value(await alice.workOrders()), await raw("/api/work-orders", "alice.near"));
  assert.deepEqual(value(await alice.session()), await raw("/api/session", "alice.near"));
  const missing = await alice.workOrder(randomUUID());
  assert.equal(!missing.ok && missing.kind, "refused");
});

test("report submission and the contributor's compensation view parse; exact retries keep their receipt", async () => {
  const alice = as("alice.near");
  const agreement = recordCompensationAgreement("member.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, terms: { payee: "alice.near", title: "October",
    document: "https://example.test/agreement", signedOn: "2026-10-01", start: "2026-10-01", end: "2026-10-31", ceiling: "10000000", openingApproved: "0", scope: "Contract check" } });
  const command = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true,
    report: { agreementId: agreement.id, start: "2026-10-01", end: "2026-10-15", contributions: "Delivered", assessment: "Ready", evidence: [] } };
  const first = value(await alice.submitReport(command));
  assert.deepEqual(value(await alice.submitReport(command)), first);
  const stale = await alice.submitReport({ ...command, commandId: randomUUID() });
  assert.deepEqual(!stale.ok && [stale.kind, "code" in stale && stale.code], ["refused", "stale_request"]);
  const view = value(await alice.compensation());
  assert.equal(view.agreements[0]!.recordedBy, "owner");
  // The schema must not strip what the handler sends: the contributor's remaining ceiling is presented.
  assert.deepEqual(view, await raw("/api/compensation", "alice.near"));
  assert.equal(view.agreements[0]!.remaining, "10000000");
  assert.deepEqual(view.requests.map(r => r.id), [command.id]);
});
