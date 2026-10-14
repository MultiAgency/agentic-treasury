import { queries } from "../../shared/queries";
import { SCHEDULE_STOPPED, SCHEDULE_STOP_SCOPE } from "../../shared/schedule-copy";
import { usePaymentStatus } from "../payables/use-payment-status";
import { PaymentOutcome } from "../payables/payment-outcome";
import { paymentProgress } from "../payables/payment-progress";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { client, exactPayment, useAttempt } from "../../shared/lib";
import { useIsOperator } from "../../app/viewer";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { OwnerActions } from "./owner-actions";
import { Badge, Button, ErrorBox, Loading, QueryError, Section, StatusBadge } from "../../shared/ui";

/** Provider-independent identity is an observation, never permission to send. */
export const instanceQuery = queries.instance;

export function StopSchedule() {
  const instance = useQuery(instanceQuery);
  const operator = useIsOperator();
  const stop = useAttempt([["autopilot"], ["strategy"]]);
  return <Section title="Schedule">
    <p>{SCHEDULE_STOP_SCOPE}</p>
    {!operator ? <p>Only an operator can stop the schedule.</p>
      : instance.isPending ? <Loading label="Checking executor identity…" />
      : instance.error ? <p>Executor identity is unavailable. Check again before stopping the schedule.</p>
      : instance.data?.executor === false ? <p>Stop the schedule on the executor; this instance is approve-only.</p>
      : !instance.data?.agentId ? <p>No agent is configured on this instance.</p> : null}
    {instance.error && <QueryError error={instance.error} retry={() => instance.refetch()} />}
    <Button variant="outline" disabled={!operator || !instance.data?.agentId || instance.data.executor !== true || stop.busy}
      onClick={() => stop.attempt(async () => { await client.autopilot.stop(); return SCHEDULE_STOPPED; })}>Turn off</Button>
    {stop.message && <p role="status">{stop.message}</p>}<ErrorBox error={stop.error} />
  </Section>;
}

/** Saved payment links remain inspectable without balances, policy or owner setup. No signing controls. */
export function PaymentRecovery() {
  const id = useSearch({ strict: false }).payment;
  const status = usePaymentStatus(id);
  const data = accessDenied(status.error) ? undefined : status.data;
  const progress = paymentProgress({ status: data?.status, statusError: Boolean(status.error), ownerError: true, approved: false, rejected: false });
  return <Section title="Follow this payment">
    <p>Owner setup or policy observations are not yet available. Payment outcomes remain readable; signing is unavailable here.</p>
    {!id ? <p>Open a saved payment link to inspect its outcome.</p> : <>
      <PaymentOutcome progress={progress} statusError={Boolean(status.error)} paid={data?.status === "SUCCESS"} failed={["FAILED", "REFUNDED"].includes(data?.status ?? "")} />
      {status.isPending && <Loading label="Checking payment outcome…" />}
      {status.error && <ReadFailure label="Payment outcome" error={status.error} retry={() => status.refetch()} retained={status.data !== undefined} updatedAt={status.dataUpdatedAt} />}
      {data && <>{status.error ? <Badge>Last reported: {data.status.toLowerCase()}</Badge> : <StatusBadge status={data.status} />}<p>{data.request ? exactPayment(data.request, []) : "Payment terms unavailable"}</p>
        {data.detailError && <p>{data.detailError}</p>}</>}
      <p className="break-all">Operation {id}</p>
    </>}
    <p>Owner approval and payment settlement are separate outcomes.</p>
    <Link to="/activity" className="underline">Review existing records in Activity</Link>
    <OwnerActions />
  </Section>;
}
