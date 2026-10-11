import { agentId } from "./agent.js";
import { api } from "./api.js";
import { liveGrant } from "./intents.js";
import { runOwnerIntent } from "./owner.js";

// `pnpm revoke-grant` lists the agent's live grants; `pnpm revoke-grant <grant id>` revokes one.
// Revoking stops it at once; operations it already committed still finish.
const id = agentId();
const grantId = process.argv[2];

if (!grantId) {
  const grants = await api.listGrants(id);
  const held = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  const live = grants.filter((g) => !g.revoked_at && new Date(g.expires_at) > new Date());
  for (const g of live)
    console.log(`${g.grant_id}  ${g.label}  expires ${g.expires_at}${g.grant_id === held?.grant_id ? "  (this server's)" : ""}`);
  if (live.length === 0) console.log("No live grants.");
  else console.log("\nRevoke one: pnpm revoke-grant <grant id>");
  process.exit(0);
}

const status = await runOwnerIntent({ type: "grant_revoke", agent_id: id, grant_id: grantId });
if (status.status !== "SUCCESS") throw new Error(status.failure_code ?? `grant_revoke ${status.status}`);
console.log(`Revoked ${grantId}`);
