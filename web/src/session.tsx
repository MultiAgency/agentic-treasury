import { SignIn as SignInIcon, SignOut } from "@phosphor-icons/react";
import { useState } from "react";
import { BASE, errorMessage, gw } from "./lib";
import { Button, Card, Spinner } from "./ui";
import { useViewer, type Viewer } from "./viewer";
import { signChallenge, signOutMember } from "./wallet";

export type Gateway = { dao: string; agents: string[]; invoices: string | null; viewer: Viewer | null };

/** The gateway's view of this visitor, or null when the page is served by a local agent server. */
export async function loadGateway(): Promise<Gateway | null> {
  const response = await fetch("/gw/me").catch(() => null);
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return null;
  return (await response.json()) as Gateway;
}

export async function signOut() {
  await fetch("/gw/logout", { method: "POST" });
  await signOutMember().catch(() => {});
  location.assign("/");
}

export function SignIn({ dao }: { dao: string }) {
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
      location.assign(BASE || "/");
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
          Sign in with a NEAR wallet that belongs to a member of {dao} to see the treasury. You sign a message, not a transaction:
          nothing is sent on chain.
        </p>
      </div>
      {error && <p className="text-sm text-destructive-muted-foreground">{error}</p>}
      <Button className="w-fit" onClick={signIn} disabled={busy}>
        {busy ? <Spinner /> : <SignInIcon size={16} />} Sign in with NEAR
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
