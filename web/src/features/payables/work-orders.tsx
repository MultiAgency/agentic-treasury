import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BASE, client, errorMessage, fromUnits, toUnits } from "../../shared/lib";
import { useAgent } from "../../app/agent-context";
import { gatewayQueries } from "../../app/queries";
import { useCanCall } from "../../app/viewer";
import { Field, FieldGroup, focusInvalid } from "../../shared/form";
import { accountError, deadlineError } from "../../shared/form-validation";
import { useDirtyDraft } from "../../shared/dirty-draft";
import { Badge, Button, CopyButton, Details, ErrorBox, Loading, QueryError, Section } from "../../shared/ui";
import { ConfirmButton } from "../owner/confirm-button";
import { useOwnerAction, useSigner, type OwnerAction } from "../owner/owner";
import type { WorkOrderOwnerAction } from "../../../../src/work-order-protocol.js";

const listKey = ["workOrders", BASE];
type Order = Awaited<ReturnType<typeof client.workOrders.list>>[number];
type Snapshot = Awaited<ReturnType<typeof client.workOrders.get>>;
const date = (value: string) => new Date(value).toLocaleString();
// getRandomValues also works for local HTTP previews; identity always uses secure random bytes.
const newIdentity = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Work-order authority and payment observations stay separate from the shared payout agent. */
export function WorkOrders({ payments = false }: { payments?: boolean }) {
  const cache = useQueryClient();
  const orders = useQuery({ queryKey: listKey, queryFn: () => client.workOrders.list(), retry: false });
  const [selected, select] = useState<string>();
  const [formVersion, setFormVersion] = useState(0);
  return <Section title={payments ? "Work order payments" : "Work orders"}
    description="One payee, a fixed USDC amount and a deadline. Each work order has separate payment authority and still requires owner approval.">
    {!payments && <Details key={formVersion} summary="Create a work order"><NewWorkOrder onCreated={id => { select(id); setFormVersion(value => value + 1); void cache.invalidateQueries({ queryKey: listKey }); }} /></Details>}
    {orders.isPending && <Loading label="Loading work orders" />}
    {orders.error && <QueryError error={orders.error} retry={() => orders.refetch()} />}
    {orders.isSuccess && orders.data.length === 0 && <p className="text-sm text-muted-foreground">No work orders yet.{payments && " Create one in Agreements."}</p>}
    <ul className="divide-y">
      {orders.data?.map(order => <li key={order.id} id={`work-order-${order.id}`} className="scroll-mt-24 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto"><h3 className="break-words font-medium">{order.note}</h3>
            <p className="break-words text-sm text-muted-foreground">{order.payee} · {fromUnits(order.amount, 6)} USDC · deadline {date(order.until)}</p></div>
          <Button variant="outline" aria-expanded={selected === order.id} onClick={() => select(selected === order.id ? undefined : order.id)}>
            {selected === order.id ? "Close work order" : "Review work order"}
          </Button>
        </div>
        {selected === order.id && <WorkOrderDetail key={order.id} order={order} />}
      </li>)}
    </ul>
  </Section>;
}

function NewWorkOrder({ onCreated }: { onCreated: (id: string) => void }) {
  const permitted = useCanCall("workOrders/create");
  const [id, setId] = useState(newIdentity);
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [until, setUntil] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useDirtyDraft(Boolean(payee || amount || note));
  const units = toUnits(amount, 6);
  const errors = { payee: accountError(payee), amount: units && BigInt(units) > 0n && units.length <= 18 ? undefined : "Enter a positive USDC amount with at most six decimals.",
    note: note.trim() && note.length <= 200 ? undefined : "Describe the agreed work in 200 characters or fewer.", until: deadlineError(until) };
  return <form noValidate className="flex flex-col gap-4" onSubmit={async event => {
    event.preventDefault(); setSubmitted(true);
    if (Object.values(errors).some(Boolean)) { focusInvalid(event.currentTarget); return; }
    if (!permitted || busy) return;
    setBusy(true); setError(undefined);
    try {
      const order = await client.workOrders.create({ id, payee: payee.trim(), amount: units!, note: note.trim(), until: `${until}T23:59:59.999Z` });
      onCreated(order.id); setId(newIdentity()); setPayee(""); setAmount(""); setNote(""); setSubmitted(false);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }}>
    <FieldGroup className="sm:grid sm:grid-cols-2">
      <Field label="Work order payee" value={payee} onChange={e => setPayee(e.target.value)} disabled={busy} autoCapitalize="none" spellCheck={false} placeholder="payee.near" error={submitted ? errors.payee : undefined} />
      <Field label="Fixed amount (USDC)" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} inputMode="decimal" error={submitted ? errors.amount : undefined} />
      <Field label="Agreed work" value={note} onChange={e => setNote(e.target.value)} disabled={busy} maxLength={200} error={submitted ? errors.note : undefined} />
      <Field label="Work order deadline (UTC)" type="date" value={until} onChange={e => setUntil(e.target.value)} disabled={busy} error={submitted ? errors.until : undefined} />
    </FieldGroup>
    <p className="text-sm text-muted-foreground">Saving records fixed terms. Next, the owner signs the policy and grant, then funds the work order. Grant expiry stops new submissions; a payment already accepted may finish later.</p>
    <Button type="submit" disabled={!permitted || busy}>{busy ? "Saving work order…" : "Save work order"}</Button>
    <ErrorBox error={error} />
    {error && <p className="text-sm">Refresh the work-order list before starting another order. This form keeps its original reference.</p>}
  </form>;
}

function actionName(action: OwnerAction): WorkOrderOwnerAction {
  if (action.type === "agent_create") return "create";
  if (action.type === "grant_issue") return "grant";
  if (action.type === "grant_revoke") return "revoke";
  if (action.type === "approval_vote") return action.verdict;
  throw new Error("Unsupported work order owner action.");
}

function WorkOrderDetail({ order }: { order: Order }) {
  const { setup } = useAgent();
  const signer = useSigner(setup);
  const query = useQuery({ queryKey: [...listKey, order.id], queryFn: () => client.workOrders.get({ id: order.id }), refetchInterval: 10_000, retry: false });
  const gateway = useQuery(gatewayQueries.session);
  const action = useOwnerAction(setup, { followHref: `#work-order-${order.id}`, transport: {
    prepare: ({ action, signer }, options) => client.workOrders.prepare({ id: order.id, action: actionName(action), signer }, options),
    submit: (input, options) => client.workOrders.submit({ id: order.id, ...input }, options),
    status: (input, options) => client.workOrders.status({ id: order.id, ...input }, options),
    actions: async () => (await client.workOrders.get({ id: order.id })).ownerActions,
  } });
  const [deposit, setDeposit] = useState<Awaited<ReturnType<typeof client.workOrders.deposit>>>();
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositError, setDepositError] = useState<string>();
  const canDeposit = useCanCall("workOrders/deposit");
  const snapshot = query.data;
  const expired = Date.parse(order.until) <= Date.now();
  const open = snapshot?.ownerActions.some(a => a.stage === "prepared" || a.stage === "submitted");
  const disabled = !signer.canSign || action.busy || Boolean(open || query.error || snapshot?.error);
  const terms = `${fromUnits(order.amount, 6)} USDC to ${order.payee} for ${order.note}. Deadline: ${date(order.until)}.`;
  const control = (name: string, ownerAction: OwnerAction, description: string, unavailable = false) =>
    <ConfirmButton key={name} path="workOrders/prepare" label={name} title={name} confirm={name}
      description={`${terms} ${description}`} reviewKey={JSON.stringify([order, ownerAction])}
      disabled={disabled || unavailable} onConfirm={() => void action.run(ownerAction)} />;
  let link: string | undefined;
  if (gateway.data?.invoices) { const url = new URL(gateway.data.invoices, location.origin); url.searchParams.set("workOrder", order.id); link = url.href; }
  return <div className="mt-4 flex flex-col gap-4 text-sm">
    {query.isPending && <Loading label="Checking this work order" />}
    {query.error && <QueryError error={query.error} retry={() => query.refetch()} />}
    {snapshot && <>
      <div className="flex flex-wrap items-center gap-2"><Badge tone={snapshot.invoice?.status === "paid" ? "success" : "neutral"}>{orderStatus(snapshot, expired)}</Badge>
        <Button variant="ghost" onClick={() => void query.refetch()}>Refresh work order</Button></div>
      <ErrorBox error={snapshot.error ?? undefined} />
      <p>Recorded payment: {snapshot.invoice ? snapshot.invoice.status === "waiting" ? "Held for owner approval; not paid." : snapshot.invoice.status : "No invoice filed."}</p>
      <p>Confidential balance: {snapshot.balance === null ? "unavailable" : `${fromUnits(snapshot.balance, 6)} USDC`}. {snapshot.grant ? `Grant expires ${date(snapshot.grant.expiresAt)}.` : "No matching live grant observed."}</p>
      <div className="flex flex-wrap gap-2">
        {!snapshot.agentId && control("Authorize work order", { type: "agent_create" }, "Sign a separate policy allowing only confidential USDC payments to this payee, with this amount as the per-payment cap. Every payout requires owner approval.", expired || snapshot.ownerActions.some(a => a.type === "agent_create"))}
        {snapshot.agentId && !snapshot.grant && control("Authorize invoice grant", { type: "grant_issue", label: "invoices" }, "Allow invoice submission until the deadline under this work order's policy.", expired || !snapshot.policyReady)}
        {snapshot.approval && <>
          {control("Approve work order payment", { type: "approval_vote", ...snapshot.approval, verdict: "approve" }, "Release this held payout. Approval is separate from confirmed payment.")}
          {control("Reject work order payment", { type: "approval_vote", ...snapshot.approval, verdict: "reject" }, "Reject this held payout.")}
        </>}
        {snapshot.grant && control("Revoke work order grant", { type: "grant_revoke", grantId: snapshot.grant.id }, "Stop new submissions. An accepted payment can still finish; residual funds remain in the order account.")}
      </div>
      {!signer.canSign && <p>Use the owner's wallet or an authorized DAO member account to authorize this work order.</p>}
      {snapshot.ownerActions.length > 0 && <Details summary="Work order owner actions">
        {snapshot.ownerActions.map(a => <p key={a.correlationId} className="break-words">{a.type.replaceAll("_", " ")} · {a.stage} · {a.status ?? "outcome not confirmed"}</p>)}
        {open && <p>Follow this existing action. A prepared wallet action waits for its signing window to close if it was interrupted; do not create a replacement work order.</p>}
      </Details>}
      {snapshot.policyReady && snapshot.grant && !snapshot.invoice && !expired && <Details summary="Fund this work order">
        <p>Obtain a confidential deposit address, then send USDC on NEAR from your wallet. Funding is separate from authorizing the invoice.</p>
        <Button variant="outline" disabled={!canDeposit || depositBusy || Boolean(query.error || snapshot.error)} onClick={async () => {
          setDepositBusy(true); setDepositError(undefined); setDeposit(undefined);
          try { setDeposit(await client.workOrders.deposit({ id: order.id })); } catch (e) { setDepositError(errorMessage(e)); } finally { setDepositBusy(false); }
        }}>{depositBusy ? "Getting deposit address…" : "Get USDC deposit address"}</Button>
        <ErrorBox error={depositError} />
        {deposit && <div className="flex flex-col gap-2"><p className="break-all">Deposit address: {deposit.address} <CopyButton text={deposit.address} /></p>
          {deposit.memo && <p className="break-all">Required memo: {deposit.memo} <CopyButton text={deposit.memo} /></p>}
          {deposit.minAmount && <p>Minimum deposit (atomic units): {deposit.minAmount}</p>}
          {deposit.expiresAt && <p>Address expires {date(deposit.expiresAt)}. Request a fresh address after expiry.</p>}
        </div>}
      </Details>}
      {link ? <p><a href={link} target="_blank" rel="noopener noreferrer" className="underline">Open work order on the invoice page</a> <CopyButton text={link} /> Share with {order.payee}, who signs in with that account.</p>
        : <p>The invoice page address is not configured here.</p>}
      <Details summary="Work order reference"><p className="break-all">{order.id} <CopyButton text={order.id} /></p>
        <p>Payment identity is retained after failures and restarts. An expired grant does not return residual funds or establish payment completion.</p></Details>
    </>}
    <p role="status">{action.label}</p><ErrorBox error={action.error} />
  </div>;
}

function orderStatus(snapshot: Snapshot, expired: boolean) {
  if (snapshot.error) return "Observations unavailable";
  if (snapshot.invoice) return snapshot.invoice.status === "waiting" ? "Held payout" : snapshot.invoice.status;
  if (expired) return "Deadline passed";
  if (!snapshot.agentId) return "Needs owner authorization";
  if (!snapshot.policyReady) return "Policy needs review";
  if (!snapshot.grant) return "Needs invoice grant";
  if (snapshot.balance === null || BigInt(snapshot.balance) < BigInt(snapshot.order.amount)) return "Needs funding";
  return "Ready for invoice";
}
