import { agentId } from "./agent.js";
import { api } from "./api.js";
import { runOwnerIntent } from "./owner.js";
import { treasuryPolicy } from "./policy.js";

const id = agentId();

const current = await api.getPolicy(id);
if (current.status !== "APPLIED" || current.revision === null)
  throw new Error(`Current policy is ${current.status}; wait until it is APPLIED`);

// What the owner is about to sign, against what is in force now.
const flatten = (value: unknown, path = ""): [string, string][] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, inner]) => flatten(inner, path ? `${path}.${key}` : key))
    : [[path, JSON.stringify(value)]];
const [live, next] = [new Map(flatten(current.policy)), new Map(flatten(treasuryPolicy))];
const changes = [...new Set([...live.keys(), ...next.keys()])]
  .filter((key) => live.get(key) !== next.get(key))
  .map((key) => `  ${key}: ${live.get(key) ?? "(unset)"} → ${next.get(key) ?? "(unset)"}`);
if (changes.length === 0) {
  console.log(`Revision ${current.revision} already matches; nothing to sign.`);
  process.exit(0);
}
console.log(`Changes from revision ${current.revision}:\n${changes.join("\n")}\n`);
// `--diff` only shows what would change; without it the owner is asked to sign.
if (process.argv.includes("--diff")) process.exit(0);

const status = await runOwnerIntent({
  type: "policy_update",
  agent_id: id,
  expected_revision: current.revision,
  policy: treasuryPolicy,
});
if (status.status !== "SUCCESS") throw new Error(status.failure_code ?? `policy_update ${status.status}`);

// Executions fail with policy_not_ready until the provider has the new policy.
while (true) {
  const view = await api.getPolicy(id);
  if (view.status === "APPLIED" && view.provider_policy_synced) {
    console.log(`Policy revision ${view.revision} in force`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
