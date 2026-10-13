import { PencilSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { Grants, Mandate } from "./grants";
import { amountOf, usd } from "./lib";
import { OwnerControls, ownerName, useSigner } from "./owner";
import { BUDGET, type Window, WINDOWS } from "./policy-draft";
import { Editor } from "./policy-editor";
import { useAgent } from "./shell";
import { Badge, Button, Details, Section, statusTone } from "./ui";

/** The policy the owner signed and the owner's controls over it. */
export function Policy() {
  const { data, setup } = useAgent();
  const { canSign } = useSigner(setup);
  const [editing, setEditing] = useState(false);
  const { policy } = data.policy;
  if (!policy) return <p className="text-sm text-muted-foreground">No policy yet.</p>;
  const caps = (window: Window) =>
    Object.entries(policy.limits?.[window] ?? {})
      .map(([asset, raw]) => amountOf(raw, asset, data.book))
      .join(" · ") || "None";
  const budget = BUDGET.flatMap(([key, label]) => (policy.budget[key] ? [`${usd(policy.budget[key])} ${label}`] : [])).join(" · ");
  const rows: [string, string][] = [
    ["Owner", ownerName(setup)],
    ["Actions", policy.actions.join(", ") || "None"],
    ["Assets", policy.assets === "any" ? "Any" : policy.assets.map((a) => data.book.find((h) => h.asset === a)?.symbol ?? a).join(", ")],
    ...WINDOWS.map(([window, label]): [string, string] => [`Caps ${label.toLowerCase()}`, caps(window)]),
    ["USD budget", budget || "None"],
    [
      "Destinations",
      policy.destinations?.mode === "only" && policy.destinations.list.length === 0
        ? "None. Funds never leave the account."
        : `${policy.destinations?.mode}: ${policy.destinations?.list.map((d) => d.address).join(", ")}`,
    ],
  ];
  const more: [string, string][] = [
    ["Rate", policy.max_actions_per_hour ? `${policy.max_actions_per_hour} actions an hour` : "No cap"],
    ["Owner approval", policy.owner_approval ? "Every payment" : "Not required inside the policy"],
    ["Confidential", policy.confidential ? "Enabled" : "Disabled"],
  ];
  const list = (entries: [string, string][]) => (
    <dl className="grid gap-x-10 gap-y-5 text-sm sm:grid-cols-2">
      {entries.map(([term, detail]) => (
        <div key={term} className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{term}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <>
      <Section
        title="Policy"
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
          <Editor policy={policy} data={data} setup={setup} onDone={() => setEditing(false)} />
        ) : (
          <>
            {list(rows)}
            <Details summary="Rate, owner approval, confidentiality">{list(more)}</Details>
          </>
        )}
      </Section>
      <Grants data={data} setup={setup} />
      <Mandate digest={data.digest} />
    </>
  );
}
