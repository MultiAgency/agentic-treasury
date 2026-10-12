import { CheckCircle, Copy, PencilSimple, XCircle } from "@phosphor-icons/react";
import type { Policy as AgentPolicy } from "@near-intents-agent-api/sdk";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, amount, client, fromUnits, type Holding, type Overview, toUnits, usd } from "./lib";
import {
  ActionError,
  OwnerControls,
  ownerName,
  ownerSigner,
  type PolicyChanges,
  type Setup,
  useCanSign,
  useOwnerAction,
} from "./owner";
import { useAgent } from "./shell";
import { connect, useWallet } from "./wallet";
import { Badge, Button, Card, ConfirmButton, input, Section, Spinner, statusTone } from "./ui";

const WINDOWS = [
  ["per_transaction", "Per payment"],
  ["hourly", "Per hour"],
  ["daily", "Per day"],
  ["monthly", "Per month"],
] as const;
type Window = (typeof WINDOWS)[number][0];
const BUDGET = [
  ["daily_usd", "a day"],
  ["weekly_usd", "a week"],
  ["monthly_usd", "a month"],
] as const;

/** The owner-editable part of a policy, as the form holds it: amounts in whole units, blank for none. */
type Draft = {
  swap: boolean;
  assets: string[];
  ownerApproval: boolean;
  rate: string;
  budget: Record<(typeof BUDGET)[number][0], string>;
  caps: Record<Window, Record<string, string>>;
};

function draftOf(policy: AgentPolicy, book: Holding[]): Draft {
  const caps = (window: Window) =>
    Object.fromEntries(
      book.map((h) => {
        const raw = policy.limits?.[window]?.[h.asset];
        return [h.asset, raw ? fromUnits(raw, h.decimals) : ""];
      }),
    );
  return {
    swap: policy.actions.includes("swap"),
    assets: policy.assets === "any" ? book.map((h) => h.asset) : policy.assets,
    ownerApproval: policy.owner_approval,
    rate: policy.max_actions_per_hour?.toString() ?? "",
    budget: {
      daily_usd: policy.budget.daily_usd ?? "",
      weekly_usd: policy.budget.weekly_usd ?? "",
      monthly_usd: policy.budget.monthly_usd ?? "",
    },
    caps: { per_transaction: caps("per_transaction"), hourly: caps("hourly"), daily: caps("daily"), monthly: caps("monthly") },
  };
}

/** The changes a draft asks for, or the first field that isn't a valid amount. */
function changesOf(draft: Draft, book: Holding[]): { changes: PolicyChanges } | { invalid: string } {
  const limits: Partial<Record<Window, Record<string, string>>> = {};
  for (const [window, label] of WINDOWS) {
    const entries: [string, string][] = [];
    for (const h of book) {
      const value = draft.caps[window][h.asset]?.trim();
      if (!value || !draft.assets.includes(h.asset)) continue;
      const raw = toUnits(value, h.decimals);
      if (!raw) return { invalid: `${h.symbol} ${label.toLowerCase()}` };
      entries.push([h.asset, raw]);
    }
    if (entries.length) limits[window] = Object.fromEntries(entries);
  }
  const budget = Object.fromEntries(BUDGET.map(([key]) => [key, draft.budget[key].trim() || null])) as Record<
    (typeof BUDGET)[number][0],
    string | null
  >;
  for (const [key, label] of BUDGET)
    if (budget[key] !== null && !/^\d+(\.\d+)?$/.test(budget[key])) return { invalid: `the budget ${label}` };
  const rate = draft.rate.trim() ? Number(draft.rate) : null;
  if (rate !== null && !(Number.isInteger(rate) && rate > 0)) return { invalid: "actions an hour" };
  return {
    changes: {
      swap: draft.swap,
      assets: draft.assets,
      owner_approval: draft.ownerApproval,
      max_actions_per_hour: rate,
      budget,
      limits,
    },
  };
}

/** One line per field the draft changes, in the words the envelope uses. */
function differences(before: Draft, after: Draft, book: Holding[]) {
  const symbol = (asset: string) => book.find((h) => h.asset === asset)?.symbol ?? asset;
  const list = (assets: string[]) => assets.map(symbol).sort().join(", ") || "none";
  const lines: string[] = [];
  const change = (label: string, from: string, to: string) => from !== to && lines.push(`${label}: ${from} → ${to}`);
  change("Swaps", before.swap ? "allowed" : "off", after.swap ? "allowed" : "off");
  change("Assets", list(before.assets), list(after.assets));
  change("Owner approval", before.ownerApproval ? "every payment" : "not required", after.ownerApproval ? "every payment" : "not required");
  change("Actions an hour", before.rate || "no cap", after.rate || "no cap");
  for (const [key, label] of BUDGET)
    change(`Budget ${label}`, before.budget[key] ? usd(before.budget[key]) : "none", after.budget[key] ? usd(after.budget[key]) : "none");
  for (const [window, label] of WINDOWS)
    for (const h of book) {
      const was = before.assets.includes(h.asset) ? before.caps[window][h.asset] : "";
      const now = after.assets.includes(h.asset) ? after.caps[window][h.asset] : "";
      change(`${h.symbol} ${label.toLowerCase()}`, was ? `${was} ${h.symbol}` : "none", now ? `${now} ${h.symbol}` : "none");
    }
  return lines;
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}
    </label>
  );
}

/**
 * Edits the envelope and proposes it as one policy update, signed like every owner action: by
 * the owner's wallet, or by the DAO in one proposal. Destinations are edited under Payees.
 */
function Editor({ data, setup, onDone }: { data: Overview; setup: Setup; onDone: () => void }) {
  const policy = data.policy.policy!;
  const initial = draftOf(policy, data.book);
  const [draft, setDraft] = useState(initial);
  const [reviewing, setReviewing] = useState(false);
  const action = useOwnerAction(setup);
  const result = changesOf(draft, data.book);
  const lines = differences(initial, draft, data.book);
  const set = (patch: Partial<Draft>) => {
    setReviewing(false);
    setDraft({ ...draft, ...patch });
  };
  const viaDao = ownerSigner(setup) === "dao";

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h3 className="text-lg font-medium">What the agent may do</h3>
        <Toggle checked={draft.swap} onChange={(swap) => set({ swap })}>
          Swap between its assets
        </Toggle>
        <Toggle checked={draft.ownerApproval} onChange={(ownerApproval) => set({ ownerApproval })}>
          Every payment waits for the owner's approval
        </Toggle>
        <div className="flex flex-wrap gap-4">
          {data.book.map((h) => (
            <Toggle
              key={h.asset}
              checked={draft.assets.includes(h.asset)}
              onChange={(on) => set({ assets: on ? [...draft.assets, h.asset] : draft.assets.filter((a) => a !== h.asset) })}
            >
              {h.symbol}
            </Toggle>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <h3 className="text-lg font-medium">Caps per asset</h3>
        <p className="text-sm text-muted-foreground">Rolling windows. Blank means no cap in that window.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2 font-normal">Asset</th>
                {WINDOWS.map(([window, label]) => (
                  <th key={window} className="pb-2 font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.book
                .filter((h) => draft.assets.includes(h.asset))
                .map((h) => (
                  <tr key={h.asset}>
                    <td className="py-1 pr-3">{h.symbol}</td>
                    {WINDOWS.map(([window]) => (
                      <td key={window} className="py-1 pr-2">
                        <input
                          className={`${input} w-full`}
                          inputMode="decimal"
                          placeholder="No cap"
                          value={draft.caps[window][h.asset] ?? ""}
                          onChange={(e) =>
                            set({ caps: { ...draft.caps, [window]: { ...draft.caps[window], [h.asset]: e.target.value } } })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t pt-5 sm:grid-cols-4">
        {BUDGET.map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">USD budget {label}</span>
            <input
              className={input}
              inputMode="decimal"
              placeholder="No cap"
              value={draft.budget[key]}
              onChange={(e) => set({ budget: { ...draft.budget, [key]: e.target.value } })}
            />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Actions an hour</span>
          <input className={input} inputMode="numeric" placeholder="No cap" value={draft.rate} onChange={(e) => set({ rate: e.target.value })} />
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        {"invalid" in result && <p className="text-sm text-warning-muted-foreground">Check {result.invalid}: it isn't a valid amount.</p>}
        {reviewing && "changes" in result && (
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-muted-foreground">
              {viaDao ? "The DAO will be asked to sign these changes:" : "You will sign these changes:"}
            </span>
            <ul className="flex flex-col gap-1">
              {lines.map((line) => (
                <li key={line} className="font-mono text-xs">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ActionError error={action.error} />
        <div className="flex flex-wrap items-center gap-3">
          {reviewing && "changes" in result ? (
            <Button
              disabled={action.busy}
              onClick={async () => {
                if (await action.run({ type: "policy_update", changes: result.changes })) onDone();
              }}
            >
              {action.busy && <Spinner />} {viaDao ? "Propose in Trezu" : "Sign update"}
            </Button>
          ) : (
            <Button disabled={!("changes" in result) || lines.length === 0} onClick={() => setReviewing(true)}>
              Review changes
            </Button>
          )}
          <Button variant="ghost" disabled={action.busy} onClick={onDone}>
            Cancel
          </Button>
          {action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
        </div>
        {action.digest && (
          <p className="text-sm text-muted-foreground">
            Mandate being signed: <span className="break-all font-mono text-xs text-foreground">{action.digest}</span>
          </p>
        )}
      </div>
    </Card>
  );
}

/** One held payment's request, in words: what, how much, to whom. */
function describe(request: Record<string, unknown>, book: Holding[]) {
  const asset = String(request.asset ?? request.origin_asset ?? "");
  const h = book.find((b) => b.asset === asset);
  const value = h && request.amount ? amount(String(request.amount), h) : `${request.amount ?? ""} ${asset}`;
  return request.recipient ? `${value} to ${request.recipient}` : value;
}

/** Payments the policy holds for the owner: each one released or rejected by its own vote. */
/** How long the API keeps a held payment approvable (the server's APPROVAL_TTL_MS). */
const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

function Held({ data, setup }: { data: Overview; setup: Setup }) {
  const held = useQuery({ queryKey: ["held"], queryFn: () => client.held(), refetchInterval: 15_000 });
  const action = useOwnerAction(setup);
  const canSign = useCanSign(setup);
  const [voting, setVoting] = useState<string>();
  if (!held.data?.length) return null;
  const viaDao = ownerSigner(setup) === "dao";

  const vote = async (item: (typeof held.data)[number], verdict: "approve" | "reject") => {
    setVoting(item.correlationId);
    await action.run({ type: "approval_vote", approvalId: item.approvalId, verdict, correlationId: item.correlationId });
    setVoting(undefined);
  };

  return (
    <Section
      title="Waiting for approval"
      description={
        viaDao
          ? "A payment stays approvable for 24 hours. Approve files one proposal, and the API's signing window closes about five minutes later, so vote in Trezu right away."
          : "A payment stays approvable for 24 hours and waits for your signature."
      }
    >
      <Card>
        <ul className="flex flex-col divide-y">
          {held.data.map((item) => (
            <li key={item.correlationId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-1 text-sm">
                <span>{describe(item.request, data.book)}</span>
                <span className="text-muted-foreground">
                  {item.kind} · requested {ago(item.at)} · expires {ago(new Date(Date.parse(item.at) + APPROVAL_WINDOW_MS).toISOString())}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {voting === item.correlationId && action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
                <Button size="sm" disabled={action.busy || !canSign} onClick={() => vote(item, "approve")}>
                  {voting === item.correlationId && action.busy ? <Spinner /> : <CheckCircle size={16} />} Approve
                </Button>
                <Button size="sm" variant="outline" disabled={action.busy || !canSign} onClick={() => vote(item, "reject")}>
                  <XCircle size={16} /> Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <ActionError error={action.error} />
      </Card>
    </Section>
  );
}

/**
 * The mandate's digest and every revision's: sha256 of the policy's canonical JSON (src/mandate.ts),
 * so anyone holding the policy can recompute it and check which mandate each action ran under.
 */
function Mandate({ digest }: { digest: string | null }) {
  const history = useQuery({ queryKey: ["policyHistory"], queryFn: () => client.policyHistory() });
  return (
    <Section title="Mandate" description="The policy's digest: recompute it from the policy JSON to check what was signed.">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="break-all font-mono text-xs">{digest ?? "No policy applied"}</span>
          {digest && (
            <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(digest)}>
              <Copy size={16} /> Copy
            </Button>
          )}
        </div>
        {history.data && history.data.length > 0 && (
          <ul className="flex flex-col divide-y border-t pt-3 text-sm">
            {history.data.map((r) => (
              <li key={`${r.revision}-${r.digest}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  Revision {r.revision ?? "–"} · {r.status.toLowerCase()}
                  {r.appliedAt && <span className="text-muted-foreground"> · {ago(r.appliedAt)}</span>}
                </span>
                <span className="font-mono text-xs text-muted-foreground" title={r.digest ?? undefined}>
                  {r.digest ? `${r.digest.slice(0, 19)}…` : "–"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

/** The policy envelope the owner signed, the owner's controls over it, and what waits for the owner. */
/**
 * The agent's live grants. Whoever holds a grant's token can act inside the policy until it expires;
 * revoking stops it at once, short of a freeze, which stops every grant.
 */
function Grants({ data, setup }: { data: Overview; setup: Setup }) {
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const canSign = useCanSign(setup);
  const [revoking, setRevoking] = useState<string>();
  const [issuing, setIssuing] = useState(false);
  const live = data.grants.filter((g) => new Date(g.expires_at) > new Date());
  if (live.length === 0) return null;
  const viaDao = ownerSigner(setup) === "dao";
  // As with freezing: a wallet owner connects first, and only the owner's account can sign.
  const needsWallet = !viaDao && wallet.status !== "connected";
  const connectedNotOwner = !viaDao && wallet.status === "connected" && !canSign;

  const revoke = async (grantId: string) => {
    setRevoking(grantId);
    await action.run({ type: "grant_revoke", grantId });
    setRevoking(undefined);
  };
  const issue = async () => {
    setIssuing(true);
    await action.run({ type: "grant_issue" });
    setIssuing(false);
  };

  return (
    <Section
      title="Grants"
      description={`Each grant lets whoever holds its token act inside the policy until it expires. Revoking one stops it at once; operations it already committed still finish.${viaDao ? " Each revocation is one DAO proposal." : ""}`}
    >
      <Card>
        <ul className="flex flex-col divide-y">
          {live.map((g) => {
            const held = g.grant_id === setup.grant?.id;
            const label = revoking === g.grant_id && action.busy ? <Spinner /> : viaDao ? "Propose to revoke" : needsWallet ? "Connect to revoke" : "Revoke";
            return (
              <li key={g.grant_id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center gap-2">
                    {g.label} {held && <Badge tone="info">Current</Badge>}
                  </span>
                  <span className="text-muted-foreground">
                    issued {ago(g.issued_at)} · expires {ago(g.expires_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {revoking === g.grant_id && action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
                  {needsWallet ? (
                    <Button size="sm" variant="outline" disabled={wallet.status === "connecting"} onClick={() => connect().catch(() => {})}>
                      {label}
                    </Button>
                  ) : held ? (
                    <ConfirmButton
                      label={label}
                      disabled={action.busy || !canSign}
                      ownerAction
                      title="Revoke the current grant?"
                      description="The agent stops: nothing moves until the owner issues a new grant. Operations it already committed still finish."
                      confirm="Revoke"
                      onConfirm={() => revoke(g.grant_id)}
                    />
                  ) : (
                    <Button size="sm" variant="outline" disabled={action.busy || !canSign} onClick={() => revoke(g.grant_id)}>
                      {label}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
          <span className="text-muted-foreground">
            A new grant replaces the current one once the owner signs it. A treasury grant's label carries the strategy in force, so
            signing it approves that strategy for the autopilot.
          </span>
          <div className="flex items-center gap-2">
            {issuing && action.label && <span className="text-muted-foreground">{action.label}</span>}
            <Button size="sm" variant="outline" disabled={action.busy || !canSign || needsWallet} onClick={issue}>
              {issuing && action.busy ? <Spinner /> : viaDao ? "Propose a new grant" : "Issue a new grant"}
            </Button>
          </div>
        </div>
        {connectedNotOwner && (
          <p className="pt-3 text-xs text-muted-foreground">
            Only {ownerName(setup)} can revoke grants. Connect that account, or run <code>pnpm revoke-grant</code> with its key.
          </p>
        )}
        <ActionError error={action.error} />
      </Card>
    </Section>
  );
}

export function Policy() {
  const { data, setup } = useAgent();
  const canSign = useCanSign(setup);
  const [editing, setEditing] = useState(false);
  const { policy } = data.policy;
  if (!policy) return <p className="text-sm text-muted-foreground">No policy yet.</p>;
  const bySymbol = new Map(data.book.map((h) => [h.asset, h]));
  const caps = (window: Window) =>
    Object.entries(policy.limits?.[window] ?? {})
      .map(([asset, raw]) => {
        const h = bySymbol.get(asset);
        return h ? amount(raw, h) : `${raw} ${asset}`;
      })
      .join(" · ") || "None";
  const budget = BUDGET.flatMap(([key, label]) => (policy.budget[key] ? [`${usd(policy.budget[key])} ${label}`] : [])).join(" · ");
  const rows: [string, string][] = [
    ["Owner", ownerName(setup)],
    ["Actions", policy.actions.join(", ") || "None"],
    ["Assets", policy.assets === "any" ? "Any" : policy.assets.map((a) => bySymbol.get(a)?.symbol ?? a).join(", ")],
    ...WINDOWS.map(([window, label]): [string, string] => [`Caps ${label.toLowerCase()}`, caps(window)]),
    ["USD budget", budget || "None"],
    ["Rate", policy.max_actions_per_hour ? `${policy.max_actions_per_hour} actions an hour` : "No cap"],
    [
      "Destinations",
      policy.destinations?.mode === "only" && policy.destinations.list.length === 0
        ? "None. Funds never leave the account."
        : `${policy.destinations?.mode}: ${policy.destinations?.list.map((d) => d.address).join(", ")}`,
    ],
    ["Owner approval", policy.owner_approval ? "Every payment" : "Not required inside the envelope"],
    ["Confidential", policy.confidential ? "Enabled" : "Disabled"],
  ];
  return (
    <>
      <Held data={data} setup={setup} />
      <Section
        title="Policy envelope"
        description="Signed by the owner and enforced by the API. The agent's grant can act only inside it."
        action={
          <div className="flex flex-wrap items-start gap-3">
            <Badge tone={policy.frozen ? "destructive" : statusTone(data.policy.status === "APPLIED" ? "SUCCESS" : data.policy.status)}>
              {policy.frozen ? "Frozen" : `Revision ${data.policy.revision} · ${data.policy.status.toLowerCase()}`}
            </Badge>
            {!editing && canSign && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <PencilSimple size={16} /> Edit
              </Button>
            )}
            <OwnerControls setup={setup} frozen={policy.frozen} />
          </div>
        }
      >
        {editing ? (
          <Editor data={data} setup={setup} onDone={() => setEditing(false)} />
        ) : (
          <dl className="grid gap-x-10 gap-y-5 text-sm sm:grid-cols-2">
            {rows.map(([term, detail]) => (
              <div key={term} className="flex flex-col gap-1">
                <dt className="text-muted-foreground">{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>
      <Grants data={data} setup={setup} />
      <Mandate digest={data.digest} />
    </>
  );
}
