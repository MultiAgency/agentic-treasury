import { ArrowRight, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Activity } from "./activity";
import { attentionOf } from "./attention";
import { Held } from "./held";
import { destinationsOf } from "./payout";
import { WhatThisShows } from "./showcase";
import { ASSET_COLOR, ago, amount, bookValue, client, type Holding, kindOf, type Overview as Book, queries, swaps, units, usd, useAttempt } from "./lib";
import { useAgent } from "./shell";
import { ErrorBox, Section } from "./ui";

function Figure({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-heading text-3xl font-semibold tabular-nums">{value}</span>
      {children}
    </div>
  );
}

function Meter({ value, className = "bg-brand" }: { value: number; className?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

function Figures({ data }: { data: Book }) {
  const total = bookValue(data);
  const shielded = data.book.reduce((sum, h) => sum + units(h.confidential, h.decimals) * h.price, 0);
  const monthly = data.policy.usage.budget.monthly;
  const limit = Number(monthly.limit_usd ?? 0);
  const budget = (
    <Figure label="Monthly budget left" value={usd(monthly.remaining_usd)}>
      <Meter value={limit ? Number(monthly.spent_usd) / limit : 0} />
      <span className="text-sm text-muted-foreground">
        {usd(monthly.spent_usd)} of {usd(limit)} spent{monthly.resets_at && ` · resets ${ago(monthly.resets_at)}`}
      </span>
    </Figure>
  );
  // A payout agent holds and pays only confidential USDC: its balance is the one figure that moves.
  if (kindOf(data) === "facilitator") {
    const usdc = data.book.find((h) => h.symbol === "USDC");
    return (
      <div className="grid gap-10 sm:grid-cols-2">
        <Figure label="Balance" value={usdc ? amount(usdc.confidential, usdc) : "0 USDC"}>
          <span className="text-sm text-muted-foreground">In the confidential balance, paid out only by vote</span>
        </Figure>
        {budget}
      </div>
    );
  }
  return (
    <div className="grid gap-10 sm:grid-cols-3">
      <Figure label="Book value" value={usd(total)}>
        <span className="text-sm text-muted-foreground">Across {data.book.length} assets at API prices</span>
      </Figure>
      {budget}
      <Figure label="Held privately" value={total ? `${Math.round((shielded / total) * 100)}%` : "—"}>
        <Meter value={total ? shielded / total : 0} className="bg-chart-3" />
        <span className="text-sm text-muted-foreground">
          {usd(shielded)} in the confidential balance
        </span>
      </Figure>
    </div>
  );
}

/** How far the book sits from its target, as the largest single weight gap. */
function drift(data: Book) {
  const total = bookValue(data);
  if (!total) return 0;
  return Math.max(...data.book.map((h) => Math.abs(h.usd / total - (data.target[h.asset] ?? 0))));
}

type Item = { to?: LinkProps["to"]; text: string; dismiss?: () => void };

/** Everything that stops the agent working, or that the owner should decide on, each with where to act. */
function useAttention(dismissing: ReturnType<typeof useAttempt>): Item[] {
  const { setup, data, treasury } = useAgent();
  const held = useQuery(queries.held).data ?? [];
  const inbox = useQuery(queries.inbox).data ?? [];
  const unresolved = useQuery(queries.unresolved).data ?? [];
  // Held payouts head this page in their own section; the DAO home lists them as attention items.
  const items: Item[] = attentionOf({ setup, overview: data, held, unresolved, inbox })
    .filter(({ to }) => to !== "/")
    .map(({ to, text, inboxIds }) => ({
      to,
      text,
      dismiss: inboxIds ? () => dismissing.attempt(async () => { for (const id of inboxIds) await client.inbox.dismiss({ id }); }) : undefined,
    }));

  const policy = data.policy.policy;
  // One predicate with the Payees page: a payee the DAO voted to pay that the policy doesn't list yet.
  const listed = new Set(destinationsOf(data).map((d) => d.address));
  const candidates = (treasury?.payees ?? []).filter((p) => !listed.has(p.address));
  const asked = (useQuery({ ...queries.agreements, enabled: kindOf(data) === "facilitator" }).data ?? []).filter((a) => a.status === "requested");
  const exposed = data.book.filter((h) => BigInt(h.public) > 0n);
  const gap = drift(data);
  // A payout agent pays only from its confidential USDC, the balance its Overview shows.
  const payable = data.book.find((h) => h.symbol === "USDC")?.confidential ?? "0";
  if (kindOf(data) === "facilitator" ? BigInt(payable) === 0n : bookValue(data) === 0)
    items.push({ to: "/treasury", text: kindOf(data) === "facilitator"
      ? "The payout wallet's confidential USDC is empty: invoices are refused until it is funded."
      : "The book is empty. Fund it to give the agent something to manage." });
  if (!treasury) items.push({ to: "/treasury", text: "No treasury linked. Link the account this agent works for." });
  if (asked.length)
    items.push({ to: "/payees", text: `${asked.length} account${asked.length === 1 ? " asks" : "s ask"} to be paid and ${asked.length === 1 ? "isn't" : "aren't"} agreed yet.` });
  if (candidates.length)
    items.push({ to: kindOf(data) === "treasury" ? "/treasury" : "/payees", text: `${treasury?.accountId} approved ${candidates.length} payee${candidates.length === 1 ? "" : "s"} the policy doesn't list yet.` });
  if (exposed.length)
    items.push({ to: "/automations", text: `${exposed.map((h) => amount(h.public, h)).join(", ")} sit${exposed.length === 1 ? "s" : ""} in the public balance, visible to anyone. Sweep shields it.` });
  for (const u of data.unmanaged) {
    // Without token data the API gives no decimals, so the amount stays in raw units.
    const quantity = u.decimals === null ? `${u.amount} raw units of ${u.symbol}` : amount(u.amount, { decimals: u.decimals, symbol: u.symbol });
    const holding = u.usd === null ? quantity : `${quantity} (${usd(u.usd)})`;
    const sellable = policy && (policy.assets === "any" || policy.assets.includes(u.asset));
    items.push({
      to: "/policy",
      text: sellable
        ? `The agent holds ${holding}, outside the assets its strategies manage. Nothing will rebalance it.`
        : `The agent holds ${holding}, outside the policy's assets: it can't sell it until the owner lists it.`,
    });
  }
  if (swaps(data) && gap > 0.05) items.push({ to: "/automations", text: `The book is ${(gap * 100).toFixed(1)} points off target. Preview a rebalance.` });
  return items;
}

function Attention() {
  const dismissing = useAttempt();
  const items = useAttention(dismissing);
  return (
    <Section title="Needs attention">
      <ErrorBox error={dismissing.error} />
      {items.length === 0 ? (
        <p className="flex items-center gap-3 text-sm text-muted-foreground">
          <CheckCircle size={18} className="text-success" /> Nothing. The agent is working inside its policy.
        </p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => {
            const body = (
              <>
                <WarningCircle size={18} className="shrink-0 text-warning-muted-foreground" />
                <span className="flex-1">{item.text}</span>
              </>
            );
            return (
              <li key={item.text} className="flex items-center gap-2 border-b last:border-0">
                {item.to ? (
                  <Link to={item.to} className="group flex flex-1 items-center gap-3 py-3 text-sm">
                    {body}
                    <ArrowRight size={16} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <div className="flex flex-1 items-center gap-3 py-3 text-sm">{body}</div>
                )}
                {item.dismiss && (
                  <button type="button" disabled={dismissing.busy} onClick={item.dismiss} className="shrink-0 p-1 text-muted-foreground hover:text-foreground" aria-label="Dismiss">
                    <X size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Allocation({ data }: { data: Book }) {
  const total = bookValue(data);
  const bar = (share: (h: Holding) => number) => (
    <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
      {data.book.map((h) => (
        <div
          key={h.asset}
          className={`${ASSET_COLOR[h.symbol]} transition-all duration-700`}
          style={{ width: `${share(h) * 100}%` }}
        />
      ))}
    </div>
  );
  return (
    <Section title="Allocation" description="Where the book sits against its target, valued at the API's token prices.">
      <div className="grid grid-cols-[4rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
        <span className="text-muted-foreground">Now</span>
        {bar((h) => (total ? h.usd / total : 0))}
        <span className="text-muted-foreground">Target</span>
        {bar((h) => data.target[h.asset] ?? 0)}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-3 pr-4 font-medium">Asset</th>
              <th className="py-3 pr-4 text-right font-medium">Value</th>
              <th className="py-3 text-right font-medium">Weight · target</th>
            </tr>
          </thead>
          <tbody>
            {data.book.map((h) => {
              const weight = total ? h.usd / total : 0;
              const target = data.target[h.asset] ?? 0;
              const drift = weight - target;
              return (
                <tr key={h.asset} className="border-b last:border-0">
                  <td className="py-4 pr-4">
                    <div className="flex items-center gap-3">
                      <span className={`size-2.5 rounded-full ${ASSET_COLOR[h.symbol]}`} />
                      <span className="font-medium">{h.symbol}</span>
                      <span className="hidden text-muted-foreground sm:inline">{usd(h.price)}</span>
                    </div>
                  </td>
                  <td className="py-4 pr-4 text-right font-medium">{usd(h.usd)}</td>
                  <td className="py-4 text-right">
                    {(weight * 100).toFixed(1)}% · {(target * 100).toFixed(0)}%{" "}
                    <span className={Math.abs(drift) < 0.02 ? "text-muted-foreground" : "text-brand-strong"}>
                      ({drift >= 0 ? "+" : ""}
                      {(drift * 100).toFixed(1)})
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** The facilitator's story as counts: who asked, who is agreed, what waits for a vote, what was paid. */
function Funnel() {
  const agreements = useQuery(queries.agreements).data ?? [];
  const held = useQuery(queries.held).data ?? [];
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => client.activity() }).data ?? [];
  const paid = activity.filter((op) => op.status === "SUCCESS" && (op.request as { recipient?: string }).recipient).length;
  const stages: { label: string; count: number; to: LinkProps["to"] }[] = [
    { label: "Asked to be paid", count: agreements.filter((a) => a.status === "requested").length, to: "/payees" },
    { label: "Agreement proposed or agreed", count: agreements.filter((a) => a.status === "proposed" || a.status === "agreed").length, to: "/payees" },
    { label: "Held for the DAO's vote", count: held.length, to: "/" },
    { label: "Paid confidentially", count: paid, to: "/activity" },
  ];
  return (
    <ol className="grid gap-3 sm:grid-cols-4">
      {stages.map((stage, i) => (
        <li key={stage.label}>
          <Link to={stage.to} className="flex h-full flex-col gap-1 rounded-2xl border bg-card p-4 hover:bg-muted">
            <span className="text-sm text-muted-foreground">
              {i + 1}. {stage.label}
            </span>
            <span className="font-heading text-3xl font-semibold tabular-nums">{stage.count}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** The treasury's story ends with what the autopilot did on its own, run by run. */
function AutopilotRuns() {
  const status = useQuery({ queryKey: ["autopilot"], queryFn: () => client.autopilot.get() }).data;
  const runs = (useQuery(queries.inbox).data ?? []).filter((e) => e.level === "run").slice(0, 3);
  if (!status) return null;
  return (
    <Section
      title="Autopilot"
      description={status.on ? `Runs every ${status.everyMin} minutes, executing rebalances up to $${status.maxUsd}.` : "Off: rebalances run only when someone runs them."}
      action={
        <Link to="/automations" className="text-sm text-muted-foreground hover:text-foreground">
          Automations
        </Link>
      }
    >
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="flex flex-col divide-y text-sm">
          {runs.map((r) => (
            <li key={r.id} className="flex gap-3 py-2">
              <span className="w-28 shrink-0 text-muted-foreground">{ago(r.at)}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function Overview() {
  const { data, setup } = useAgent();
  const kind = kindOf(data);
  return (
    <>
      <Held data={data} setup={setup} />
      <WhatThisShows kind={kind} dao={setup.dao?.id} />
      {kind === "facilitator" && <Funnel />}
      <Figures data={data} />
      {kind === "treasury" && <Allocation data={data} />}
      {kind === "treasury" && <AutopilotRuns />}
      <Attention />
      <Activity limit={5} />
    </>
  );
}
