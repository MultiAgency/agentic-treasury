import { agentId } from "./agent.js";
import { api } from "./api.js";
import { ownerRequests } from "./intents.js";
import { runOwnerIntent } from "./owner.js";

const id = agentId();

// The API refuses to archive a live account (pause_before_archive): freeze it first.
const { policy } = await api.getPolicy(id);
if (!policy?.frozen) {
  const frozen = await runOwnerIntent(ownerRequests.agent_freeze());
  if (frozen.status !== "SUCCESS") throw new Error(frozen.failure_code ?? `agent_freeze ${frozen.status}`);
}

// Reversible: hides the account and stops it being usable; the wallet and history stay.
const status = await runOwnerIntent({ type: "agent_archive", agent_id: id });
if (status.status !== "SUCCESS") throw new Error(status.failure_code ?? `agent_archive ${status.status}`);
console.log(`Archived ${id}`);
