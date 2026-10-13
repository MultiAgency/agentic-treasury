import type { Policy as AgentPolicy } from "@near-intents-agent-api/sdk";
import { useState } from "react";
import type { Overview } from "./lib";
import { ownerSigner, type Setup, useOwnerAction } from "./owner";
import { BUDGET, changesOf, type Draft, differences, draftOf, WINDOWS } from "./policy-draft";
import { Button, Card, ErrorBox, input, Spinner } from "./ui";

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
export function Editor({ policy, data, setup, onDone }: { policy: AgentPolicy; data: Overview; setup: Setup; onDone: () => void }) {
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
        <ErrorBox error={action.error} />
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
