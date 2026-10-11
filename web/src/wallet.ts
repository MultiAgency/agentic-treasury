import type { Intent } from "@near-intents-agent-api/sdk";
import { type DataStorage, NearConnector } from "@fastnear/near-connect";
import { useSyncExternalStore } from "react";

export type WalletState = { status: "idle" | "connecting" | "connected"; accountId?: string; publicKey?: string };
export type Transaction = {
  receiverId: string;
  actions: (
    | { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }
    | { type: "Transfer"; params: { deposit: string } }
  )[];
};

/**
 * One wallet connection as an external store: its account, connect and disconnect, and sending
 * a transaction as that account.
 */
function walletSession(connector: NearConnector, walletId?: string) {
  let state: WalletState = { status: "idle" };
  const listeners = new Set<() => void>();
  const update = (next: WalletState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const sync = async () => {
    try {
      const [account] = (await connector.getConnectedWallet()).accounts;
      update(account ? { status: "connected", ...account } : { status: "idle" });
    } catch {
      update({ status: "idle" });
    }
  };
  connector.on("wallet:signIn", sync);
  connector.on("wallet:signOut", () => update({ status: "idle" }));
  sync();

  return {
    connector,
    update,
    use: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => state,
      ),
    async connect() {
      update({ status: "connecting" });
      try {
        await connector.connect(walletId ? { walletId } : undefined);
      } finally {
        await sync();
      }
    },
    async disconnect() {
      await connector.disconnect();
      update({ status: "idle" });
    },
    /** Sends `transaction` as the connected account. Through Trezu that files it as a DAO proposal. */
    async send(transaction: Transaction) {
      const { wallet, accounts } = await connector.getConnectedWallet();
      const signerId = accounts[0]?.accountId;
      if (!signerId) throw new Error("Connect a wallet first");
      return wallet.signAndSendTransaction({ signerId, ...transaction });
    },
  };
}

/**
 * The owner's wallet. Owner actions need both NEAR signatures (NEP-413 messages for grants,
 * NEP-366 delegate actions for creating and freezing), so only wallets offering both are listed.
 */
const owner = walletSession(
  new NearConnector({ network: "mainnet", features: { signMessage: true, signDelegateActions: true } }),
);

/** Keeps the DAO's session apart from the owner's in the same browser. */
const daoStorage: DataStorage = {
  get: async (key) => localStorage.getItem(`dao:${key}`),
  set: async (key, value) => localStorage.setItem(`dao:${key}`, value),
  remove: async (key) => localStorage.removeItem(`dao:${key}`),
};

/**
 * A DAO acting through Trezu, a second connection beside the owner's: it signs as the DAO by
 * filing each transaction as a proposal its members vote on. Trezu is listed in the upstream
 * near-connect registry, not FastNear's.
 */
export const dao = walletSession(
  new NearConnector({
    network: "mainnet",
    manifest: "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json",
    storage: daoStorage,
  }),
  "trezu-wallet",
);

export const useWallet = owner.use;
export const connect = () => owner.connect();
export const disconnect = () => owner.disconnect();
export const send = (transaction: Transaction) => owner.send(transaction);

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/**
 * The connected account as an agent owner. Some wallets report the key only with a signature,
 * so a missing key is read from a one-off signed message.
 */
export async function ownerWallet() {
  const { wallet, accounts } = await owner.connector.getConnectedWallet();
  const [account] = accounts;
  if (!account) throw new Error("Connect a wallet first");
  const publicKey =
    account.publicKey ??
    (
      await wallet.signMessage({
        message: "Identify my key as the owner of an Agentic Treasury agent",
        recipient: location.host,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
      })
    ).publicKey;
  owner.update({ status: "connected", accountId: account.accountId, publicKey });
  return { type: "near" as const, account_id: account.accountId, public_key: publicKey };
}

/** Signs an owner intent's payload exactly as the API generated it, by the standard it chose. */
export async function signIntent(intent: Intent): Promise<Record<string, unknown>> {
  const { wallet } = await owner.connector.getConnectedWallet();
  switch (intent.standard) {
    case "nep413": {
      const { publicKey, signature } = await wallet.signMessage({ ...intent.payload, nonce: fromBase64(intent.payload.nonce) });
      return { ...intent, public_key: publicKey, signature };
    }
    case "nep366": {
      const { signedDelegateActions } = await wallet.signDelegateActions({ delegateActions: [intent.payload] });
      const signed = signedDelegateActions[0];
      // Wallets answer in one of two transport forms; an older object form has no stable encoding.
      if (typeof signed === "string") return { ...intent, signed_delegate: signed };
      if (signed && "borshSerializedBase64" in signed) return { ...intent, signed_delegate: signed.borshSerializedBase64 };
      throw new Error("This wallet returned its signature in an older format. Try another wallet.");
    }
    default:
      throw new Error(`This dashboard signs NEAR intents only, not ${intent.standard}`);
  }
}
