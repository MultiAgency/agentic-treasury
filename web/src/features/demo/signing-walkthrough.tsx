import { useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge, Button, Details } from "../../shared/ui";
import { LiveDemo } from "./live-demo";
import type { WalkthroughId } from "./catalog";
import { appOrigin } from "./app-origin";
import { useGateway } from "../../app/gateway-context";
import { BASE } from "../../shared/client";

type Review = "policy" | "strategy" | "agreements" | "actions";
type Chapter = { title: string; explanation: string; signature: string; action: string; review?: Review };
export const signingChapters: Record<WalkthroughId, Chapter[]> = {
  payables: [
    { title: "Agree & authorize", explanation: "Agree the work and payee, review the payout policy, then issue the executor’s grant. Commercial terms, policy and grant remain separate records.", signature: "The owner signs policy changes and grants. For a DAO, the proposal and required votes authorize the owner action.", action: "Review agreements", review: "agreements" },
    { title: "Request & hold", explanation: "Share the contributor link. The contributor signs in with their own account and files the invoice; the executor submits within its authority. A held payout is waiting for the owner’s decision.", signature: "Contributor sign-in authenticates the requester; it does not authorize release of treasury funds.", action: "Show contributor handoff" },
    { title: "Review & decide", explanation: "Choose the exact invoice or held payout below. Review its recipient, amount and purpose before approving or rejecting it.", signature: "The existing review prepares the exact approval request. Sign with the owner wallet or follow the DAO proposal and quorum flow.", action: "Review a held payout" },
    { title: "Follow the payment", explanation: "Keep the same payment identity through approval, processing and its reported outcome. If the outcome is unknown, investigate that record before another send.", signature: "An approval signature is not settlement evidence. Follow the provider’s outcome for the selected payment.", action: "Follow payment records" },
  ],
  treasury: [
    { title: "Set the mandate", explanation: "Review permitted assets, spending caps and budget. Save the strategy, then review and sign its grant. Schedule enablement is a separate decision.", signature: "Policy edits and the strategy-bound grant are separate owner actions. The grant permits the executor to act within those limits.", action: "Review strategy and grant", review: "strategy" },
    { title: "Inspect the plan", explanation: "Read current balances and preview the quoted swaps. Check input, minimum output and costs before confirming the exact plan.", signature: "A preview moves no funds. An authorized executor can submit permitted trades under an existing grant without a new owner signature for every swap.", action: "Preview a rebalance" },
    { title: "Run within limits", explanation: "Confirm the reviewed plan or separately enable the authorized strategy’s schedule. Agent API authorization and OutLayer policy checks constrain execution; Proto adds its documented application checks.", signature: "Execution confirmation and owner signing are different actions. Neither can bypass a missing grant or a refusal.", action: "Review execution controls" },
    { title: "Check the outcome", explanation: "Follow the exact confirmed plan’s operations. A finished stream does not prove settlement; retain unresolved operations and inspect their evidence.", signature: "No signature is needed to inspect retained outcomes. Schedule stop, grant revocation and freeze have different scopes.", action: "Inspect plan outcomes" },
  ],
  invoices: [
    { title: "Create a bounded order", explanation: "Save one contributor, exact USDC amount and deadline. Open that order, authorize its dedicated agent’s policy and expiring grant, then fund it separately.", signature: "Use the order’s own signing controls. Its policy, grant and funding are distinct actions; the parent payout agent’s grant cannot substitute for them.", action: "Create or review an order" },
    { title: "Invite & invoice", explanation: "Share the selected order’s contributor link. The contributor signs in and files against that order’s immutable invoice identity.", signature: "The contributor authenticates with their own account. Never sign as the contributor from the buyer’s session.", action: "Find the order’s contributor link" },
    { title: "Validate & pay", explanation: "Review the selected order’s fixed terms and invoice. Its existing controls enforce the local binding and prepare the held payout’s owner approval.", signature: "The owner reviews and signs for this order’s agent. A DAO requires its proposal and votes; one member signature is not automatically approval.", action: "Review the order’s approval" },
    { title: "Close & reconcile", explanation: "Follow the selected order’s retained payment identity, remaining balance and grant status. Expiry stops new submissions; accepted work may finish later and funds are not automatically returned.", signature: "Approval is not settlement. Contributor conversion, forwarding and residual-fund recovery are not implemented.", action: "Inspect the order’s outcome" },
  ],
};

/**
 * The app screen for each review, for the same agent (each reported working in a frozen app release): Payables A4 for
 * policy, payees and owner actions; Treasury A6 for policy, strategy and owner actions.
 */
const appScreens: Record<WalkthroughId, Partial<Record<Review, string>>> = {
  payables: { policy: "/policy", agreements: "/payees", actions: "/activity" },
  invoices: { policy: "/policy", agreements: "/payees", actions: "/activity" },
  treasury: { policy: "/policy", strategy: "/automations", actions: "/activity#owner-actions" },
};
/** Chapters without a review open the app's screen for that step (Treasury's guided run, Payables' orders). */
const chapterScreens: Partial<Record<WalkthroughId, string[]>> = {
  treasury: ["/automations", "/demo#preview", "/demo#preview", "/demo"],
  invoices: ["/payees", "/payees", "/payees", "/payees"],
};

/** Chapter selection changes guidance only. The apps' screens and Payables' embedded run own signatures and identities. */
export function SigningWalkthrough({ workflow, short = false }: { workflow: WalkthroughId; short?: boolean }) {
  const app = appOrigin(workflow, useGateway());
  const appName = workflow === "treasury" ? "Treasury" : "Payables";
  const link = (path: string) => `${app}${BASE}${path}`;
  const [chapter, setChapter] = useState(0);
  const controls = useRef<HTMLDivElement>(null);
  const chapters = signingChapters[workflow];
  const current = chapters[chapter]!;
  const target = current.review ? appScreens[workflow][current.review] : chapterScreens[workflow]?.[chapter];
  const focusControls = () => {
    const step = chapter === 3 || (workflow === "payables" && chapter === 2) ? 3 : 2;
    const element = controls.current?.querySelector<HTMLElement>(`[data-demo-step="${step}"]`) ?? controls.current;
    element?.scrollIntoView({ block: "start", behavior: "instant" });
    element?.focus({ preventScroll: true });
  };
  const wide = "h-auto min-h-11 max-w-full whitespace-normal text-left";
  return <section aria-label={`${workflow} signing walkthrough`} className="flex min-w-0 flex-col gap-6">
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-2xl font-semibold">Do it with my agent</h2>
      <div className="flex flex-wrap items-center gap-3"><Badge tone="warning">Real actions · mainnet</Badge><p className="text-sm">Each action opens in {appName}, where you review and sign it. You choose each action.</p></div>
      <p className="text-sm text-muted-foreground">Chapters guide your attention; they do not mark actions complete. Your wallet or the DAO’s voting flow authorizes the exact prepared request.</p>
    </div>
    <ToggleGroup type="single" variant="outline" value={String(chapter)} onValueChange={value => { if (value) setChapter(Number(value)); }} aria-label="Live walkthrough chapters" className="flex-wrap justify-start">
      {chapters.map((item, index) => <ToggleGroupItem key={item.title} value={String(index)} className="h-auto min-h-11 whitespace-normal text-left">{index + 1}. {item.title}</ToggleGroupItem>)}
    </ToggleGroup>
    <div aria-live="polite" className="flex max-w-prose flex-col gap-3">
      <h3 className="text-xl font-medium">{current.title}</h3>
      <p>{current.explanation}</p>
      <p className="text-sm text-muted-foreground">{current.signature}</p>
    </div>
    <div className="flex flex-wrap gap-3">
      {target
        ? <Button asChild className={wide}><a href={link(target)}>{current.action} in {appName}</a></Button>
        : <Button className={wide} onClick={focusControls}>{current.action}</Button>}
      {workflow !== "invoices" && <Button asChild className={wide} variant="outline"><a href={link(appScreens[workflow].policy!)}>Review policy and signing in {appName}</a></Button>}
      {workflow === "invoices"
        ? <Button asChild className={wide} variant="outline"><a href={link("/payees")}>Review orders and their owner actions in Payables</a></Button>
        : <Button asChild className={wide} variant="outline"><a href={link(appScreens[workflow].actions!)}>Follow owner signatures and proposals in {appName}</a></Button>}
    </div>
    <Details summary="What makes this possible?">
      <p><strong>NEAR Intents Agent API:</strong> owner intents, policy and grant authorization, execution requests and retained operation status.</p>
      <p><strong>OutLayer:</strong> custody and policy-controlled signing in a trusted execution environment. Its controls are distinct from API rules and Proto’s application checks.</p>
      <p><strong>NEAR Intents:</strong> asset movement, swaps and confidential balances. Confidentiality does not hide every relationship or public DAO proposal.</p>
      <p><strong>Proto:</strong> shared infrastructure, walkthroughs and evidence for the evolving agentic treasury MVP. Guidance never creates a signable payload.</p>
      <p>{workflow === "treasury" ? "Output-asset checks are local; strict cumulative caps and USD-budget atomicity are not independently established here." : workflow === "invoices" ? "Work-order binding is offline-tested, not mainnet-observed. Exact invoice matching is a local check, not a lifetime one-payment guarantee from the grant." : "Sputnik membership is public on chain. The contributor interface avoids roster reads; it cannot make that roster secret."}</p>
    </Details>
    <div ref={controls} tabIndex={-1} className="flex min-w-0 scroll-mt-24 flex-col gap-6">
      {workflow === "payables"
        ? <LiveDemo short={short} expanded={!short} />
        : <p className="text-sm">{workflow === "treasury" ? "Readiness, the quoted plan, its explicit execution and the exact plan’s outcome live in Treasury’s guided run." : "The order’s fixed terms, signing controls and payment live in Payables."} <a className="underline" href={link(workflow === "treasury" ? "/demo" : "/payees")}>{workflow === "treasury" ? "Open the guided run in Treasury" : "Open orders in Payables"}</a>.</p>}
    </div>
  </section>;
}
