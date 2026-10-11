import { api } from "./api.js";
import { ENV_FILE, saveEnv } from "./env.js";
import { ownerRequests } from "./intents.js";
import { owner, runOwnerIntent } from "./owner.js";

const status = await runOwnerIntent(ownerRequests.agent_create(owner));
if (status.status !== "SUCCESS" || !status.agent_id)
  throw new Error(status.failure_code ?? `agent_create ${status.status}`);

saveEnv({ AGENT_ID: status.agent_id });
console.log(await api.getAgent(status.agent_id));
console.log(`\nAgent created; saved to ${ENV_FILE} as AGENT_ID`);
