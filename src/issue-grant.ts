import { ENV_FILE } from "./env.js";
import { type GrantPurpose, grantRequest, promoteGrantToken, stageGrantToken } from "./intents.js";
import { runOwnerIntent } from "./owner.js";

// `pnpm issue-grant [treasury|payout|intake] [suffix]`; the purpose defaults to what the policy allows.
const [purpose, suffix] = process.argv.slice(2) as [GrantPurpose | undefined, string | undefined];
if (purpose && !["treasury", "payout", "intake"].includes(purpose)) throw new Error(`Unknown grant purpose "${purpose}"`);
const { token, request } = await grantRequest({ purpose, suffix });

stageGrantToken(token);

const status = await runOwnerIntent(request);
if (status.status !== "SUCCESS") throw new Error(status.failure_code ?? `grant_issue ${status.status}`);
promoteGrantToken(token);
console.log(`Grant issued; token saved to ${ENV_FILE} as AGENT_GRANT_TOKEN`);
