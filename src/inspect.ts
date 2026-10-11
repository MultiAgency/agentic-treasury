import { agentId } from "./agent.js";
import { api } from "./api.js";

const id = agentId();

const [policy, publicBalances, confidentialBalances, grants] = await Promise.all([
  api.getPolicy(id),
  api.getBalances(id, { source: "public" }),
  api.getBalances(id, { source: "confidential" }),
  api.listGrants(id),
]);
console.dir({ policy, publicBalances, confidentialBalances, grants }, { depth: null });
