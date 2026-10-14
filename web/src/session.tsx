import { SignIn as SignInIcon, SignOut } from "@phosphor-icons/react";
import { useState } from "react";
import { errorMessage, gw } from "./lib";
import { Button, Card, ErrorBox, Spinner } from "./ui";
import { type GatewayViewer, useViewer } from "./viewer";
import { signChallenge, signOutMember } from "./wallet";

/** An agent behind the gateway and the account it answers to; `dao` when that account is a DAO, signing by proposal. */
export type GatewayAgent = { name: string; owner: string; dao: boolean };
export type Gateway = { agents: GatewayAgent[]; invoices: string | null; viewer: GatewayViewer | null };

/** The agents' owners, each once, in order. Signed out, the gateway lists only DAOs' agents, so these are DAOs. */
export const ownersOf = (agents: GatewayAgent[]) => [...new Set(agents.map((a) => a.owner))];

/**
 * The gateway's view of this visitor, or null when the page is served by a local agent server, which
 * answers /gw/me with the page itself. An error from a gateway, or from the proxy in front of it,
 * throws: a hosted page must never fall back to the local view, which assumes the operator on loopback.
 */
export async function loadGateway(): Promise<Gateway | null> {
  const response = await fetch("/gw/me");
  if (!response.headers.get("content-type")?.includes("application/json")) {
    if (response.ok) return null;
    // A proxy's error page in front of a gateway that is down, not a local server.
    throw new Error(`The dashboard answered ${response.status}.`);
  }
  const body = (await response.json()) as Gateway & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The dashboard answered ${response.status}`);
  return body;
}

export async function signOut() {
  await fetch("/gw/logout", { method: "POST" });
  await signOutMember().catch(() => {});
  location.assign("/");
}

export function SignIn({ daos }: { daos: string[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const challenge = await gw<{ message: string; recipient: string; nonce: string }>("/gw/challenge");
      await gw("/gw/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await signChallenge(challenge)),
      });
      // Back to the page they asked for: signed out, any address shows the public page in its place.
      // A reload, not assign: assigning a URL with a hash is a fragment navigation and loads nothing.
      location.reload();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Members</h2>
        <p className="text-sm text-muted-foreground">
          Sign in with the NEAR wallet that owns an agent here{daos.length > 0 && `, or as a member of ${daos.join(" or ")}`}. You sign
          a message, not a transaction: nothing is sent on chain.
        </p>
      </div>
      <ErrorBox error={error} />
      <span role="status" className="sr-only">{busy ? "Complete sign-in in your NEAR wallet." : ""}</span>
      <Button className="w-fit" onClick={signIn} disabled={busy}>
        {busy ? <Spinner /> : <SignInIcon size={16} />} {busy ? "Signing in…" : "Sign in with NEAR"}
      </Button>
    </Card>
  );
}

export function ViewerBadge() {
  const viewer = useViewer();
  if (!viewer) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="truncate" title={viewer.account}>
          {viewer.account}
        </span>
        <span className="text-muted-foreground">{viewer.role === "operator" ? "Operator" : "Member · read and propose"}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out">
        <SignOut size={16} />
      </Button>
    </div>
  );
}
