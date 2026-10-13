import { ArrowUUpLeft, Bank, LockKey, UsersThree } from "@phosphor-icons/react";
import { useState } from "react";
import { ago, client, fromUnits, type Overview, short, toUnits, useAttempt } from "./lib";
import type { Setup } from "./owner";
import { AssetAmount, PayoutResult, useDestinations, usePayout } from "./payout";
import { useAgent } from "./shell";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, input, Section, Spinner } from "./ui";
import { connect, dao, type Transaction, send, useWallet } from "./wallet";

export type Treasury = NonNullable<Awaited<ReturnType<typeof client.treasury.get>>>;

/** Connects a DAO in Trezu and links it as the treasury. */
export async function linkTrezuDao() {
  await dao.connect();
  const id = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (!id) throw new Error("Trezu returned no DAO account");
  await client.treasury.link({ accountId: id });
}

function LinkTreasury() {
  const wallet = useWallet();
  const daoWallet = dao.use();
  const [accountId, setAccountId] = useState("");
  const link = useAttempt();

  const linkTo = (id: string) => link.attempt(() => client.treasury.link({ accountId: id }));

  return (
    <Card>
      <p className="text-sm text-muted-foreground">
        Link the account this agent works for. Funds come from it, can return to it, and its payees become the agent's
        agreed payees. A DAO votes on each step through Trezu.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={link.busy || wallet.status !== "connected"}
          onClick={() => wallet.accountId && linkTo(wallet.accountId)}
        >
          <Bank size={18} /> {wallet.accountId ? `Use ${short(wallet.accountId, 24)}` : "Use my account"}
        </Button>
        <Button
          variant="outline"
          disabled={link.busy || daoWallet.status === "connecting"}
          onClick={() => link.attempt(linkTrezuDao)}
        >
          {daoWallet.status === "connecting" ? <Spinner /> : <UsersThree size={18} />} Connect a DAO with Trezu
        </Button>
      </div>
      <form
        className="flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (accountId.trim()) linkTo(accountId.trim());
        }}
      >
        <input
          className={`${input} flex-1`}
          placeholder="or any NEAR account, e.g. treasury.near or name.sputnik-dao.near"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={link.busy || !accountId.trim()}>
          {link.busy && <Spinner />} Link
        </Button>
      </form>
      <ErrorBox error={link.error} />
    </Card>
  );
}

/**
 * Who signs as the treasury: the owner's wallet when the treasury is that account, Trezu when it
 * is a DAO. Each sends the same transaction; Trezu files it as a proposal.
 */
function useTreasurySigner(treasury: Treasury) {
  const wallet = useWallet();
  const daoWallet = dao.use();
  const isDao = Boolean(treasury.dao);
  const session = isDao ? daoWallet : wallet;
  return {
    isDao,
    ready: session.status === "connected" && session.accountId === treasury.accountId,
    connected: session.accountId,
    connect: () => (isDao ? dao.connect() : connect()),
    send: (transaction: Transaction) => (isDao ? dao.send(transaction) : send(transaction)),
  };
}

/** The proposal id an add_proposal returns, when the wallet passes the outcome through. */
function proposalId(outcome: unknown) {
  const value = (outcome as { status?: { SuccessValue?: string } } | undefined)?.status?.SuccessValue;
  if (!value) return null;
  const id = Number(atob(value));
  return Number.isInteger(id) ? id : null;
}

function Fund({ treasury }: { treasury: Treasury }) {
  const signer = useTreasurySigner(treasury);
  const [asset, setAsset] = useState<"USDC" | "NEAR">("USDC");
  const [value, setValue] = useState("");
  const fund = useAttempt();
  const amount = toUnits(value, asset === "USDC" ? 6 : 24);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-medium">Fund the agent</h3>
      <p className="text-sm text-muted-foreground">
        {signer.isDao
          ? "Files one proposal in Trezu: the DAO pays a fresh deposit address once its members approve."
          : "Sends from the treasury account to a fresh deposit address."}{" "}
        Funds land in the agent's private balance.
      </p>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!amount) return;
          fund.attempt(async () => {
            const { transaction } = await client.treasury.fund({ asset, amount });
            const outcome = await signer.send(transaction);
            if (!signer.isDao) return "Sent. The book updates once the deposit lands.";
            const id = proposalId(outcome);
            return `Filed in Trezu${id === null ? "" : ` as proposal #${id}`}. It pays out once the DAO approves.`;
          });
        }}
      >
        <input className={`${input} w-36`} inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)} />
        <select className={`${input} pr-8`} value={asset} onChange={(e) => setAsset(e.target.value as "USDC" | "NEAR")}>
          <option value="USDC">USDC</option>
          <option value="NEAR">NEAR (as wNEAR)</option>
        </select>
        {signer.ready ? (
          <Button type="submit" disabled={fund.busy || !amount}>
            {fund.busy && <Spinner />} {signer.isDao ? "File funding proposal" : "Send"}
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => signer.connect().catch(() => {})}>
            {signer.isDao ? "Connect in Trezu" : "Connect wallet"}
          </Button>
        )}
      </form>
      {signer.connected && !signer.ready && (
        <p className="text-sm text-warning-muted-foreground">
          Connected as {short(signer.connected, 24)}, not {short(treasury.accountId, 24)}.
        </p>
      )}
      {fund.message && <p className="text-sm text-success-muted-foreground">{fund.message}</p>}
      <ErrorBox error={fund.error} />
    </div>
  );
}

/**
 * A confidential DAO pays from its private balance, in Trezu. Only a `nearcom:` recipient keeps
 * the payment private: a bare account sends it out as a public withdrawal to the agent's account.
 */
function ConfidentialFund({ treasury, wallet }: { treasury: Treasury; wallet: string }) {
  const recipient = `nearcom:${wallet}`;
  const payment = `https://trezu.app/${treasury.accountId}/payments?address=${encodeURIComponent(recipient)}`;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-medium">Fund the agent</h3>
      <p className="text-sm text-muted-foreground">
        Create a payment in Trezu from the confidential balance, to the near.com network. It never touches the public
        chain and lands in the agent's private balance once the DAO approves.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3" title={recipient}>
          {recipient}
        </code>
        <CopyButton text={recipient} />
      </div>
      <p className="text-sm text-warning-muted-foreground">
        Keep the <code>nearcom:</code> prefix. Without it the payment leaves the private side and lands publicly.
      </p>
      <Button className="self-start" onClick={() => window.open(payment, "_blank", "noopener")}>
        Open payment in Trezu
      </Button>
    </div>
  );
}

function Return({ treasury, data, setup }: { treasury: Treasury; data: Overview; setup: Setup }) {
  const destinations = useDestinations(data, setup);
  const entry = destinations.current.find((d) => d.address === treasury.accountId);
  const payout = usePayout();
  const [asset, setAsset] = useState(data.book[0]?.asset ?? "");
  const [value, setValue] = useState("");
  const holding = data.book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;

  return (
    <div className="flex flex-col gap-3">
      {entry ? (
        <>
          <p className="text-sm text-muted-foreground">
            The treasury is an allowed destination{entry.confidential ? ", paid confidentially" : ""}. Returns land in its
            NEAR Intents balance.
          </p>
          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (amount) payout.pay({ recipient: treasury.accountId, asset, amount, confidential: entry.confidential });
            }}
          >
            <AssetAmount book={data.book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} />
            <Button type="submit" disabled={payout.busy || !amount}>
              {payout.busy ? <Spinner /> : <ArrowUUpLeft size={18} />} Return
            </Button>
            <PayoutResult result={payout.result} />
          </form>
          <ErrorBox error={payout.error} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The agent can't send anything to the treasury yet. The owner signs it in as the agent's first destination; the
            policy still caps every transfer.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={destinations.action.busy || Boolean(destinations.blocked)}
              onClick={() => destinations.add({ address: treasury.accountId, confidential: Boolean(treasury.dao) })}
            >
              {destinations.action.busy && <Spinner />} Allow returns to the treasury
            </Button>
            <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          </div>
          <ErrorBox error={destinations.action.error} />
        </>
      )}
    </div>
  );
}

/** A deposit address for NEAR-native USDC; anyone can fund the account, no signature needed. */
function Deposit() {
  const [deposit, setDeposit] = useState<Awaited<ReturnType<typeof client.deposit>>>();
  const { busy, error, attempt } = useAttempt();
  const request = () => attempt(async () => setDeposit(await client.deposit()));

  return (
    <Section title="Fund the account" description="The book is empty. Send USDC on NEAR to a one-time deposit address.">
      <Card>
        {deposit ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground">Deposit address</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3">{deposit.address}</code>
                <CopyButton text={deposit.address} />
              </div>
            </div>
            {deposit.memo && (
              <p>
                Memo <code>{deposit.memo}</code> (required)
              </p>
            )}
            <p className="text-muted-foreground">
              {deposit.minAmount && `At least ${fromUnits(deposit.minAmount, 6)} USDC. `}
              {deposit.expiresAt && `Expires ${ago(deposit.expiresAt)}. `}
              The book updates once it lands.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm text-muted-foreground">Incoming funds need no grant and no owner signature.</p>
            <ErrorBox error={error} />
            <Button disabled={busy} onClick={request}>
              {busy && <Spinner />} Get a deposit address
            </Button>
          </div>
        )}
      </Card>
    </Section>
  );
}

/**
 * Whether the DAO is a confidential treasury in Trezu. Nothing on chain says so, and it decides
 * whether its public proposals are a source of payees: a confidential DAO pays out of public view.
 */
function ConfidentialSetting({ treasury }: { treasury: Treasury }) {
  const { busy, error, attempt } = useAttempt();
  return (
    <>
      <label className="flex items-center gap-2 text-muted-foreground">
        <input
          type="checkbox"
          checked={treasury.confidential}
          disabled={busy}
          onChange={(e) => attempt(() => client.treasury.setConfidential({ confidential: e.target.checked }))}
        />
        <LockKey size={14} /> Confidential in Trezu
      </label>
      <ErrorBox error={error} />
    </>
  );
}

export function TreasurySection() {
  const { treasury, data, setup } = useAgent();
  const unlink = useAttempt();
  const empty = data.book.every((h) => h.usd === 0);
  return (
    <>
    <Section
      title="Treasury"
      description="The account this agent works for: any NEAR account, or a DAO that votes on funding and payees."
    >
      {!treasury ? (
        <LinkTreasury />
      ) : (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-lg">{treasury.accountId}</span>
              <span className="text-sm text-muted-foreground">
                {treasury.balances.near} NEAR · {fromUnits(treasury.balances.usdc, 6)} USDC in the account
              </span>
            </div>
            {treasury.dao ? (
              <Badge tone="info">
                <UsersThree size={12} weight="bold" /> DAO · {treasury.dao.members.length} member
                {treasury.dao.members.length === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge>NEAR account</Badge>
            )}
          </div>
          <div className="border-t pt-6">
            {treasury.dao && treasury.confidential && setup.wallet ? (
              <ConfidentialFund treasury={treasury} wallet={setup.wallet} />
            ) : (
              <Fund treasury={treasury} />
            )}
          </div>
          <Details summary="Return funds to the treasury" className="border-t pt-4">
            <Return treasury={treasury} data={data} setup={setup} />
          </Details>
          <Details summary="Treasury settings">
            {treasury.dao && (
              <>
                <span className="text-muted-foreground">Approvers: {treasury.dao.approvers.map((a) => `${a.role} ${a.threshold}`).join(" · ")}</span>
                <ConfidentialSetting treasury={treasury} />
              </>
            )}
            <div>
              <Button variant="outline" size="sm" disabled={unlink.busy} onClick={() => unlink.attempt(() => client.treasury.unlink())}>
                Unlink this treasury
              </Button>
            </div>
            <ErrorBox error={unlink.error} />
          </Details>
        </Card>
      )}
    </Section>
    {!treasury && empty && <Deposit />}
    </>
  );
}
