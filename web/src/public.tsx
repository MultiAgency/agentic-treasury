import { SignIn } from "./app/session";

/** Sign-in entry only. No agent reads, public walkthroughs or private evidence. */
export function PublicHome({ daos, selfService = false }: { daos: string[]; invoices?: string | null; selfService?: boolean }) {
  return <main id="public-main" tabIndex={-1} className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-4 py-12 sm:px-8">
    <header className="flex flex-col gap-4">
      <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Agentic Treasury</h1>
      <p className="max-w-prose text-lg text-muted-foreground">Guided payments and portfolio rebalancing with your own agent on NEAR Intents.</p>
      <p className="text-sm text-muted-foreground">These walkthroughs use real funds on mainnet. The owner signs the policy and grants; each money action keeps its existing review and approval steps.</p>
    </header>
    <SignIn daos={daos} selfService={selfService} />
  </main>;
}
