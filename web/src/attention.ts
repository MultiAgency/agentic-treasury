import { ago, amountOf, type client, type Overview } from "./lib";
import type { Setup } from "./owner";
import type { Tone } from "./ui";

/** What a person must act on for one agent, each with the page to act on, relative to the agent's pages. */
export type Attention = {
  tone: Extract<Tone, "destructive" | "warning" | "info">;
  to: "/" | "/activity" | "/policy" | "/automations";
  action: string;
  text: string;
  /** The autopilot inbox entries this item shows (one message, repeated), which the owner can dismiss. */
  inboxIds?: string[];
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
  else if (overview.notInForce)
    items.push({ tone: "destructive", to: "/policy", action: "Review", text: `The policy isn't in force: ${overview.notInForce}. Nothing moves until it is.` });
  const grant = setup.grant;
  if (!grant) items.push({ tone: "destructive", to: "/policy", action: "Issue", text: "No live grant: the agent can't send." });
  else if (Date.parse(grant.expiresAt) - Date.now() < GRANT_WARNING_DAYS * 86_400_000)
    items.push({ tone: "warning", to: "/policy", action: "Renew", text: `The agent's grant expires ${ago(grant.expiresAt)}. The owner signs a new one when it does.` });
  for (const h of held) {
    const r = h.request as { amount?: string; asset?: string; recipient?: string };
    items.push({ tone: "warning", to: "/", action: "Approve",
      text: `${r.amount && r.asset ? amountOf(r.amount, r.asset, overview.book) : "A payout"} to ${r.recipient ?? "a payee"} is held for the owner's approval (requested ${ago(h.at)}).` });
  }
  // What the autopilot raised while no one was watching, until the owner dismisses it.
  // The same message raised again is one item, its age ignored ("12 min old" changes every tick). Newest
  // first, so the first of each is the latest, and its text is the one shown.
  const open = new Map<string, typeof inbox>();
  for (const e of inbox.filter((e) => !e.dismissed && e.level !== "run")) {
    const key = e.text.replace(/\d+ min old/g, "min old");
    open.set(key, [...(open.get(key) ?? []), e]);
  }
  for (const [latest, ...earlier] of open.values())
    items.push({ tone: latest!.level === "warn" ? "warning" : "info", to: "/automations", action: "Open",
      text: `${latest!.text} (${earlier.length ? `${earlier.length + 1} times, latest ${ago(latest!.at)}` : ago(latest!.at)})`,
      inboxIds: [latest!.id, ...earlier.map((e) => e.id)] });
  return items;
}
