import { UsersThree, Wallet as WalletIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { client, errorMessage, short } from "./lib";
import { ensureDao, ownerName, ownerSigner, type Setup, type Signer, useCanSign, useOwnerAction } from "./owner";
import { Button, Card, ErrorBox, input, Section, Spinner, Step } from "./ui";
import { connect, dao, send, useWallet } from "./wallet";

function ActionRow({ label, busy, onClick, children }: { label: string | null; busy: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={busy} onClick={onClick}>
        {busy && <Spinner />} {children}
      </Button>
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  );
}

/**
 * Onboarding. The owner is a person's wallet, or a DAO through Trezu: then an account only the
 * DAO's votes can sign for owns the agent, and every owner action is one proposal.
 */
export function Onboarding({ setup }: { setup: Setup }) {
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const daoWallet = dao.use();
  const action = useOwnerAction(setup);
  const canSign = useCanSign(setup);
  const [choice, setChoice] = useState<Signer | null>(setup.dao ? "dao" : null);
  const [funding, setFunding] = useState<string>();
  const [role, setRole] = useState<"treasury" | "payout">("treasury");
  const [payees, setPayees] = useState(setup.dao?.id ?? "");
  const payeeList = payees.split(/[\s,]+/).filter(Boolean);
  const signer: Signer = setup.agentId ? ownerSigner(setup) : (choice ?? "wallet");
  const isDao = signer === "dao" && Boolean(setup.dao);

  const chosen = isDao ? true : wallet.status === "connected";
  type StepId = "owner" | "fund" | "create" | "grant";
  const steps: StepId[] = isDao ? ["owner", "fund", "create", "grant"] : ["owner", "create", "grant"];
  const done: Record<StepId, boolean> = { owner: chosen, fund: Boolean(setup.dao?.funded), create: Boolean(setup.agentId), grant: Boolean(setup.grant) };
  const current = steps.find((s) => !done[s]);
  const status = (s: StepId) => (done[s] ? "complete" : s === current ? "current" : "upcoming");

  // Poll while the owner account's funding proposal is out.
  useEffect(() => {
    if (!funding || setup.dao?.funded) return;
    const timer = setInterval(() => queryClient.invalidateQueries({ queryKey: ["setup"] }), 5_000);
    return () => clearInterval(timer);
  }, [funding, setup.dao?.funded, queryClient]);

  async function linkDao() {
    await dao.connect();
    const id = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
    if (!id) throw new Error("Trezu returned no DAO account");
    await client.treasury.link({ accountId: id });
    setChoice("dao");
    await queryClient.invalidateQueries();
  }

  const fundOwner = (daoId: string, owner: string, via: "dao" | "wallet") => async () => {
    const transfer = { receiverId: owner, actions: [{ type: "Transfer" as const, params: { deposit: "50000000000000000000000" } }] };
    setFunding(via === "dao" ? "Filed in Trezu. The account exists once the DAO approves." : "Sending…");
    try {
      if (via === "dao") {
        await ensureDao(daoId);
        await dao.send(transfer);
      } else await send(transfer);
    } catch (e) {
      setFunding(errorMessage(e));
    }
  };

  let n = 0;
  return (
    <Section
      title="Set up the agent"
      description={
        isDao
          ? `${setup.dao?.id} owns the agent: each owner step is one proposal its members approve in Trezu.`
          : "Your wallet signs twice: once to create the agent with its policy, once to let this server act for it."
      }
    >
      <Card>
        <ol className="flex flex-col">
          <Step
            number={++n}
            title="Choose the owner"
            status={status("owner")}
            summary={isDao ? `DAO ${setup.dao?.id}, through Trezu` : wallet.accountId && <span className="font-mono">{wallet.accountId}</span>}
          >
            <p className="text-sm text-muted-foreground">
              The owner sets the policy, issues grants and can freeze the agent. A DAO owns it through an account only its
              votes can sign for.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant={choice === "dao" ? "outline" : "default"} disabled={wallet.status === "connecting"} onClick={() => { setChoice("wallet"); connect().catch(() => {}); }}>
                <WalletIcon size={18} /> My wallet
              </Button>
              <Button variant="outline" disabled={daoWallet.status === "connecting"} onClick={() => linkDao().catch(() => {})}>
                {daoWallet.status === "connecting" ? <Spinner /> : <UsersThree size={18} />} A DAO, through Trezu
              </Button>
            </div>
          </Step>
          {isDao && setup.dao && (
            <Step
              number={++n}
              title="Create the DAO's owner account"
              status={status("fund")}
              summary={<span className="font-mono">{short(setup.dao.owner.account_id)}</span>}
            >
              <p className="text-sm text-muted-foreground">
                Its only key is derived from {setup.dao.id} by NEAR's MPC network, so only the DAO's proposals can sign for
                it. Sending it 0.05 NEAR creates it; any account can.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={fundOwner(setup.dao.id, setup.dao.owner.account_id, "dao")}>
                  <UsersThree size={18} /> Fund from the DAO
                </Button>
                <Button variant="outline" disabled={wallet.status !== "connected"} onClick={fundOwner(setup.dao.id, setup.dao.owner.account_id, "wallet")}>
                  <WalletIcon size={18} /> Fund from my wallet
                </Button>
              </div>
              {funding && <p className="text-sm text-muted-foreground">{funding}</p>}
            </Step>
          )}
          <Step
            number={++n}
            title="Create the agent"
            status={status("create")}
            summary={setup.agentId && <span className="font-mono">{short(setup.agentId)}</span>}
          >
            <p className="text-sm text-muted-foreground">
              Creates the agent's account with a policy from <code>src/policy.ts</code>. Funds can never leave it without a
              destination the owner signs in.
            </p>
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" checked={role === "treasury"} onChange={() => setRole("treasury")} />
                <span>
                  <span className="font-medium">Treasury agent.</span>{" "}
                  <span className="text-muted-foreground">Swaps between USDC, wNEAR and ETH inside caps, with no vote per action.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" checked={role === "payout"} onChange={() => setRole("payout")} />
                <span>
                  <span className="font-medium">Payout agent.</span>{" "}
                  <span className="text-muted-foreground">
                    Pays agreed payees in USDC, confidentially. Every payout waits for the owner's approval; at most 25 USDC a
                    payout, 50 a day, 200 a month.
                  </span>
                </span>
              </label>
            </div>
            {role === "payout" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Agreed payees (NEAR Intents accounts, separated by commas)</span>
                <input className={input} value={payees} onChange={(e) => setPayees(e.target.value)} />
              </label>
            )}
            <ErrorBox error={action.error} />
            <ActionRow
              label={action.label}
              busy={action.busy || (role === "payout" && payeeList.length === 0)}
              onClick={() => action.run({ type: "agent_create", role, payees: role === "payout" ? payeeList : undefined }, signer)}
            >
              {isDao ? "Propose creating the agent" : "Create agent"}
            </ActionRow>
          </Step>
          <Step number={++n} title="Issue the agent's grant" status={status("grant")} last>
            <p className="text-sm text-muted-foreground">
              Lets this server act for the agent inside the policy for 30 days. The grant's token stays in this server's{" "}
              settings file; the owner signs only its fingerprint.
            </p>
            {!canSign && (
              <p className="text-sm text-warning-muted-foreground">Only {ownerName(setup)} can issue grants. Connect that wallet.</p>
            )}
            <ErrorBox error={action.error} />
            <ActionRow label={action.label} busy={action.busy || !canSign} onClick={() => action.run({ type: "grant_issue" })}>
              {isDao ? "Propose the grant" : "Issue grant"}
            </ActionRow>
          </Step>
        </ol>
      </Card>
    </Section>
  );
}
