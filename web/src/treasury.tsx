import { ArrowUUpLeft, Bank, Copy, LockKey, PaperPlaneTilt, Plus, UsersThree, X } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ago, client, type Overview, toUnits } from "./lib";
import { ActionError, type Destination, type Setup, useCanSign, useOwnerAction } from "./owner";
import { useAgent } from "./shell";
import { Badge, Button, Card, input, Section, Spinner, statusTone } from "./ui";
import { connect, dao, type Transaction, send, useWallet } from "./wallet";

export type Treasury = NonNullable<Awaited<ReturnType<typeof client.treasury.get>>>;

const short = (id: string) => (id.length > 24 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

/** The policy's transfer destinations: where the agent may send funds at all. */
export function destinationsOf(data: Overview): Destination[] {
  return (data.policy.policy?.destinations.list ?? []).flatMap((d) =>
    d.action === "transfer" ? [{ address: d.address, confidential: d.confidential }] : [],
  );
}

/** Policy edits share a 10-minute cooldown per agent; freezing is exempt. */
function cooldownLeft(data: Overview) {
  const at = data.policy.cooldowns.policy_change_available_at;
  const ms = at ? new Date(at).getTime() - Date.now() : 0;
  return ms > 0 ? `${Math.ceil(ms / 60_000)} min` : null;
}

function useMessage() {
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function attempt(work: () => Promise<string>) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      setMessage(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { message, error, busy, attempt };
}

/** Owner-signed edits to the destination list, shared by returns and payees. */
function useDestinations(data: Overview, setup: Setup) {
  const action = useOwnerAction(setup);
  const isOwner = useCanSign(setup);
  const current = destinationsOf(data);
  const cooldown = cooldownLeft(data);
  return {
    current,
    action,
    blocked: !isOwner ? "Only the owner can change the agreement." : cooldown ? `The policy can change again in ${cooldown}.` : null,
    add: (destination: Destination) =>
      action.run({ type: "policy_update", changes: { destinations: [...current, destination] } }),
    remove: (address: string) =>
      action.run({ type: "policy_update", changes: { destinations: current.filter((d) => d.address !== address) } }),
  };
}

function LinkTreasury() {
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const daoWallet = dao.use();
  const [accountId, setAccountId] = useState("");
  const link = useMessage();

  const linkTo = (id: string) =>
    link.attempt(async () => {
      await client.treasury.link({ accountId: id });
      await queryClient.invalidateQueries();
      return "";
    });

  return (
    <Card>
      <p className="text-sm text-muted-foreground">
        Link the account this agent works for. Funds come from it, can return to it, and its payees form the agent's
        agreement. A DAO votes on each step through Trezu.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={link.busy || wallet.status !== "connected"}
          onClick={() => wallet.accountId && linkTo(wallet.accountId)}
        >
          <Bank size={18} /> {wallet.accountId ? `Use ${short(wallet.accountId)}` : "Use my account"}
        </Button>
        <Button
          variant="outline"
          disabled={link.busy || daoWallet.status === "connecting"}
          onClick={() =>
            link.attempt(async () => {
              await dao.connect();
              const id = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
              if (!id) throw new Error("Trezu returned no DAO account");
              await client.treasury.link({ accountId: id });
              await queryClient.invalidateQueries();
              return "";
            })
          }
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
      <ActionError error={link.error} />
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
  const fund = useMessage();
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
          Connected as {short(signer.connected)}, not {short(treasury.accountId)}.
        </p>
      )}
      {fund.message && <p className="text-sm text-success-muted-foreground">{fund.message}</p>}
      <ActionError error={fund.error} />
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
        <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(recipient)}>
          <Copy size={16} /> Copy
        </Button>
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

/** Sends one transfer and reports it the way the policy answered: settled, or refused. */
function usePayout() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.pay>>>();
  const run = useMessage();
  return {
    result,
    ...run,
    pay: (request: Parameters<typeof client.pay>[0]) =>
      run.attempt(async () => {
        setResult(undefined);
        setResult(await client.pay(request));
        await queryClient.invalidateQueries();
        return "";
      }),
  };
}

function PayoutResult({ result }: { result?: Awaited<ReturnType<typeof client.pay>> }) {
  if (!result) return null;
  return result.outcome === "refused" ? (
    <Badge tone="warning">
      Refused · <span className="font-mono">{result.code}</span>
    </Badge>
  ) : result.status === "PENDING_APPROVAL" ? (
    <Link to="/policy">
      <Badge tone="info">Waiting for the owner's approval · approve under Policy</Badge>
    </Link>
  ) : (
    <Badge tone={statusTone(result.status)}>
      {result.status.toLowerCase()}
      {result.failureCode ? ` · ${result.failureCode}` : ""}
    </Badge>
  );
}

function AssetAmount({
  book,
  asset,
  setAsset,
  value,
  setValue,
}: {
  book: Overview["book"];
  asset: string;
  setAsset: (asset: string) => void;
  value: string;
  setValue: (value: string) => void;
}) {
  return (
    <>
      <input className={`${input} w-36`} inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)} />
      <select className={`${input} pr-8`} value={asset} onChange={(e) => setAsset(e.target.value)}>
        {book.map((h) => (
          <option key={h.asset} value={h.asset}>
            {h.symbol}
          </option>
        ))}
      </select>
    </>
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
      <h3 className="text-lg font-medium">Return funds</h3>
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
          <ActionError error={payout.error} />
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
          <ActionError error={destinations.action.error} />
        </>
      )}
    </div>
  );
}

/** A deposit address for NEAR-native USDC; anyone can fund the account, no signature needed. */
function Deposit() {
  const [deposit, setDeposit] = useState<Awaited<ReturnType<typeof client.deposit>>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function request() {
    setLoading(true);
    setError(undefined);
    try {
      setDeposit(await client.deposit());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Section title="Fund the account" description="The book is empty. Send USDC on NEAR to a one-time deposit address.">
      <Card>
        {deposit ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground">Deposit address</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3">{deposit.address}</code>
                <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(deposit.address)}>
                  <Copy size={16} /> Copy
                </Button>
              </div>
            </div>
            {deposit.memo && (
              <p>
                Memo <code>{deposit.memo}</code> (required)
              </p>
            )}
            <p className="text-muted-foreground">
              {deposit.minAmount && `At least ${Number(deposit.minAmount) / 1e6} USDC. `}
              {deposit.expiresAt && `Expires ${ago(deposit.expiresAt)}. `}
              The book updates once it lands.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm text-muted-foreground">Incoming funds need no grant and no owner signature.</p>
            <ActionError error={error} />
            <Button disabled={loading} onClick={request}>
              {loading && <Spinner />} Get a deposit address
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
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <label className="flex items-center gap-2 text-muted-foreground">
      <input
        type="checkbox"
        checked={treasury.confidential}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          try {
            await client.treasury.setConfidential({ confidential: e.target.checked });
            await queryClient.invalidateQueries({ queryKey: ["treasury"] });
          } finally {
            setBusy(false);
          }
        }}
      />
      <LockKey size={14} /> Confidential in Trezu
    </label>
  );
}

export function TreasurySection() {
  const { treasury, data, setup } = useAgent();
  const queryClient = useQueryClient();
  const empty = data.book.every((h) => h.usd === 0);
  return (
    <>
    <Section
      title="Treasury"
      description="The account this agent works for: any NEAR account, or a DAO that votes on funding and payees."
      action={
        treasury && (
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await client.treasury.unlink();
              await queryClient.invalidateQueries();
            }}
          >
            Unlink
          </Button>
        )
      }
    >
      {!treasury ? (
        <LinkTreasury />
      ) : (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-lg">{treasury.accountId}</span>
              <span className="text-sm text-muted-foreground">
                {treasury.balances.near} NEAR · {Number(treasury.balances.usdc) / 1e6} USDC in the account
              </span>
            </div>
            {treasury.dao ? (
              <div className="flex flex-col items-end gap-1 text-sm">
                <Badge tone="info">
                  <UsersThree size={12} weight="bold" /> DAO · {treasury.dao.members.length} member
                  {treasury.dao.members.length === 1 ? "" : "s"}
                </Badge>
                <span className="text-muted-foreground">
                  {treasury.dao.approvers.map((a) => `${a.role}: ${a.threshold}`).join(" · ")}
                </span>
                <ConfidentialSetting treasury={treasury} />
              </div>
            ) : (
              <Badge>NEAR account</Badge>
            )}
          </div>
          <div className="grid grid-cols-1 gap-8 border-t pt-6 lg:grid-cols-2">
            {treasury.dao && treasury.confidential && setup.wallet ? (
              <ConfidentialFund treasury={treasury} wallet={setup.wallet} />
            ) : (
              <Fund treasury={treasury} />
            )}
            <Return treasury={treasury} data={data} setup={setup} />
          </div>
        </Card>
      )}
    </Section>
    {!treasury && empty && <Deposit />}
    </>
  );
}

/**
 * The agreement: the payees the agent may pay. The owner signs each into the policy; for a DAO,
 * payees its members already voted to pay are offered first. Anyone else is refused at the API.
 */
export function PayeesSection() {
  const { treasury, data, setup } = useAgent();
  const destinations = useDestinations(data, setup);
  const payees = destinations.current.filter((d) => d.address !== treasury?.accountId);
  const candidates = (treasury?.payees ?? []).filter((c) => !destinations.current.some((d) => d.address === c.address));
  const [newPayee, setNewPayee] = useState("");
  const [recipient, setRecipient] = useState("");
  const [asset, setAsset] = useState(data.book[0]?.asset ?? "");
  const [value, setValue] = useState("");
  const payout = usePayout();
  const holding = data.book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;
  const agreed = payees.find((p) => p.address === recipient.trim());
  const editable = !destinations.action.busy && !destinations.blocked;

  return (
    <Section
      title="Payees"
      description="Who the agent may pay. A payee outside this agreement, or a payment over the policy's caps, is refused before anything moves."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="text-lg font-medium">Agreement</h3>
          {payees.length === 0 && <p className="text-sm text-muted-foreground">No payees yet.</p>}
          <ul className="flex flex-col gap-2">
            {payees.map((p) => (
              <li key={p.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono" title={p.address}>
                  {short(p.address)}
                </span>
                <span className="flex items-center gap-2">
                  {p.confidential && <Badge tone="info">confidential</Badge>}
                  <Button variant="ghost" size="sm" disabled={!editable} onClick={() => destinations.remove(p.address)} aria-label={`Remove ${p.address}`}>
                    <X size={14} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          {candidates.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-4">
              <span className="text-sm text-muted-foreground">Approved by {treasury?.accountId} in past proposals</span>
              {candidates.map((c) => (
                <div key={c.address} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-mono">{short(c.address)}</span>{" "}
                    <span className="text-muted-foreground">· #{c.proposalId}</span>
                  </span>
                  <Button variant="outline" size="sm" disabled={!editable} onClick={() => destinations.add({ address: c.address, confidential: true })}>
                    <Plus size={14} /> Add
                  </Button>
                </div>
              ))}
            </div>
          )}

          <form
            className="flex gap-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (newPayee.trim()) destinations.add({ address: newPayee.trim(), confidential: Boolean(treasury?.dao) });
            }}
          >
            <input className={`${input} flex-1`} placeholder="Payee's NEAR account" value={newPayee} onChange={(e) => setNewPayee(e.target.value)} />
            <Button type="submit" variant="outline" disabled={!editable || !newPayee.trim()}>
              <Plus size={16} /> Add
            </Button>
          </form>
          <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          <ActionError error={destinations.action.error} />
        </Card>

        <Card>
          <h3 className="text-lg font-medium">Pay</h3>
          <p className="text-sm text-muted-foreground">
            The agent sends under its grant. Try someone outside the agreement to watch the policy refuse.
          </p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (amount && recipient.trim())
                payout.pay({ recipient: recipient.trim(), asset, amount, confidential: agreed?.confidential ?? true });
            }}
          >
            <input
              className={input}
              list="payees"
              placeholder="Recipient's NEAR account"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <datalist id="payees">
              {payees.map((p) => (
                <option key={p.address} value={p.address} />
              ))}
            </datalist>
            <div className="flex flex-wrap items-center gap-3">
              <AssetAmount book={data.book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} />
              <Button type="submit" disabled={payout.busy || !amount || !recipient.trim()}>
                {payout.busy ? <Spinner /> : <PaperPlaneTilt size={18} />} Pay
              </Button>
              <PayoutResult result={payout.result} />
            </div>
            {recipient.trim() && !agreed && (
              <span className="text-sm text-warning-muted-foreground">Not in the agreement: expect a refusal.</span>
            )}
          </form>
          <ActionError error={payout.error} />
        </Card>
      </div>
    </Section>
  );
}
