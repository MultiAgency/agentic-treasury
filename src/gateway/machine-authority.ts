import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";
import { daoPolicy } from "../chain.js";
import type { Router } from "../router.js";
import { accessOf, type Access } from "./roles.js";
type Agent = { name: string; owner: string; port: number };
const identity = z.object({ agentId: z.string().min(1), owner: z.object({ type: z.literal("near"), account_id: z.string().min(1) }) });

/** Machine delegation requires a live, established wallet owner. No cached/fallback evidence or DAO delegation. */
export async function resolveMachineAccess(account: string, agent: Agent): Promise<{ access: Access; agentId: string } | null> {
  if (account !== agent.owner) return null;
  try {
    if (await daoPolicy(agent.owner)) return null;
    const link = new RPCLink({ origin: `http://127.0.0.1:${agent.port}`, url: "/rpc", headers: { "x-gateway": "owner-check" } });
    const client: RouterClient<Router> = createORPCClient(link);
    const parsed = identity.safeParse(await client.ownerIdentity(undefined, { signal: AbortSignal.timeout(3_000) }));
    if (!parsed.success || !parsed.data.agentId || !parsed.data.owner ||
      parsed.data.owner.type !== "near" || parsed.data.owner.account_id !== account) return null;
    return { access: accessOf(account, { account, policy: null, signer: account })!, agentId: parsed.data.agentId };
  } catch { return null; }
}


/** Restricting existing access needs current DAO management rights, but no product/provider reads. */
export async function resolveMachineManagement(account: string, agent: Agent): Promise<{ dao: boolean } | null> {
  if (account === agent.owner) return { dao: false };
  try {
    const policy = await daoPolicy(agent.owner);
    return policy && accessOf(account, { account: agent.owner, signer: agent.owner, policy })?.canManage
      ? { dao: true } : null;
  } catch { return null; }
}
