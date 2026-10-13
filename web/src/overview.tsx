import { ArrowRight, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Activity } from "./activity";
import { ASSET_COLOR, ago, amount, bookValue, client, type Holding, type Overview as Book, queries, swaps, units, usd, useAttempt } from "./lib";
import { useAgent } from "./shell";
import { destinationsOf } from "./payout";
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
  const grant = data.grants[0];
  return (
    <div className="grid gap-10 sm:grid-cols-3">
      <Figure label="Book value" value={usd(total)}>
        <span className="text-sm text-muted-foreground">Across {data.book.length} assets at API prices</span>
      </Figure>
      <Figure label="Monthly budget left" value={usd(monthly.remaining_usd)}>
        <Meter value={limit ? Number(monthly.spent_usd) / limit : 0} />
        <span className="text-sm text-muted-foreground">
          {usd(monthly.spent_usd)} of {usd(limit)} spent{monthly.resets_at && ` · resets ${ago(monthly.resets_at)}`}
        </span>
      </Figure>
      <Figure label="Held privately" value={total ? `${Math.round((shielded / total) * 100)}%` : "—"}>
        <Meter value={total ? shielded / total : 0} className="bg-chart-3" />
        <span className="text-sm text-muted-foreground">
          {usd(shielded)} in the confidential balance{grant && ` · grant expires ${ago(grant.expires_at)}`}
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

/** Everything that stops the agent working, or that the owner should decide on, each with where to act. */
function useAttention(dismissing: ReturnType<typeof useAttempt>) {
  const { setup, data, treasury } = useAgent();
  const policy = data.policy.policy;
  const agreed = new Set(destinationsOf(data).map((d) => d.address));
  const candidates = (treasury?.payees ?? []).filter((p) => !agreed.has(p.address));
  const gap = drift(data);
  const exposed = data.book.filter((h) => BigInt(h.public) > 0n);
  const held = useQuery(queries.held).data ?? [];
  const grantMs = setup.grant ? new Date(setup.grant.expiresAt).getTime() - Date.now() : Infinity;
  const inbox = useQuery(queries.inbox);
  const open = (inbox.data ?? []).filter((e) => e.level !== "run" && !e.dismissed);
  const unresolved = useQuery(queries.unresolved).data ?? [];
  const oldest = unresolved.map((op) => op.at).sort()[0];
  const items: { when: unknown; to?: LinkProps["to"]; text: string; dismiss?: () => void }[] = [
    // What the autopilot raised while no one was watching, until the owner dismisses it.
    ...open.map((e) => ({
      when: true,
      to: "/automations" as const,
      text: `${e.text} (${ago(e.at)})`,
      dismiss: () => dismissing.attempt(() => client.inbox.dismiss({ id: e.id })),
    })),
    {
      when: unresolved.length,
      to: "/activity",
      // Every item's text is built, shown or not: format a date only when there is one.
      text: oldest
        ? `${unresolved.length} money action${unresolved.length === 1 ? " has" : "s have"} no known outcome, the oldest from ${ago(oldest)}. Nothing new moves until ${unresolved.length === 1 ? "it is" : "they are"} resolved.`
        : "",
    },
    { when: policy?.frozen, to: "/policy", text: "The agent is frozen. Nothing moves until the owner unfreezes it." },
    {
      when: held.length,
      to: "/policy",
      text: `${held.length} payment${held.length === 1 ? " waits" : "s wait"} for the owner's approval.`,
    },
    {
      when: data.policy.status !== "APPLIED",
      to: "/policy",
      text: `Policy revision ${data.policy.revision} is ${data.policy.status.toLowerCase()}, not yet in force.`,
    },
    {
      when: grantMs < 2 * 86_400_000,
      text: setup.grant ? `The agent's grant expires ${ago(setup.grant.expiresAt)}. The owner signs a new one when it does.` : "",
    },
    { when: bookValue(data) === 0, to: "/treasury", text: "The book is empty. Fund it to give the agent something to manage." },
    { when: !treasury, to: "/treasury", text: "No treasury linked. Link the account this agent works for." },
    {
      when: candidates.length,
      to: "/payees",
      text: `${treasury?.accountId} approved ${candidates.length} payee${candidates.length === 1 ? "" : "s"} not yet in the agreement.`,
    },
    {
      when: exposed.length,
      to: "/automations",
      text: `${exposed.map((h) => amount(h.public, h)).join(", ")} sit${exposed.length === 1 ? "s" : ""} in the public balance, visible to anyone. Sweep shields it.`,
    },
    ...data.unmanaged.map((u) => {
      // Without token data the API gives no decimals, so the amount stays in raw units.
      const quantity = u.decimals === null ? `${u.amount} raw units of ${u.symbol}` : amount(u.amount, { decimals: u.decimals, symbol: u.symbol });
      const held = u.usd === null ? quantity : `${quantity} (${usd(u.usd)})`;
      const sellable = policy && (policy.assets === "any" || policy.assets.includes(u.asset));
      return {
        when: true,
        to: "/policy" as const,
        text: sellable
          ? `The agent holds ${held}, outside the assets its strategies manage. Nothing will rebalance it.`
          : `The agent holds ${held}, outside the policy's assets: it can't sell it until the owner lists it.`,
      };
    }),
    { when: swaps(data) && gap > 0.05, to: "/automations", text: `The book is ${(gap * 100).toFixed(1)} points off target. Preview a rebalance.` },
  ];
  return items.filter((item) => item.when);
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
              <th className="hidden py-3 pr-4 text-right font-medium sm:table-cell">Public</th>
              <th className="hidden py-3 pr-4 text-right font-medium sm:table-cell">Private</th>
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
                  <td className="hidden py-4 pr-4 text-right sm:table-cell">{amount(h.public, h)}</td>
                  <td className="hidden py-4 pr-4 text-right sm:table-cell">{amount(h.confidential, h)}</td>
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

export function Overview() {
  const { data } = useAgent();
  return (
    <>
      <Figures data={data} />
      <Attention />
      {swaps(data) && <Allocation data={data} />}
      <Activity limit={5} />
    </>
  );
}
