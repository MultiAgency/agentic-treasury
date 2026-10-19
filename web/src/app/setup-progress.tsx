import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useRef } from "react";
import { queries } from "../shared/queries";
import { BASE, type Overview, kindOf } from "../shared/lib";
import { type Setup } from "../features/owner/owner";
import { useAppHref } from "../features/demo/app-link";
import { useGateway } from "./gateway-context";
import { Button, Loading, Section } from "../shared/ui";
import { ReadFailure } from "../shared/read-failure";

/** Recorded setup work is inspected before offering another owner action. No signing or submission. */
export function useSetupActions(creationOnly = false) {
  const query = useQuery({ ...queries.ownerActions, retry: false });
  const known = Array.isArray(query.data);
  const records = known ? query.data!.filter(a => creationOnly ? a.type === "agent_create" : ["agent_create", "grant_issue", "policy_update"].includes(a.type)) : [];
  const unfinished = records.filter(a => a.stage === "prepared" || a.stage === "submitted");
  // A succeeded creation with no configured agent still needs observation, never a replacement create.
  const awaitingSetup = creationOnly && records.some(a => a.ownerSucceeded);
  return { query, records, unfinished, blocked: !known || query.isPending || query.isError || unfinished.length > 0 || awaitingSetup };
}

export function SetupActions({ state }: { state: ReturnType<typeof useSetupActions> }) {
  const cache = useQueryClient();
  const { query, records } = state;
  return <Section title="Existing setup actions" description="Records on this instance only. Check an existing request before preparing another one.">
    {query.isPending && <Loading label="Checking existing setup actions…" />}
    {query.error && <ReadFailure label="Setup actions" error={query.error} retry={() => query.refetch()} retained={query.data !== undefined} updatedAt={query.dataUpdatedAt} />}
    {query.isSuccess && !Array.isArray(query.data) && <p className="text-sm">Setup action records were not provided. Check again before creating an agent.</p>}
    {query.isSuccess && Array.isArray(query.data) && !records.length && <p className="text-sm">No matching setup actions recorded on this instance. A proposal or request started elsewhere may still exist.</p>}
    {records.length > 0 && <ul className="space-y-3 text-sm">{records.map(a => <li key={a.correlationId} className="flex flex-col gap-1">
      <p className="font-medium">{a.type.replaceAll("_", " ")} · {a.signer === "dao" ? "DAO proposal" : "Owner wallet"}</p>
      <p>{a.stage === "submitted" ? "Submission attempted. Its outcome is not yet confirmed here; do not sign again."
        : a.stage === "prepared" ? "Prepared request. Review this request and any existing DAO proposal before signing again."
        : a.stage === "expired" ? "Signing window closed without a recorded submission attempt."
        : a.ownerSucceeded ? "Owner action succeeded. Refresh setup to check what is now configured."
        : `Recorded outcome: ${a.status ?? "not available"}. Review this result before starting again.`}</p>
      <p className="break-all font-mono text-xs">{a.correlationId}</p>
    </li>)}</ul>}
    <Button variant="outline" size="sm" className="self-start" disabled={query.isFetching} onClick={() => { void query.refetch(); void cache.invalidateQueries({ queryKey: ["setup"] }); }}>Check setup status</Button>
  </Section>;
}

/** After the agent is created: the next setup task, in the agent's app. Policy and grants are reviewed and signed there. */
export function SetupNextStep({ setup, overview }: { setup: Setup; overview?: Overview }) {
  const guided = useGateway()?.walkthroughs;
  const pathname = useLocation({ select: location => location.pathname });
  const treasury = overview ? kindOf(overview) === "treasury" : undefined;
  const app = useAppHref(treasury ? "treasury" : "payables");
  const appName = treasury ? "Treasury" : "Payables";
  const entry = useRef({ withoutGrant: !setup.grant, pathname });
  // Setup can span several routes before the grant arrives. Resume on the route where it completes.
  if (!setup.grant) entry.current = { withoutGrant: true, pathname };
  if (setup.grant) {
    if (!entry.current.withoutGrant || pathname !== entry.current.pathname) return null;
    const policyKnown = overview?.notInForce === null;
    const fundingNeeded = policyKnown && overview.book.length > 0 && overview.book.every(holding => BigInt(holding.public) + BigInt(holding.confidential) === 0n);
    return <Section title="Continue to your next task" description="An agent and grant are now reported. Each action still requires its own authorization and balance checks.">
      {guided && policyKnown && !fundingNeeded
        ? <a href={`${BASE}/demos/${treasury ? "treasury" : "payables"}`} className="self-start underline">Continue to walkthrough</a>
        : <a href={app(!policyKnown ? "/policy" : fundingNeeded ? "/funding" : treasury ? "/automations" : "/")} className="self-start underline">{!policyKnown ? "Review policy and permissions" : fundingNeeded ? "Continue to funding" : treasury ? "Continue to Strategy" : "Continue to Payments"} in {appName}</a>}
      <p className="text-sm">A grant report does not settle every owner action. <a href={app("/activity")} className="underline">Review existing action outcomes in {appName} Activity</a>.</p>
    </Section>;
  }
  return <IncompleteSetup setup={setup} overview={overview} />;
}

function IncompleteSetup({ setup, overview }: { setup: Setup; overview?: Overview }) {
  const state = useSetupActions();
  const treasury = overview ? kindOf(overview) === "treasury" : undefined;
  const app = useAppHref(treasury ? "treasury" : "payables");
  const policyMissing = overview?.notInForce !== null;
  return <Section title="Continue setup" description="An agent is configured. Wallet connection, owner approval, policy application and a live grant are separate steps.">
    {state.blocked ? <SetupActions state={state} /> : <>
      <p className="text-sm">{!overview ? "Policy observations are unavailable. Review them before authorizing an action."
        : policyMissing ? `Review the policy first: ${overview.notInForce ?? "its current state is not confirmed"}.`
        : "The policy is reported in force. This does not establish permission or funds for a particular action."}</p>
      <p className="text-sm">{setup.executor === false ? "This instance is approve-only; it does not hold an executor grant token." : "No current grant was reported for this instance."}</p>
      <a href={app(policyMissing ? "/policy" : treasury ? "/automations" : "/policy", !policyMissing && treasury === false ? "grants" : undefined)} className="self-start underline">
        {policyMissing ? `Review policy and permissions in ${treasury ? "Treasury" : "Payables"}` : treasury ? "Review and authorize the strategy in Treasury" : "Review the grant in Payables"}
      </a>
      <p className="text-sm text-muted-foreground">{treasury === true ? "Treasury’s Strategy reviews the allocation and schedule separately." : treasury === false ? "Payables reviews or prepares a payment after permissions are confirmed." : "The task destination depends on the agent’s area."} Existing records remain available.</p>
    </>}
  </Section>;
}
