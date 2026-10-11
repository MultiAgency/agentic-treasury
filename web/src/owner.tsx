import { Snowflake, Sun, UsersThree, Wallet as WalletIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { client } from "./lib";
import { Badge, Button, Card, input, Section, Spinner, Step } from "./ui";
import { connect, dao, disconnect, ownerWallet, send, signIntent, useWallet } from "./wallet";

export type Setup = Awaited<ReturnType<typeof client.setup>>;
export type Destination = { address: string; confidential: boolean };
export type OwnerAction = Parameters<typeof client.owner.prepare>[0]["action"];
export type PolicyChanges = Extract<OwnerAction, { type: "policy_update" }>["changes"];

/** Whether an owner action ended the way it was meant to: a rejected payment is a reject vote's success. */
function ended(action: OwnerAction, status?: string, failureCode?: string | null) {
  const rejecting = action.type === "approval_vote" && action.verdict === "reject";
  if (status === "SUCCESS" || (rejecting && status)) return;
  throw new Error(failureCode ?? `Ended ${status?.toLowerCase()}`);
}

const short = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Signer = "wallet" | "dao";
/** Who signs this agent's owner actions: the linked DAO when its owner account owns the agent. */
export const ownerSigner = (setup: Setup): Signer =>
  setup.dao && setup.owner?.type === "near" && setup.owner.account_id === setup.dao.owner.account_id ? "dao" : "wallet";

/** Trezu connected as `daoId`, connecting first when it isn't. */
async function ensureDao(daoId: string) {
  const current = (await dao.connector.getConnectedWallet().catch(() => null))?.accounts[0]?.accountId;
  if (current !== daoId) await dao.connect();
  const connected = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (connected !== daoId) throw new Error(`Trezu is connected as ${connected}, not ${daoId}`);
}

/** Seconds until `iso`, ticking while `iso` is set. */
function useCountdown(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000)) : null;
}

/**
 * Runs one owner action end to end. The owner's wallet signs the API's payload directly; a DAO
 * files one proposal through Trezu asking its MPC key to sign, and the server submits the
 * signature once the vote passes, inside the API's signing window.
 */
export function useOwnerAction(setup: Setup) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "filing" | "voting" | "settling">("idle");
  const [deadline, setDeadline] = useState<string>();
  const [error, setError] = useState<string>();
  /** For a policy update, the digest of the mandate being signed. */
  const [digest, setDigest] = useState<string | null>(null);
  const left = useCountdown(step === "voting" ? deadline : undefined);

  async function viaDao(action: OwnerAction) {
    if (!setup.dao) throw new Error("Link the DAO as the treasury first");
    await ensureDao(setup.dao.id);
    const prepared = await client.owner.prepare({ action, signer: "dao" });
    if (!("dao" in prepared) || !prepared.dao) throw new Error("The server did not prepare a DAO signature");
    setDigest(prepared.digest);
    setStep("filing");
    await dao.send(prepared.dao.transaction);
    setDeadline(prepared.expiresAt);
    setStep("voting");
    // The server watches for the DAO's signature and submits it; follow it to the end.
    while (true) {
      await sleep(5_000);
      const state = await client.owner.status({ correlationId: prepared.correlationId });
      if (state.stage === "submitted") return ended(action, state.status, state.failureCode);
      if (state.stage === "expired") throw new Error("The vote did not pass before the API's signing window closed. Try again.");
      if (state.stage === "failed") throw new Error(state.error);
      if (state.stage === "submitting") setStep("settling");
      if (state.stage === "unknown") throw new Error("The server lost track of this action. Try again.");
    }
  }

  async function viaWallet(action: OwnerAction) {
    const prepared = await client.owner.prepare({
      action: action.type === "agent_create" ? { ...action, owner: await ownerWallet() } : action,
      signer: "wallet",
    });
    if (!("intent" in prepared) || !prepared.intent) throw new Error("The server did not prepare a wallet signature");
    setDigest(prepared.digest);
    setStep("signing");
    const signedData = await signIntent(prepared.intent);
    setStep("settling");
    try {
      const result = await client.owner.submit({ correlationId: prepared.correlationId, signedData });
      if (["SUCCESS", "FAILED", "REFUNDED"].includes(result.status))
        return ended(action, result.status, result.failureCode);
    } catch (error) {
      const state = await client.owner.status({ correlationId: prepared.correlationId });
      if (state.stage !== "submitting" && state.stage !== "submitted") throw error;
    }
    // An accepted or ambiguous submission is followed by ID, never signed or sent again.
    while (true) {
      const state = await client.owner.status({ correlationId: prepared.correlationId });
      if (state.stage === "submitted") return ended(action, state.status, state.failureCode);
      if (state.stage !== "submitting") throw new Error("Owner action needs review");
      await sleep(5_000);
    }
  }

  /** Whether the action ended as meant; otherwise `error` says why. */
  async function run(action: OwnerAction, signer: Signer = ownerSigner(setup)) {
    setError(undefined);
    try {
      setStep("preparing");
      await (signer === "dao" ? viaDao(action) : viaWallet(action));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setStep("idle");
      setDeadline(undefined);
      setDigest(null);
      await queryClient.invalidateQueries();
    }
  }

  const label = {
    idle: null,
    preparing: "Preparing…",
    signing: "Approve in your wallet…",
    filing: "File the proposal in Trezu…",
    voting: `Waiting for ${setup.dao?.id ?? "the DAO"} to approve · ${left === null ? "" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`}`,
    settling: "Settling on chain…",
  }[step];
  return { run, busy: step !== "idle", label, error, digest };
}

/** Whether this page can sign as the agent's owner: the DAO through Trezu, or the owner's own wallet. */
export function useCanSign(setup: Setup) {
  const wallet = useWallet();
  if (ownerSigner(setup) === "dao") return true;
  return Boolean(setup.owner && setup.owner.type === "near" && wallet.accountId === setup.owner.account_id);
}

export function ownerName(setup: Setup) {
  if (ownerSigner(setup) === "dao") return `${setup.dao?.id} (by proposal)`;
  return setup.owner?.type === "near" ? setup.owner.account_id : "the owner's wallet";
}

export function WalletButton() {
  const wallet = useWallet();
  if (wallet.status === "connected" && wallet.accountId)
    return (
      <div className="flex items-center gap-2">
        <Badge>
          <WalletIcon size={12} weight="bold" /> <span className="font-mono">{short(wallet.accountId)}</span>
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  return (
    <Button variant="outline" size="sm" disabled={wallet.status === "connecting"} onClick={() => connect().catch(() => {})}>
      {wallet.status === "connecting" ? <Spinner /> : <WalletIcon size={16} />}
      Connect wallet
    </Button>
  );
}

export function ActionError({ error }: { error?: string }) {
  if (!error) return null;
  return <p className="rounded-xl bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">{error}</p>;
}

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
  const [kind, setKind] = useState<"treasury" | "payout">("treasury");
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

  const fundOwner = (via: "dao" | "wallet") => async () => {
    const owner = setup.dao!.owner.account_id;
    const transfer = { receiverId: owner, actions: [{ type: "Transfer" as const, params: { deposit: "50000000000000000000000" } }] };
    setFunding(via === "dao" ? "Filed in Trezu. The account exists once the DAO approves." : "Sending…");
    try {
      if (via === "dao") {
        await ensureDao(setup.dao!.id);
        await dao.send(transfer);
      } else await send(transfer);
    } catch (e) {
      setFunding(e instanceof Error ? e.message : String(e));
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
                <Button onClick={fundOwner("dao")}>
                  <UsersThree size={18} /> Fund from the DAO
                </Button>
                <Button variant="outline" disabled={wallet.status !== "connected"} onClick={fundOwner("wallet")}>
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
                <input type="radio" checked={kind === "treasury"} onChange={() => setKind("treasury")} />
                <span>
                  <span className="font-medium">Treasury agent.</span>{" "}
                  <span className="text-muted-foreground">Swaps between USDC, wNEAR and ETH inside caps, with no vote per action.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" checked={kind === "payout"} onChange={() => setKind("payout")} />
                <span>
                  <span className="font-medium">Payout agent.</span>{" "}
                  <span className="text-muted-foreground">
                    Pays agreed payees in USDC, confidentially. Every payout waits for the owner's approval; at most 25 USDC a
                    payout, 50 a day, 200 a month.
                  </span>
                </span>
              </label>
            </div>
            {kind === "payout" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Agreed payees (NEAR Intents accounts, separated by commas)</span>
                <input className={input} value={payees} onChange={(e) => setPayees(e.target.value)} />
              </label>
            )}
            <ActionError error={action.error} />
            <ActionRow
              label={action.label}
              busy={action.busy || (kind === "payout" && payeeList.length === 0)}
              onClick={() => action.run({ type: "agent_create", kind, payees: kind === "payout" ? payeeList : undefined }, signer)}
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
            <ActionError error={action.error} />
            <ActionRow label={action.label} busy={action.busy || !canSign} onClick={() => action.run({ type: "grant_issue" })}>
              {isDao ? "Propose the grant" : "Issue grant"}
            </ActionRow>
          </Step>
        </ol>
      </Card>
    </Section>
  );
}

/** Freeze and unfreeze, signed by the owner: a frozen agent can move nothing. */
export function OwnerControls({ setup, frozen }: { setup: Setup; frozen: boolean }) {
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const canSign = useCanSign(setup);
  const viaDao = ownerSigner(setup) === "dao";
  const type = frozen ? "agent_unfreeze" : "agent_freeze";
  const verb = frozen ? "unfreeze" : "freeze";

  const onClick = async () => {
    if (!viaDao && wallet.status !== "connected") await connect().catch(() => {});
    else await action.run({ type });
  };
  const connectedNotOwner = !viaDao && wallet.status === "connected" && !canSign;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        {action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
        <Button variant="outline" size="sm" disabled={action.busy || connectedNotOwner} onClick={onClick}>
          {action.busy ? <Spinner /> : frozen ? <Sun size={16} /> : <Snowflake size={16} />}
          {viaDao ? `Propose to ${verb}` : wallet.status === "connected" ? (frozen ? "Unfreeze" : "Freeze") : `Connect to ${verb}`}
        </Button>
      </div>
      {connectedNotOwner && <span className="text-xs text-muted-foreground">Only {ownerName(setup)} can {verb}</span>}
      <ActionError error={action.error} />
    </div>
  );
}
