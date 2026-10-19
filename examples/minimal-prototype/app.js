// A new prototype on a Proto host: presentation only. Every call is same-origin through the gateway;
// this page holds no credentials, grants or callback channel, and the wallet signs every owner action.
import { NearConnector } from "https://cdn.jsdelivr.net/npm/@fastnear/near-connect@0.14.1/+esm";

const AGENT = location.pathname.match(/^\/a\/([a-z0-9-]+)/)?.[1] ?? "payout";
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true },
  manifest: "https://cdn.jsdelivr.net/gh/fastnear/near-connect@d277b41263a8ea0a6892236b22824d46c2c3c377/repository/manifest.json" });
const $ = id => document.getElementById(id);
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function json(path, init) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? body.json?.message ?? `HTTP ${response.status}`), { status: response.status });
  return body;
}
/** Scoped agent RPC: the gateway checks the session, the agent and the procedure on every call. */
const rpc = async (procedure, input) => (await json(`/a/${AGENT}/rpc/${procedure}`, { method: "POST", body: JSON.stringify({ json: input }) })).json;

async function signIn() {
  await connector.connect();
  const { wallet } = await connector.getConnectedWallet();
  const challenge = await json("/gw/challenge");
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
  const session = await json("/gw/session", { method: "POST", body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) });
  $("account").textContent = `Signed in as ${session.account}.`;
  await read();
}

async function read() {
  try {
    const { policy, notInForce } = await rpc("overview");
    $("agent").textContent = policy.policy?.frozen ? "Paused by its owner." : notInForce ? `Not in force: ${notInForce}` : "Active.";
    $("refresh").disabled = false;
    $("freeze").disabled = Boolean(policy.policy?.frozen);
    $("unfreeze").disabled = !policy.policy?.frozen;
  } catch (error) {
    $("agent").textContent = error.status === 401 ? "Sign in to read." : error.status === 403 ? "This account may not read this agent." : "The agent could not be read. Try again.";
  }
}

/** Prepare once, show what will be signed, sign in the wallet, submit once, then follow the same record. */
async function ownerAction(type) {
  for (const id of ["freeze", "unfreeze"]) $(id).disabled = true;
  try {
    const prepared = await rpc("owner/prepare", { action: { type }, signer: "wallet" });
    $("action").textContent = `Approve in your wallet: ${prepared.preview.summary}.`;
    const { wallet } = await connector.getConnectedWallet();
    const payload = prepared.intent.payload;
    const signed = await wallet.signMessage({ ...payload, nonce: fromBase64(payload.nonce) });
    await rpc("owner/submit", { correlationId: prepared.correlationId, signedData: { ...prepared.intent, public_key: signed.publicKey, signature: signed.signature } });
    for (let i = 0; i < 40; i++) {
      const outcome = await rpc("owner/status", { correlationId: prepared.correlationId });
      if (outcome.status === "SUCCESS") { $("action").textContent = "Signed and recorded."; break; }
      if (outcome.status === "FAILED" || outcome.stage === "expired") { $("action").textContent = "Not applied. Review the recorded action before trying again."; break; }
      $("action").textContent = "Signature submitted; waiting for the recorded outcome. Do not sign again.";
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    $("action").textContent = error.status === 403 ? "This account may not take this action." : "The action did not complete. Read the agent before trying again.";
  }
  await read();
}

$("signin").onclick = () => signIn().catch(() => { $("account").textContent = "Sign-in failed. Try again."; });
$("refresh").onclick = read;
$("freeze").onclick = () => ownerAction("agent_freeze");
$("unfreeze").onclick = () => ownerAction("agent_unfreeze");
