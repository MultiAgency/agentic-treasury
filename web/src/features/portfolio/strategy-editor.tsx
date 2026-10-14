import { useEffect, useRef, useState } from "react";
import type { Strategy } from "../../../../src/strategy-digest";
import { confirmDiscard, useDirtyDraft } from "../../shared/dirty-draft";
import { Field, focusInvalid } from "../../shared/form";
import { parseStrategyDraft, strategyDraft } from "./strategy-form";
import { Button, Details, ErrorBox, Spinner } from "../../shared/ui";

export function StrategySummary({ strategy, nameOf, advanced = true }: { strategy: Strategy; nameOf: (asset: string) => string; advanced?: boolean }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">
    <div><dt className="text-muted-foreground">Target allocation</dt><dd>{Object.entries(strategy.targetBps).map(([asset, bps]) => `${bps / 100}% ${nameOf(asset)}`).join(" · ")}</dd></div>
    <div><dt className="text-muted-foreground">Schedule</dt><dd>Every {strategy.autopilot.everyMin} minutes</dd></div>
    <div><dt className="text-muted-foreground">Automatic rebalance ceiling</dt><dd>${strategy.autopilot.maxUsd}{strategy.autopilot.maxUsd === 0 && " · swaps require manual execution"}</dd></div>
    {advanced && <div><dt className="text-muted-foreground">Minimum swap</dt><dd>${strategy.minLegUsd}</dd></div>}
    {advanced && <div><dt className="text-muted-foreground">Maximum cost at the guaranteed floor</dt><dd>{strategy.maxCostBps / 100}%</dd></div>}
  </dl>;
}

/** A reviewed draft, saved by its parent through an operator-only endpoint. Never enables autopilot. */
export function StrategyEditor({ strategy, digest, latest, nameOf, onSave, onClose }: {
  strategy: Strategy;
  digest: string;
  latest?: { strategy: Strategy; digest: string };
  nameOf: (asset: string) => string;
  onSave: (strategy: Strategy, expectedDigest: string) => Promise<void>;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [baseDigest, setBaseDigest] = useState(digest);
  const stale = Boolean(latest && latest.digest !== baseDigest);
  const [draft, setDraft] = useState(() => strategyDraft(strategy));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Strategy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { heading.current?.focus(); }, [Boolean(review)]);
  const [saved, setSaved] = useState(false);
  useDirtyDraft(!saved && JSON.stringify(draft) !== JSON.stringify(strategyDraft(strategy)));
  const field = (key: "everyMin" | "maxUsd" | "minLegUsd" | "maxCost", label: string) => <Field label={label}
    inputMode={key === "maxCost" ? "decimal" : "numeric"} value={draft[key]} error={errors[key]}
    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />;
  const save = async () => {
    if (!review || busy || stale) return;
    setBusy(true); setError(undefined);
    try { await onSave(review, baseDigest); setSaved(true); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "The strategy could not be saved. Review its current state before trying again."); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-4 rounded-xl border p-4">
    <h3 ref={heading} tabIndex={-1} className="scroll-mt-48 font-medium">{review ? "Review strategy change" : "Edit strategy"}</h3>
    {stale && latest && <div className="flex flex-col gap-3" role="alert">
      <p>The saved strategy changed. Your draft is preserved. Compare the current settings below before reviewing your draft again.</p>
      <StrategySummary strategy={latest.strategy} nameOf={nameOf} />
      <Button variant="outline" onClick={() => { setBaseDigest(latest.digest); setReview(null); setError(undefined); }}>Review against latest strategy</Button>
    </div>}
    {review ? <>
      <StrategySummary strategy={review} nameOf={nameOf} />
      <p className="text-sm">Saving turns autopilot off. The owner must authorize this strategy with a matching grant before an operator turns it on. The signed policy's caps and budget still apply.</p>
      <p className="text-sm text-muted-foreground">Existing operations may still settle. This change does not cancel them or change the signed policy.</p>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back to edit</Button>
        <Button disabled={busy || stale} onClick={save}>{busy && <Spinner />} Save with autopilot off</Button>
      </div>
    </> : <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      const parsed = parseStrategyDraft(draft);
      setErrors(parsed.errors);
      if (parsed.strategy) { setReview(parsed.strategy); setError(undefined); }
      else focusInvalid(e.currentTarget);
    }}>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">Target allocation · total 100%</legend>
        {Object.entries(draft.targets).map(([asset, value]) => <Field key={asset} label={`${nameOf(asset)} (%)`} inputMode="decimal"
          value={value} error={errors[asset] ?? errors.targets}
          onChange={(e) => setDraft({ ...draft, targets: { ...draft.targets, [asset]: e.target.value } })} />)}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("everyMin", "Run every (minutes)")}
        {field("maxUsd", "Automatic rebalance ceiling (USD)")}
      </div>
      <p className="text-sm text-muted-foreground">$0 leaves swaps for manual execution. With a matching grant, scheduled runs can still shield public balances.</p>
      <Details summary="Swap limits" open={Boolean(errors.minLegUsd || errors.maxCost)}>
        <div className="grid gap-3 sm:grid-cols-2">{field("minLegUsd", "Minimum swap (USD)")}{field("maxCost", "Maximum cost at the guaranteed floor (%)")}</div>
      </Details>
      <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="ghost" onClick={() => { if (JSON.stringify(draft) === JSON.stringify(strategyDraft(strategy)) || confirmDiscard()) onClose(); }}>Cancel</Button><Button type="submit">Review change</Button></div>
    </form>}
    <ErrorBox error={error} />
  </div>;
}
