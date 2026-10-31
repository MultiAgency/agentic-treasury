import { useSyncExternalStore } from "react";
import { onDenial, type Denial } from "../platform.ts";

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
/** The denials in force now; `useAccessState` is the same, for components. */
export const accessState = () => state;
export const useAccessState = () => useSyncExternalStore(listener => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}, accessState);
export const deniedAt = (snapshot: AccessState, agent: string | null) => snapshot.session ?? (agent ? snapshot.agents[agent] : undefined);

/**
 * A successful session read is the authority again: it lifts the denials it answers. Signed out, nothing stays latched;
 * signed in (as the same account or another one), the session denial goes, and so does every agent denial the new
 * access map grants. An agent it doesn't grant stays hidden.
 */
export function settleDenials(viewer: { access: Readonly<Record<string, unknown>> } | null) {
  const agents = viewer ? Object.fromEntries(Object.entries(state.agents).filter(([name]) => !(name in viewer.access))) : {};
  if (!state.session && Object.keys(agents).length === Object.keys(state.agents).length) return;
  state = { agents };
  for (const listener of listeners) listener();
}

/** Reloading checks the session and starts fresh caches; no owner action or payment is retried. */
export const recheckAccess = () => location.reload();
