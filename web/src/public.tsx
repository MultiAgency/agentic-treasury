import { LockSimple } from "@phosphor-icons/react";
import { PrototypeCard } from "./showcase";
import { SignIn } from "./session";

/**
 * The page for anyone not signed in: what the two prototypes are and how each claim is known, and
 * sign-in. It reads nothing from the server: no balances, payments or agents, and no roster or
 * proposals either; members see proposals after signing in.
 */
export function PublicHome({ dao, invoices }: { dao: string; invoices: string | null }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 p-4 sm:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold">Agents that move money under a policy their owner signed</h1>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <LockSimple size={16} className="mt-0.5 shrink-0" />
          <span>Two prototypes on NEAR mainnet, owned by {dao}. Balances, payments and rules are for members only.</span>
        </p>
      </header>

      {/* Claims and how each is known, never their evidence. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PrototypeCard kind="facilitator" invoices={invoices} />
        <PrototypeCard kind="treasury" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SignIn dao={dao} />
      </div>
    </div>
  );
}
