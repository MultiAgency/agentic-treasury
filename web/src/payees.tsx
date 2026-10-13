import { PaperPlaneTilt, Plus, X } from "@phosphor-icons/react";
import { useState } from "react";
import { short, toUnits } from "./lib";
import { AssetAmount, PayoutResult, useDestinations, usePayout } from "./payout";
import { useAgent } from "./shell";
import { Badge, Button, Card, ErrorBox, input, Section, Spinner } from "./ui";

/**
 * The agreement: the payees the agent may pay. The owner signs each into the policy; for a DAO,
 * payees its members already voted to pay are offered first. Anyone else is refused at the API.
 */
export function PayeesSection() {
  const { treasury, data, setup } = useAgent();
  const destinations = useDestinations(data, setup);
  const payees = destinations.current.filter((d) => d.address !== treasury?.accountId);
  const candidates = (treasury?.payees ?? []).filter((c) => !destinations.current.some((d) => d.address === c.address));
  const [newPayee, setNewPayee] = useState("");
  const [recipient, setRecipient] = useState("");
  const [asset, setAsset] = useState(data.book[0]?.asset ?? "");
  const [value, setValue] = useState("");
  const payout = usePayout();
  const holding = data.book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;
  const agreed = payees.find((p) => p.address === recipient.trim());
  const editable = !destinations.action.busy && !destinations.blocked;

  return (
    <Section
      title="Payees"
      description="Who the agent may pay. A payee outside this agreement, or a payment over the policy's caps, is refused before anything moves."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="text-lg font-medium">Agreement</h3>
          {payees.length === 0 && <p className="text-sm text-muted-foreground">No payees yet.</p>}
          <ul className="flex flex-col gap-2">
            {payees.map((p) => (
              <li key={p.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono" title={p.address}>
                  {short(p.address, 24)}
                </span>
                <span className="flex items-center gap-2">
                  {p.confidential && <Badge tone="info">confidential</Badge>}
                  <Button variant="ghost" size="sm" disabled={!editable} onClick={() => destinations.remove(p.address)} aria-label={`Remove ${p.address}`}>
                    <X size={14} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          {candidates.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-4">
              <span className="text-sm text-muted-foreground">Approved by {treasury?.accountId} in past proposals</span>
              {candidates.map((c) => (
                <div key={c.address} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-mono">{short(c.address, 24)}</span>{" "}
                    <span className="text-muted-foreground">· #{c.proposalId}</span>
                  </span>
                  <Button variant="outline" size="sm" disabled={!editable} onClick={() => destinations.add({ address: c.address, confidential: true })}>
                    <Plus size={14} /> Add
                  </Button>
                </div>
              ))}
            </div>
          )}

          <form
            className="flex gap-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (newPayee.trim()) destinations.add({ address: newPayee.trim(), confidential: Boolean(treasury?.dao) });
            }}
          >
            <input className={`${input} flex-1`} placeholder="Payee's NEAR account" value={newPayee} onChange={(e) => setNewPayee(e.target.value)} />
            <Button type="submit" variant="outline" disabled={!editable || !newPayee.trim()}>
              <Plus size={16} /> Add
            </Button>
          </form>
          <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          <ErrorBox error={destinations.action.error} />
        </Card>

        <Card>
          <h3 className="text-lg font-medium">Pay</h3>
          <p className="text-sm text-muted-foreground">
            The agent sends under its grant. Try someone outside the agreement to watch the policy refuse.
          </p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (amount && recipient.trim())
                payout.pay({ recipient: recipient.trim(), asset, amount, confidential: agreed?.confidential ?? true });
            }}
          >
            <input
              className={input}
              list="payees"
              placeholder="Recipient's NEAR account"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <datalist id="payees">
              {payees.map((p) => (
                <option key={p.address} value={p.address} />
              ))}
            </datalist>
            <div className="flex flex-wrap items-center gap-3">
              <AssetAmount book={data.book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} />
              <Button type="submit" disabled={payout.busy || !amount || !recipient.trim()}>
                {payout.busy ? <Spinner /> : <PaperPlaneTilt size={18} />} Pay
              </Button>
              <PayoutResult result={payout.result} />
            </div>
            {recipient.trim() && !agreed && (
              <span className="text-sm text-warning-muted-foreground">Not in the agreement: expect a refusal.</span>
            )}
          </form>
          <ErrorBox error={payout.error} />
        </Card>
      </div>
    </Section>
  );
}
