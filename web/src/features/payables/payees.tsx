import { paymentAssets } from "../payables/payment-assets";
import { PaperPlaneTilt, Plus } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { toUnits } from "../../shared/lib";
import { AssetAmount, PaymentReview, type PaymentReviewData, PayoutResult, usePayout } from "./payout";
import { reviewedPolicyOf } from "../policy/policy-review";
import { useAgent } from "../../app/agent-context";
import { useAppHref } from "../demo/app-link";
import { Button, Details, ErrorBox, Spinner } from "../../shared/ui";
import { useNameOf } from "../../shared/names";
import { useCanCall } from "../../app/viewer";
import { Field, focusInvalid } from "../../shared/form";
import { payeeError } from "../../shared/form-validation";
import { intentsAccount, isNearcomAddress } from "../../../../src/intents-account.js";
import { useDirtyDraft } from "../../shared/dirty-draft";

/** A payment sent by hand, folded away: the provider decides, refusing anyone the policy doesn't list. */
export function ManualPayment({ listed, open, disabledReason, entry = false, onPayment }: {
  listed: Set<string>; open?: boolean; disabledReason?: string; entry?: boolean; onPayment?: (correlationId: string | undefined) => void;
}) {
  const app = useAppHref("payables");
  const { data, setup } = useAgent();
  const nameOf = useNameOf();
  const [recipient, setRecipient] = useState("");
  const book = paymentAssets(data.book, setup.grant?.label);
  const [chosenAsset, setAsset] = useState(book[0]?.asset ?? "");
  const asset = book.some(h => h.asset === chosenAsset) ? chosenAsset : book[0]?.asset ?? "";
  const [value, setValue] = useState("");
  const payout = usePayout();
  useEffect(() => {
    // Only the provider response identifies this payment. A refusal supplies no payment identity.
    if (payout.result && payout.result.outcome !== "refused") onPayment?.(payout.result.correlationId);
  }, [payout.result, onPayment]);
  const canPay = useCanCall("pay");
  const canSend = canPay && setup.executor !== false && Boolean(setup.grant) && !disabledReason;
  useDirtyDraft(Boolean(recipient || value) && !payout.result && !payout.busy);
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<PaymentReviewData>();
  const holding = book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;
  const account = intentsAccount(recipient);
  const destination = data.policy.policy?.destinations.list.find((d) => d.action === "transfer" && d.address === account);
  const confidential = destination?.action === "transfer" ? destination.confidential : true;
  return (
    <PaymentCreation entry={entry} open={open}>
      {!canSend && <p className="text-muted-foreground">{disabledReason ?? "Creating a payment requires execution permission on the executor and a live grant. Existing payments remain available for review."}</p>}
      <p className="text-muted-foreground">The agent sends under its grant; the provider refuses anyone the policy doesn't list.</p>
      <form
        noValidate className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!amount || payeeError(recipient)) { focusInvalid(e.currentTarget); return; }
          if (canSend && !payout.busy && holding) setReview({
            request: { recipient: account, asset, amount, confidential },
            symbol: holding.symbol, decimals: holding.decimals, ownerApproval: data.policy.policy?.owner_approval,
            expectedPolicy: reviewedPolicyOf(data),
          });
        }}
      >
        <Field label="Recipient’s NEAR account" name="recipient" autoComplete="off" spellCheck={false} autoCapitalize="none" list="payees" placeholder="payee.near or nearcom:…" value={recipient} onChange={(e) => setRecipient(e.target.value)} error={submitted ? payeeError(recipient) : undefined} />
        <RecipientHint value={recipient} confidential={confidential} />
        <datalist id="payees">
          {[...listed].map((address) => (
            <option key={address} value={address} label={nameOf(address)} />
          ))}
        </datalist>
        <div className="flex flex-wrap items-center gap-3">
          <AssetAmount book={book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} submitted={submitted} />
          <Button type="submit" className="h-auto max-w-full whitespace-normal py-3" disabled={payout.busy || !canSend}>
            {payout.busy ? <Spinner /> : <PaperPlaneTilt size={18} />} {payout.busy ? "Sending…" : "Review payment"}
          </Button>
          <PayoutResult result={payout.result} />
        </div>
        {account && !listed.has(account) && (
          <span className="text-sm text-warning-muted-foreground">The policy doesn't list this account: expect a refusal.</span>
        )}
      </form>
      {payout.result && payout.result.outcome !== "refused" && <a href={app(`/follow/payment?payment=${encodeURIComponent(payout.result.correlationId)}`)} className="self-start underline">Follow this payment in Payables</a>}
      <span role="status" className="sr-only">{payout.busy ? "Submitting payment…" : ""}</span>
      {review && <PaymentReview payment={review} currentPolicy={data.notInForce ? undefined : reviewedPolicyOf(data)} permitted={canSend} onClose={() => setReview(undefined)} onConfirm={request => {
        if (canSend) {
          // A second confirmed request must not inherit the previous payment's identity.
          onPayment?.(undefined);
          void payout.pay(request);
        }
      }} />}
      <ErrorBox error={payout.error} />
    </PaymentCreation>
  );
}

/** Native disclosure keeps the draft mounted and the existing review flow intact. */
function PaymentCreation({ entry, open, children }: { entry: boolean; open?: boolean; children: ReactNode }) {
  if (!entry) return <Details summary="Send a payment by hand" open={open} className="border-t pt-4">{children}</Details>;
  return <details open={open} className="text-sm">
    <Button asChild className="h-auto max-w-full whitespace-normal py-3"><summary><Plus data-icon="inline-start" aria-hidden="true" />Create payment</summary></Button>
    <div className="mt-4 flex flex-col gap-3">{children}</div>
  </details>;
}

/** Explain the actual transfer destination before an owner reviews or submits it. */
function RecipientHint({ value, confidential = true }: { value: string; confidential?: boolean }) {
  return isNearcomAddress(value) && !payeeError(value) ? <p className="break-words text-sm text-muted-foreground">
    Destination: <span className="break-all font-mono">{intentsAccount(value)}</span>. {confidential
      ? "A confidential transfer reaches the balance near.com shows."
      : "The policy lists a public transfer: it reaches the legacy public balance, which near.com does not show by default."}
  </p> : null;
}
