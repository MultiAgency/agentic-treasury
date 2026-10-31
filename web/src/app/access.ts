import { useSyncExternalStore } from "react";
import { onDenial, type Denial } from "../platform";

type AccessState = { session?: Denial; agents: Readonly<Record<string, Denial>> };
let state: AccessState = { agents: {} };
const listeners = new Set<() => void>();
const handlers = new Set<(denial: Denial) => void>();

// An explicit gateway denial hides private observations before its permission refresh returns. A procedure denial
// latches nothing: it only revokes the controls that relied on it (see main.tsx).
onDenial(denial => {
  if (denial.scope === "session") {
    if (state.session) return;
    state = { ...state, session: denial };
  } else if (denial.scope === "agent" && denial.agent) {
    if (state.agents[denial.agent]) return;
    state = { ...state, agents: { ...state.agents, [denial.agent]: denial } };
  }
  for (const listener of listeners) listener();
  for (const handler of handlers) handler(denial);
});

export const onAccessDenial = (handler: (denial: Denial) => void) => {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
};
export const useAccessState = () => useSyncExternalStore(listener => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}, () => state);
export const deniedAt = (snapshot: AccessState, agent: string | null) => snapshot.session ?? (agent ? snapshot.agents[agent] : undefined);

/** Reloading checks the session and starts fresh caches; no owner action or payment is retried. */
export const recheckAccess = () => location.reload();
