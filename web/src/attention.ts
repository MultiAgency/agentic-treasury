import { ago, amountOf, type client, type Overview } from "./lib";
import type { Setup } from "./owner";
import type { Tone } from "./ui";

/** What a person must act on for one agent, each with the page to act on, relative to the agent's pages. */
export type Attention = {
  tone: Extract<Tone, "destructive" | "warning" | "info">;
  to: "/activity" | "/policy" | "/automations";
  action: string;
  text: string;
  /** The autopilot inbox entry this item shows, which the owner can dismiss. */
  inboxId?: string;
};

type Reads = {
  setup: Setup;
  overview: Overview;
  held: Awaited<ReturnType<typeof client.held>>;
  unresolved: Awaited<ReturnType<typeof client.unresolved>>;
  inbox: Awaited<ReturnType<typeof client.inbox.list>>;
};

const GRANT_WARNING_DAYS = 7;

/** What stops the agent sending, or waits on a person, most urgent first: shared by an agent's overview and the DAO's home. */
export function attentionOf({ setup, overview, held, unresolved, inbox }: Reads): Attention[] {
  const items: Attention[] = [];
  if (unresolved.length) {
    const oldest = unresolved.map((op) => op.at).sort()[0]!;
    items.push({ tone: "destructive", to: "/activity", action: "Check status",
      text: `${unresolved.length} money action${unresolved.length === 1 ? " has" : "s have"} no proven outcome, the oldest from ${ago(oldest)}. Nothing new moves until ${unresolved.length === 1 ? "it is" : "they are"} resolved.` });
  }
  if (overview.policy.policy?.frozen)
    items.push({ tone: "destructive", to: "/policy", action: "Review", text: "The agent is frozen. Nothing moves until the owner unfreezes it." });
  const grant = setup.grant;
  if (!grant) items.push({ tone: "destructive", to: "/policy", action: "Issue", text: "No live grant: the agent can't send." });
  else if (Date.parse(grant.expiresAt) - Date.now() < GRANT_WARNING_DAYS * 86_400_000)
    items.push({ tone: "warning", to: "/policy", action: "Renew", text: `The agent's grant expires ${ago(grant.expiresAt)}. The owner signs a new one when it does.` });
  for (const h of held) {
    const r = h.request as { amount?: string; asset?: string; recipient?: string };
    items.push({ tone: "warning", to: "/policy", action: "Approve",
      text: `${r.amount && r.asset ? amountOf(r.amount, r.asset, overview.book) : "A payout"} to ${r.recipient ?? "a payee"} is held for the owner's approval (requested ${ago(h.at)}).` });
  }
  // What the autopilot raised while no one was watching, until the owner dismisses it.
  for (const e of inbox.filter((e) => !e.dismissed && e.level !== "run"))
    items.push({ tone: e.level === "warn" ? "warning" : "info", to: "/automations", action: "Open", text: `${e.text} (${ago(e.at)})`, inboxId: e.id });
  return items;
}
