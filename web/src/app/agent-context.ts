import { createContext, useContext } from "react";
import type { Overview } from "../shared/lib";
import type { Setup } from "../features/owner/owner";

type Agent = { setup: Setup; data: Overview };
export const AgentContext = createContext<Agent | null>(null);
export const useOptionalAgent = () => useContext(AgentContext);
export function useAgent() {
  const agent = useOptionalAgent();
  if (!agent) throw new Error("Agent observations unavailable");
  return agent;
}
