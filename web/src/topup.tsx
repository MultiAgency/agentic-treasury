import { useState } from "react";
import { ASSETS } from "../../src/policy.js";
import { type client, clientFor, toUnits, useAttempt } from "./lib";
import { useSiblings } from "./names";
import { PayoutResult } from "./payout";
import { useAgent } from "./shell";
import { ConfirmButton, ErrorBox, input } from "./ui";

/**
 * On the payout agent's dashboard behind the hosted gateway: the treasury agent pays this wallet through
 * its own `pay`, the one send path, under its own policy and caps, with no vote. Offered only when that
 * policy lists this wallet, since the provider would refuse anything else; operators of the treasury agent only.
 */
export function TopUp() {
  const { setup } = useAgent();
  const { hosted, siblings, access } = useSiblings();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.pay>>>();
  const send = useAttempt();

  const treasury = siblings.find((s) => s.kind === "treasury");
  const wallet = setup.wallet;
  if (!hosted || !treasury || !wallet) return null;
  // The payment is the treasury agent's, so it takes operator access to that agent, not to this page's.
  if (access[treasury.name]?.role !== "operator") return <span className="text-sm text-muted-foreground">Operators can top up from the treasury.</span>;
  const destination = treasury.overview.policy.policy?.destinations.list.find((d) => d.action === "transfer" && d.address === wallet);
  if (!destination || destination.action !== "transfer")
    return (
      <span className="text-sm text-muted-foreground">
        To top up from the treasury, first{" "}
        <a className="underline hover:text-foreground" href={`/a/${treasury.name}/funding`}>
          list this wallet as a treasury payee
        </a>
        .
      </span>
    );
  const amount = toUnits(value, 6);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${input} w-28`} inputMode="decimal" placeholder="USDC" value={value} onChange={(e) => setValue(e.target.value)} aria-label="USDC to send" />
        <ConfirmButton
          label="Top up from the treasury"
          disabled={send.busy || !amount}
          title={`Send ${value || "0"} USDC from the treasury agent to this wallet?`}
          description={`The treasury agent pays it under its own policy and caps, with no vote${destination.confidential ? ", into this wallet's confidential balance" : ""}.`}
          confirm="Send"
          onConfirm={() =>
            send.attempt(async () => {
              setResult(undefined);
              setResult(await clientFor(`/a/${treasury.name}`).pay({ recipient: wallet, asset: ASSETS.USDC, amount: amount!, confidential: destination.confidential }));
            })
          }
        />
        {result && result.outcome !== "refused" && result.status === "PENDING_APPROVAL" ? (
          <a className="text-sm underline" href={`/a/${treasury.name}/`}>
            Held for the treasury owner's approval: approve on the treasury agent
          </a>
        ) : (
          <PayoutResult result={result} />
        )}
      </div>
      <ErrorBox error={send.error} />
    </div>
  );
}
