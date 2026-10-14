import { Snowflake, Sun, Wallet as WalletIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { client, errorMessage, minutesSeconds, short, useCountdown } from "./lib";
import { Badge, Button, ErrorBox, Spinner } from "./ui";
import { useViewer } from "./viewer";
import { connect, dao, disconnect, ownerWallet, sendAsMember, signIntent, useWallet } from "./wallet";

export type Setup = Awaited<ReturnType<typeof client.setup>>;
export type Destination = { address: string; confidential: boolean };
export type OwnerAction = Parameters<typeof client.owner.prepare>[0]["action"];
export type PolicyChanges = Extract<OwnerAction, { type: "policy_update" }>["changes"];

/** Whether an owner action ended the way it was meant to: a rejected payment is a reject vote's success. */
async function ended(action: OwnerAction, correlationId: string, status?: string, failureCode?: string | null) {
  if (action.type === "approval_vote") {
    const record = (await client.owner.actions()).find(a => a.correlationId === correlationId);
    if (record?.ownerSucceeded) return;
    throw new Error("Owner approval outcome could not be confirmed. Review the existing owner action before signing again.");
  }
  if (status === "SUCCESS") return;
  throw new Error(failureCode ?? `Ended ${status?.toLowerCase()}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Signer = "wallet" | "dao";
/** Who signs this agent's owner actions: the linked DAO when its owner account owns the agent. */
export const ownerSigner = (setup: Setup): Signer =>
  setup.dao && setup.owner?.type === "near" && setup.owner.account_id === setup.dao.owner.account_id ? "dao" : "wallet";

/** Trezu connected as `daoId`, connecting first when it isn't. */
export async function ensureDao(daoId: string) {
  const current = (await dao.connector.getConnectedWallet().catch(() => null))?.accounts[0]?.accountId;
  if (current !== daoId) await dao.connect();
  const connected = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (connected !== daoId) throw new Error(`Trezu is connected as ${connected}, not ${daoId}`);
}

/**
 * Runs one owner action end to end. The owner's wallet signs the API's payload directly; a DAO
 * files one proposal through Trezu asking its MPC key to sign, and the server submits the
 * signature once the vote passes, inside the API's signing window.
 */
export function useOwnerAction(setup: Setup) {
  const queryClient = useQueryClient();
  const viewer = useViewer();
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "filing" | "voting" | "settling">("idle");
  const [deadline, setDeadline] = useState<string>();
  const [error, setError] = useState<string>();
  /** For a policy update, the digest of the mandate being signed. */
  const [digest, setDigest] = useState<string | null>(null);
  const left = useCountdown(step === "voting" ? deadline : undefined);

  async function viaDao(action: OwnerAction) {
    if (!setup.dao) throw new Error("Link the DAO as the treasury first");
    // A signed-in member who may file proposals files it from their own wallet, with a description
    // saying what it signs; otherwise Trezu files it, as a generic "sign on v1.signer".
    const ownWallet = viewer?.canPropose ?? false;
    if (!ownWallet) await ensureDao(setup.dao.id);
    const prepared = await client.owner.prepare({ action, signer: "dao" });
    if (!("dao" in prepared) || !prepared.dao) throw new Error("The server did not prepare a DAO signature");
    setDigest(prepared.digest);
    setStep("filing");
    // A member who may also vote files and approves it in one confirmation; the vote passes at once.
    const filing = viewer?.canVote && prepared.dao.proposalAndVote ? prepared.dao.proposalAndVote : prepared.dao.proposal;
    if (ownWallet && filing) {
      const outcome = (await sendAsMember(filing)) as { status?: { Failure?: unknown } } | undefined;
      // Reverted as one, so nothing was filed: most likely another proposal took the id the vote named.
      if (outcome?.status?.Failure) throw new Error(`The transaction failed, so nothing was filed. Try again. ${JSON.stringify(outcome.status.Failure)}`);
    }
    else {
      if (ownWallet) await ensureDao(setup.dao.id);
      await dao.send(prepared.dao.transaction);
    }
    setDeadline(prepared.expiresAt);
    setStep("voting");
    // The server watches for the DAO's signature and submits it; follow it to the end.
    while (true) {
      await sleep(5_000);
      const state = await client.owner.status({ correlationId: prepared.correlationId });
      if (state.stage === "submitted") return ended(action, prepared.correlationId, state.status, state.failureCode);
      if (state.stage === "expired") throw new Error("The vote did not pass before the API's signing window closed. Try again.");
      if (state.stage === "failed") throw new Error(state.error);
      if (state.stage === "submitting") setStep("settling");
      if (state.stage === "unknown") throw new Error("The server lost track of this action. Ask the operator to review its status before trying again.");
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
        return ended(action, prepared.correlationId, result.status, result.failureCode);
    } catch (error) {
      const state = await client.owner.status({ correlationId: prepared.correlationId });
      if (state.stage !== "submitting" && state.stage !== "submitted") throw error;
    }
    // An accepted or ambiguous submission is followed by ID, never signed or sent again.
    while (true) {
      const state = await client.owner.status({ correlationId: prepared.correlationId });
      if (state.stage === "submitted") return ended(action, prepared.correlationId, state.status, state.failureCode);
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
      setError(errorMessage(e));
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
    filing: viewer?.canPropose ? `Confirm the proposal${viewer.canVote ? " and your vote" : ""} in your wallet…` : "File the proposal in Trezu…",
    voting: `Waiting for ${setup.dao?.id ?? "the DAO"} to approve · ${left === null ? "" : `${minutesSeconds(left)} left`}`,
    settling: "Checking the owner action’s outcome…",
  }[step];
  return { run, busy: step !== "idle", label: label && <>{label}{setup.dao && (step === "voting" || step === "settling") && <> · <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://trezu.app/${setup.dao.id}/requests`}>Review and vote in Trezu</a></>}</>, error, digest };
}

/**
 * Who signs as the agent's owner from this page: the DAO through Trezu, or the owner's own wallet, which
 * must be connected first and must be the owner's account.
 */
export function useSigner(setup: Setup) {
  const wallet = useWallet();
  const viaDao = ownerSigner(setup) === "dao";
  const canSign = viaDao || (setup.owner?.type === "near" && wallet.accountId === setup.owner.account_id);
  return {
    viaDao,
    canSign,
    needsWallet: !viaDao && wallet.status !== "connected",
    connectedNotOwner: !viaDao && wallet.status === "connected" && !canSign,
  };
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

/** Freeze and unfreeze, signed by the owner: a frozen agent can move nothing. */
export function OwnerControls({ setup, frozen }: { setup: Setup; frozen: boolean }) {
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const { viaDao, needsWallet, connectedNotOwner } = useSigner(setup);
  const type = frozen ? "agent_unfreeze" : "agent_freeze";
  const verb = frozen ? "unfreeze" : "freeze";

  const onClick = async () => {
    if (needsWallet) await connect().catch(() => {});
    else await action.run({ type });
  };

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
      <ErrorBox error={action.error} />
    </div>
  );
}
