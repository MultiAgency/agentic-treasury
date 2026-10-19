import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field";
import { Button, ErrorBox, Spinner } from "../shared/ui";
import { errorMessage, gw } from "../shared/lib";
import { dao } from "../features/owner/wallet";
import { loadGateway, type Gateway } from "./session";
import { AgentList } from "../features/demo/launcher";

/** Reserve a private setup first; the existing onboarding asks for the actual owner signature. */
export function WalkthroughHome({ gateway }: { gateway: Gateway }) {
  const [kind, setKind] = useState<"wallet" | "dao">("wallet");
  const setupAreas = gateway.setupAreas ?? ["treasury", "payables"];
  const [area, setArea] = useState<"treasury" | "payables">(setupAreas[0] ?? "payables");
  const [daoId, setDaoId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const account = gateway.viewer!.account;
  const selectDao = async () => {
    setConnecting(true); setError(undefined);
    try {
      await dao.connect();
      const selected = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
      if (!selected) throw new Error("Select a DAO in Trezu to continue.");
      setDaoId(selected);
    } catch (e) { setError(errorMessage(e)); }
    finally { setConnecting(false); }
  };
  const create = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await gw<{ name: string }>("/gw/agents", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: kind === "wallet" ? account : daoId, kind, area }),
      });
      // The executor must answer ownership checks before opening its private setup.
      for (let attempt = 0; attempt < 15; attempt++) {
        const session = await loadGateway();
        if (session?.viewer?.access[result.name]) { location.assign(`/a/${result.name}/`); return; }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      throw new Error("Your setup is saved, but its agent is still starting. Continue setup again to reopen the same agent.");
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return <main id="workspace-main" tabIndex={-1} className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-8 sm:px-8">
    <header className="flex flex-col gap-3">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Your agents</h1>
      <p className="text-muted-foreground">Run agents for your NEAR wallet or Sputnik DAO. Each agent keeps its own balance, policy and grant. You approve its authority; MultiAgency hosts its executor. Each agent’s balances, policy, actions and records are in its app.</p>
    </header>
    {gateway.agents.length > 0 ? <section aria-label="Your agents" className="flex flex-col gap-3">
      <AgentList gateway={gateway} />
      <p className="text-sm text-muted-foreground">Appearing here does not mean an agent is funded or authorized to act. Its app shows its current setup and permissions.</p>
    </section> : <p>You have no agents available on this host yet. {gateway.selfService ? "Choose an owner and task below to start." : "Access depends on the owner’s permissions."}</p>}
    {gateway.selfService && <section aria-labelledby="create-heading" className="flex flex-col gap-6 border-t pt-8">
      <div className="flex flex-col gap-2"><h2 id="create-heading" className="text-xl font-semibold">Create your own agent</h2><p className="text-sm text-muted-foreground">Choose its owner and task. Continue an existing setup for that owner and task, or reserve a new one. Then review and sign its policy and grant separately.</p></div>
      <form onSubmit={event => { event.preventDefault(); void create(); }} className="flex flex-col items-start gap-6">
        <FieldGroup>
          <FieldSet disabled={busy || connecting}>
            <FieldLegend>Owner</FieldLegend>
            <ToggleGroup type="single" variant="outline" value={kind} onValueChange={value => { if (value === "wallet" || value === "dao") setKind(value); }} aria-label="Owner type" className="flex-wrap">
              <ToggleGroupItem value="wallet">My NEAR wallet</ToggleGroupItem><ToggleGroupItem value="dao">DAO through Trezu</ToggleGroupItem>
            </ToggleGroup>
            {kind === "wallet" ? <p className="break-all text-sm text-muted-foreground">{account}</p> : <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">Sign in as a DAO member who can propose owner actions. Selecting a DAO does not approve its policy or grant.</p>
              {daoId && <p className="break-all text-sm">{daoId}</p>}
              <Button variant="outline" onClick={selectDao} disabled={connecting}>{connecting && <Spinner />}{daoId ? "Change DAO in Trezu" : "Connect Trezu wallet"}</Button>
            </div>}
          </FieldSet>
          <FieldSet disabled={busy || connecting}>
            <FieldLegend>Task</FieldLegend>
            <ToggleGroup type="single" variant="outline" value={area} onValueChange={value => { if (value === "treasury" || value === "payables") setArea(value); }} aria-label="Task" className="flex-wrap">
              {setupAreas.includes("treasury") && <ToggleGroupItem value="treasury">Portfolio</ToggleGroupItem>}{setupAreas.includes("payables") && <ToggleGroupItem value="payables">Payables</ToggleGroupItem>}
            </ToggleGroup>
            <p className="text-sm text-muted-foreground">{area === "treasury" ? "Preview and execute a rebalance within the signed policy and authorized strategy." : "Manage confidential invoices, agreements and owner-approved payouts, or create isolated purchase orders and track their payments."}</p>
          </FieldSet>
        </FieldGroup>
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy || connecting || (kind === "dao" && !daoId)}>{busy && <Spinner />}{busy ? "Opening your setup…" : "Continue setup"}</Button>
        <p role="status" className="text-sm text-muted-foreground">{busy ? "Preparing your agent’s setup. No money action has been submitted." : "Continuing saves your setup. Creating the agent requires a separate owner signature."}</p>
      </form>
    </section>}
  </main>;
}
