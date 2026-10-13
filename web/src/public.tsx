import { LockSimple } from "@phosphor-icons/react";
import { KnownLegend, ProvenOnMainnet, PrototypeCard } from "./showcase";
import { SignIn } from "./session";

/**
 * The page for anyone not signed in: the two areas, each agent's capabilities and guarantees and how each is known,
 * and sign-in. It reads nothing from the server: no balances, payments or agents, and no roster or
 * proposals either; members see proposals after signing in.
 */
export function PublicHome({ daos, invoices }: { daos: string[]; invoices: string | null }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-x-12 gap-y-14 p-4 sm:p-8 lg:grid-cols-[1fr_22rem] lg:py-16">
      <header className="flex flex-col gap-6">
        <h1 className="max-w-[18ch] font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Agents that move money under a policy their owner signed
        </h1>
        <p className="flex max-w-prose items-start gap-2 text-muted-foreground">
          <LockSimple size={18} className="mt-1 shrink-0" />
          <span>Two agents on NEAR mainnet{daos.length > 0 && `, owned by ${daos.join(" and ")}`}. Each card lists its agent's capabilities and guarantees, who enforces each guarantee, and what has run on mainnet, then its roadmap. Balances, payments and rules are for members only.</span>
        </p>
        <KnownLegend />
      </header>

      <div className="lg:pt-2">
        <SignIn daos={daos} />
      </div>

      {/* Requirements and their phases, never the evidence. */}
      <div className="grid gap-6 lg:col-span-2 lg:grid-cols-2">
        <PrototypeCard kind="facilitator" invoices={invoices} />
        <PrototypeCard kind="treasury" />
      </div>

      <div className="lg:col-span-2">
        <ProvenOnMainnet />
      </div>
    </div>
  );
}
