import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { client, type Overview, useAttempt } from "./lib";
import { type Destination, type Setup, useCanSign, useOwnerAction } from "./owner";
import { Badge, input, StatusBadge } from "./ui";

/** What the agent's transfers share: where it may send, and how a payout is sent and reported. */

/** The policy's transfer destinations: where the agent may send funds at all. */
export function destinationsOf(data: Overview): Destination[] {
  return (data.policy.policy?.destinations.list ?? []).flatMap((d) =>
    d.action === "transfer" ? [{ address: d.address, confidential: d.confidential }] : [],
  );
}

/** Policy edits share a 10-minute cooldown per agent; freezing is exempt. */
function cooldownLeft(data: Overview) {
  const at = data.policy.cooldowns.policy_change_available_at;
  const ms = at ? new Date(at).getTime() - Date.now() : 0;
  return ms > 0 ? `${Math.ceil(ms / 60_000)} min` : null;
}

/** Owner-signed edits to the destination list, shared by returns and payees. */
export function useDestinations(data: Overview, setup: Setup) {
  const action = useOwnerAction(setup);
  const isOwner = useCanSign(setup);
  const current = destinationsOf(data);
  const cooldown = cooldownLeft(data);
  return {
    current,
    action,
    blocked: !isOwner ? "Only the owner can change the agreement." : cooldown ? `The policy can change again in ${cooldown}.` : null,
    add: (destination: Destination) =>
      action.run({ type: "policy_update", changes: { destinations: [...current, destination] } }),
    remove: (address: string) =>
      action.run({ type: "policy_update", changes: { destinations: current.filter((d) => d.address !== address) } }),
  };
}

/** Sends one transfer and reports it the way the policy answered: settled, or refused. */
export function usePayout() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.pay>>>();
  const run = useAttempt();
  return {
    result,
    ...run,
    pay: (request: Parameters<typeof client.pay>[0]) =>
      run.attempt(async () => {
        setResult(undefined);
        setResult(await client.pay(request));
      }),
  };
}

export function PayoutResult({ result }: { result?: Awaited<ReturnType<typeof client.pay>> }) {
  if (!result) return null;
  return result.outcome === "refused" ? (
    <Badge tone="warning">
      Refused · <span className="font-mono">{result.code}</span>
    </Badge>
  ) : result.status === "PENDING_APPROVAL" ? (
    <Link to="/policy">
      <Badge tone="info">Waiting for the owner's approval · approve under Policy</Badge>
    </Link>
  ) : (
    <StatusBadge status={result.status} failureCode={result.failureCode} />
  );
}

export function AssetAmount({
  book,
  asset,
  setAsset,
  value,
  setValue,
}: {
  book: Overview["book"];
  asset: string;
  setAsset: (asset: string) => void;
  value: string;
  setValue: (value: string) => void;
}) {
  return (
    <>
      <input className={`${input} w-36`} inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)} />
      <select className={`${input} pr-8`} value={asset} onChange={(e) => setAsset(e.target.value)}>
        {book.map((h) => (
          <option key={h.asset} value={h.asset}>
            {h.symbol}
          </option>
        ))}
      </select>
    </>
  );
}
