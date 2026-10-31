import { Wallet as WalletIcon } from "@phosphor-icons/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button, Spinner, short } from "../shared/ui";
import { signOut } from "./session";
import { useViewer } from "./viewer";
import { connect, disconnect, useWallet } from "./wallet";

/** The connected wallet, and disconnecting it, which signs the member out of this host as well. */
export function WalletButton() {
  const wallet = useWallet();
  const viewer = useViewer();
  if (wallet.status === "connected" && wallet.accountId) return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label={`Wallet: ${wallet.accountId}`}><WalletIcon data-icon="inline-start" aria-hidden="true" />{short(wallet.accountId)}</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuGroup>
      <DropdownMenuItem onSelect={() => { void (viewer ? signOut() : disconnect()); }}>Disconnect</DropdownMenuItem>
    </DropdownMenuGroup></DropdownMenuContent>
  </DropdownMenu>;
  return <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-3" disabled={wallet.status === "connecting"} onClick={() => connect().catch(() => {})}>
    {wallet.status === "connecting" ? <Spinner /> : <WalletIcon size={16} />}
    Connect wallet
  </Button>;
}
