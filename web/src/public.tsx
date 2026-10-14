import { LockSimple } from "@phosphor-icons/react";
import { ProvenOnMainnet, PrototypeCard } from "./showcase";
import { SignIn } from "./session";

/**
 * The page for anyone not signed in: the two areas, each agent's capabilities and guarantees and how each is known,
 * and sign-in. It reads nothing from the server: no balances, payments or agents, and no roster or
 * proposals either; members see proposals after signing in.
 */
export function PublicHome({ daos, invoices }: { daos: string[]; invoices: string | null }) {
  return (
    <>
    <a href="#public-main" className="sr-only fixed top-2 left-2 z-50 rounded-lg bg-card p-3 text-foreground focus:not-sr-only">Skip to main content</a>
    <main id="public-main" tabIndex={-1} className="mx-auto grid max-w-6xl gap-x-12 gap-y-14 p-4 sm:p-8 lg:grid-cols-[1fr_22rem] lg:py-16">
      <header className="flex flex-col gap-6">
        <h1 className="max-w-[18ch] font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Agents that move money under a policy their owner signed
        </h1>
        <p className="flex max-w-prose items-start gap-2 text-muted-foreground">
          <LockSimple size={18} className="mt-1 shrink-0" />
          <span>Two agents on NEAR mainnet{daos.length > 0 && `, owned by ${daos.join(" and ")}`}. Open each card's capabilities and guarantees to see what has been shown and what remains unverified. Balances and payment details are for members only.</span>
        </p>
        <a href="#member-sign-in" className="self-start py-2 text-sm font-medium underline">Member sign-in ↓</a>
      </header>

      {/* Requirements and their phases, never the evidence. */}
      <div className="grid gap-6 lg:col-span-2 lg:grid-cols-2">
        <PrototypeCard kind="facilitator" invoices={invoices} />
        <PrototypeCard kind="treasury" />
      </div>

      <div id="member-sign-in" className="scroll-mt-8 lg:col-start-2 lg:row-start-1 lg:pt-2">
        <SignIn daos={daos} />
      </div>

      <div className="lg:col-span-2">
        <ProvenOnMainnet />
      </div>
    </main>
    </>
  );
}
