import { ConfirmButton } from "../owner/confirm-button";
import { queries } from "../../shared/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { client, useAttempt } from "../../shared/lib";
import { useAgent } from "../../app/agent-context";
import { useIsOperator } from "../../app/viewer";
import { useOwnerAction, useSigner, WalletButton } from "../owner/owner";
import { StrategyEditor, StrategySummary } from "./strategy-editor";
import { strategyProgress } from "./strategy-progress";
import { strategyPresentation } from "./strategy-presentation";
import { strategyQuery } from "./strategy-readiness";
import { Badge, Button, Card, Details, ErrorBox, Loading, QueryError } from "../../shared/ui";

type Snapshot = Awaited<ReturnType<typeof client.strategy.get>>;
export function StrategyWorkflow() {
  const { setup, data } = useAgent();
  const operator = useIsOperator();
  const executor = setup.executor !== false;
  const queryClient = useQueryClient();
  const status = useQuery(strategyQuery);
  // Kept independently so stop remains available when strategy/provider reads fail.
  const schedule = useQuery({ ...queries.autopilot, retry: false, refetchInterval: 30_000 });
  const actions = useQuery({ ...queries.ownerActions, retry: false, refetchInterval: 5_000 });
  const owner = useOwnerAction(setup);
  const signer = useSigner(setup);
  const operation = useAttempt([["strategy"], ["autopilot"]]);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const enableRegion = useRef<HTMLDivElement>(null);
  const previousEditing = useRef(false);
  const previousReview = useRef(false);
  const authorizing = useRef(false);
  const [checkingOwner, setCheckingOwner] = useState(false);
  const [editing, setEditing] = useState<Snapshot>();
  const [savedMessage, setSavedMessage] = useState<string>();
  const [review, setReview] = useState<Snapshot>();
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
    else if (previousReview.current) (reviewTrigger.current ?? enableRegion.current?.querySelector("button"))?.focus();
    if (!editing && previousEditing.current) editTrigger.current?.focus();
    previousEditing.current = Boolean(editing);
    previousReview.current = Boolean(review);
  }, [editing, review]);
  const pendingGrant = actions.data?.find(a => a.type === "grant_issue" && (a.stage === "prepared" || a.stage === "submitted"));
  const nameOf = (asset: string) => data.book.find(h => h.asset === asset)?.symbol ?? asset;
  const busy = operation.busy || owner.busy || checkingOwner;
  const view = strategyPresentation({ status, schedule, actions, review, executor, operator, busy, canSign: signer.canSign });
  const { value, ready, currentReview } = view;
  const progress = value ? strategyProgress({ editing: Boolean(editing), statusUnknown: Boolean(status.error),
    actionsUnknown: !actions.isSuccess || Boolean(actions.error), pendingGrant: pendingGrant?.stage,
    grantMatches: value.grantMatches, scheduleOn: schedule.error ? undefined : schedule.data?.on, executor, ready }) : undefined;
  const stop = () => operation.attempt(async () => {
    setSavedMessage(undefined);
    await client.autopilot.stop();
    return "Schedule off. Operations already submitted may still finish.";
  });
  return <Card>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium">Portfolio strategy</h3>
      {view.scheduleLabel && <Badge>{view.scheduleLabel}</Badge>}
      {view.showStop && <Button variant="outline" disabled={busy} onClick={stop}>Turn off</Button>}
    </div>
    {schedule.isPending && <Loading label="Checking autopilot settings…" />}
    {schedule.error && <QueryError error={schedule.error} retry={() => schedule.refetch()} />}
    {status.isPending && <Loading label="Checking strategy authorization…" />}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    {!status.isPending && !status.error && !value && <QueryError error={new Error("Strategy readiness is unavailable on this server.")} retry={() => status.refetch()} />}
    {value && <>
      <Badge>{view.readinessLabel}</Badge>
      {progress && <>
        <ol aria-label="Strategy setup" className="grid gap-3 text-sm sm:grid-cols-3">
          <li className="rounded-lg bg-muted p-3"><span className="block font-medium">1. Configure</span><p>{progress.configuration}</p></li>
          <li className="rounded-lg bg-muted p-3"><span className="block font-medium">2. Authorize</span><p>{progress.authorization}</p></li>
          <li className="rounded-lg bg-muted p-3"><span className="block font-medium">3. Enable schedule</span><p>{progress.schedule}</p></li>
        </ol>
        {!review && <p className="text-sm">{progress.next}</p>}
      </>}
      {status.error ? <p className="text-sm">Showing the last loaded strategy. Current authorization could not be checked.</p>
        : value.readiness.reasons.map(reason => <p key={reason} className="text-sm">{reason}</p>)}
      <section aria-label="Saved configuration" className="flex flex-col items-start gap-3 border-t pt-5">
      <h4 className="font-medium">Saved configuration</h4>
      {editing ? <StrategyEditor strategy={editing.strategy} digest={editing.digest} latest={value} nameOf={nameOf}
        onClose={() => setEditing(undefined)} onSave={async (strategy, expectedDigest) => {
          try { await client.strategy.save({ strategy, expectedDigest }); setSavedMessage("Strategy saved. Schedule off; review authorization before enabling."); }
          finally { await Promise.all([queryClient.invalidateQueries(strategyQuery), queryClient.invalidateQueries({ queryKey: ["autopilot"] }), queryClient.invalidateQueries({ queryKey: ["overview"] })]); }
        }} /> : <>
        {!review && <><StrategySummary strategy={value.strategy} nameOf={nameOf} advanced={false} />
        <Details summary="Swap limits"><p className="text-sm">Minimum swap: ${value.strategy.minLegUsd}. Maximum cost at the guaranteed floor: {value.strategy.maxCostBps / 100}%.</p></Details>
        {operator && executor && <Button ref={editTrigger} variant="outline" disabled={!view.canEdit} onClick={() => { setSavedMessage(undefined); setReview(undefined); setEditing(value); }}>Edit strategy</Button>}</>}
      </>}</section>
      <section aria-label="Owner authorization" className="flex flex-col items-start gap-3 border-t pt-5">
      <h4 className="font-medium">Owner authorization</h4>
      {!editing && <>
        {!executor && <p className="text-sm">Review authorization and configure the strategy on its executor.</p>}
        {executor && schedule.data?.on && <p className="text-sm">Turn the schedule off before reviewing {value.grantMatches ? "a grant renewal" : "a new authorization"}.</p>}
        {executor && !pendingGrant && !review && <Button ref={reviewTrigger} variant={value.grantMatches ? "outline" : "default"} disabled={!view.canReview} onClick={() => { setSavedMessage(undefined); setReview(value); }}>{value.grantMatches ? "Review grant renewal" : "Review authorization"}</Button>}
        {review && <div className="flex flex-col gap-3 border-t pt-4">
          <h4 ref={reviewHeading} tabIndex={-1} className="scroll-mt-48 font-medium">{review.grantMatches ? "Renew the grant for this saved strategy" : "Authorize this saved strategy"}</h4>
          <StrategySummary strategy={review.strategy} nameOf={nameOf} />
          {review.grantMatches && <p className="text-sm">Issue a new grant before the current one expires, using the same saved strategy. No strategy change or prior revocation is required.</p>}
          <p className="text-sm">The grant lets this executor act inside the signed policy for 30 days. It authorizes these targets and limits; it does not enable the schedule. A $0 ceiling leaves swaps for manual execution, but scheduled shielding can still run.</p>
          <Link to="/policy" className="text-sm underline">Review the policy’s caps and budget</Link>
          {!currentReview && <p role="alert">The saved strategy changed or could not be checked. Review it again before authorizing.</p>}
          {signer.needsWallet && <WalletButton />}
          {signer.connectedNotOwner && <p>Connect the owner’s wallet to authorize this strategy.</p>}
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" disabled={busy} onClick={() => setReview(undefined)}>Cancel review</Button>
            <Button disabled={!view.canAuthorize} onClick={async () => {
              if (authorizing.current) return;
              authorizing.current = true; setCheckingOwner(true);
              try {
                const fresh = await actions.refetch();
                if (fresh.error || fresh.data?.some(a => a.type === "grant_issue" && (a.stage === "prepared" || a.stage === "submitted"))) return;
                if (await owner.run({ type: "grant_issue", label: "treasury", expectedStrategyDigest: review.digest })) setReview(undefined);
              } finally { authorizing.current = false; setCheckingOwner(false); }
            }}>{review.grantMatches ? signer.viaDao ? "Propose grant renewal" : "Renew in wallet" : signer.viaDao ? "Propose strategy authorization" : "Authorize in wallet"}</Button>
          </div>
        </div>}
      </>}</section>
      <section aria-label="Schedule control" className="flex flex-col items-start gap-3 border-t pt-5">
      <h4 className="font-medium">Schedule</h4>
      <p className="text-sm">Authorization and schedule enablement are separate decisions.</p>
      {!editing && <>
        {executor && value.grantMatches && !schedule.data?.on && !review && <div ref={enableRegion}><ConfirmButton label="Turn on" title="Let the agent act on its own?"
          description={`Every ${value.strategy.autopilot.everyMin} minutes this server may shield public balances and execute rebalances up to $${value.strategy.autopilot.maxUsd}. Each operation is checked against current authorization before submission.`}
          confirm="Turn on" reviewKey={value.digest} disabled={!view.canEnable}
          onConfirm={() => operation.attempt(async () => { await client.autopilot.enable({ expectedDigest: value.digest }); setSavedMessage(undefined); return "Schedule enabled. Operation outcomes are reported separately."; })} /></div>}
      </>}
      </section>
      {ready && schedule.data?.on && !schedule.error && !editing && !review && <div className="flex flex-col items-start gap-2">
        <p className="text-sm">Next: follow the scheduled run, or review Run now on the run page.</p>
        <Link to="/follow/run" className="inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-medium hover:bg-accent">Follow treasury runs</Link>
      </div>}
      <Details summary="Strategy digest"><code className="break-all text-xs">{value.digest}</code></Details>
    </>}
    {pendingGrant && <p role="status" className="text-sm">An owner grant action is already {pendingGrant.stage}. Follow its existing record before signing again. <Link to="/activity" hash={`owner-${pendingGrant.correlationId}`} className="underline">Review owner action</Link></p>}
    {actions.error && <QueryError error={actions.error} retry={() => actions.refetch()} />}
    {owner.label && <p role="status" className="text-sm">{owner.label}</p>}
    <ErrorBox error={owner.error ?? operation.error} />
    {savedMessage && <p role="status" className="text-sm">{savedMessage}</p>}
    {operation.message && <p role="status" className="text-sm">{operation.message}</p>}
  </Card>;
}
