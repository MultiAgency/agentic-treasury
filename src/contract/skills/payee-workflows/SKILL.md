---
name: payee-workflows
description: >
  Use when a payee (contributor) app or the payee's own external agent works with a MultiAgency payee entry through
  @multiagency/sdk/payee: submitting a compensation report, recovering a lost reply by the report's id, following the
  report to its recorded payment, and starting, listing or revoking an agent connection that lets an agent outside a
  browser report for the payee. Not for owner actions (use owner-workflows).
metadata:
  purpose: 'Payee reports and their payment status with payeeClient, from a browser session or an agent connection, with recovery by kept identities.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.1.0'
requires:
  - getting-started
sources:
  - 'MultiAgency/agentic-treasury-private:src/contract/client.ts'
  - 'MultiAgency/agentic-treasury-private:src/contract/agent-connection.ts'
  - 'MultiAgency/agentic-treasury-private:src/compensation-contract.ts'
  - 'MultiAgency/agentic-treasury-private:docs/agent-access.md'
---

# Payee workflows with payeeClient

Read getting-started first for identities and result kinds. A payee reaches only their own records on one payee entry.
A report records work and a requested amount; it never sends a payment. The owner reviews it, and the owner's own
signed steps pay it.

## Setup

In the payee's signed-in browser page (same-origin cookie):

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export const payee = payeeClient();
```

In the payee's own agent, outside a browser, with a connection token the payee started (no cookie is sent):

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export const agentFor = (entry: string, token: string) => payeeClient({ base: entry, token });
```

Result: `await client.compensationSession()` answers `{ ok: true, value: { account } }` for the payee's account.

## Submit a report and recover a lost reply by its id

Mint `commandId` and `id` once, keep them, and reuse the exact same command if you must send again: the entry
returns the same record for an identical command.

```ts
import { payeeClient } from "@multiagency/sdk/payee";

type Command = Parameters<ReturnType<typeof payeeClient>["submitReport"]>[0];

export async function report(client: ReturnType<typeof payeeClient>, command: Command) {
  const sent = await client.submitReport(command);
  if (sent.ok || sent.kind !== "unknown") return sent;
  // The reply was lost: read the payee's records by the kept request id instead of submitting a replacement.
  const view = await client.compensation();
  if (!view.ok) return view;
  const found = view.value.requests.find(request => request.id === command.id);
  return found ? { ok: true as const, value: found } : sent;
}
```

## Follow the same request to its recorded payment

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export async function paymentOf(client: ReturnType<typeof payeeClient>, requestId: string) {
  const view = await client.compensation();
  if (!view.ok) return view;
  const request = view.value.requests.find(r => r.id === requestId);
  const payment = view.value.payments.find(p => p.requestId === requestId);
  return { ok: true as const, value: { state: request?.state ?? null, payment: payment?.status ?? null } };
}
```

Result: `state` moves from `submitted` to `approved` when the owner approves the amount; `payment` reaches `paid` only
after settlement is recorded. Approval is not payment.

## Connect an agent (from the payee's browser session)

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export async function connectAgent(browser: ReturnType<typeof payeeClient>) {
  const started = await browser.startAgentConnection({ label: "Report agent", ttlSeconds: 3600 });
  if (!started.ok) return started; // a lost start is `unavailable`: list connections and revoke any orphan
  // Give `token` to the agent once; it is never shown again. `permissions` is the whole of its reach.
  return { ok: true as const, value: { token: started.value.token, permissions: started.value.connection.permissions } };
}

export async function revokeAll(browser: ReturnType<typeof payeeClient>) {
  const listed = await browser.agentConnections();
  if (!listed.ok) return listed;
  for (const connection of listed.value.connections.filter(c => !c.revoked)) await browser.revokeAgentConnection(connection.id);
  return { ok: true as const, value: listed.value.connections.length };
}
```

An agent connection permits `compensation.read` and `compensation.submit` only. With the token, every other route is
`forbidden`, and an expired, revoked or wrong-entry token is `session`. Connections are managed from the browser
session only: a request carrying a token cannot start, list or revoke one.

## Common mistakes

- **A new `commandId` or `id` after `unknown`** (CRITICAL): it creates a second report. Read by the kept `id`.
- **Using an agent connection to file invoices or work orders** (HIGH): filing stays with the person; the connection
  answers `forbidden`.
- **Reading "approved" as paid** (HIGH): only a `paid` payment status is settlement.
- **Copying the payee's cookie or wallet key into an agent** (CRITICAL): start an agent connection instead.

## Completion

The report's record is read by its `id`, and its payment status is the last value read. If a result stays `unknown`
or `unavailable`, report it with the kept `commandId` and `id`; do not submit a replacement.
