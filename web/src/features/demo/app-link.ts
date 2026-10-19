import { useGateway } from "../../app/gateway-context";
import { BASE } from "../../shared/client";
import { appOrigin } from "./app-origin";
import type { WalkthroughId } from "./catalog";

/** A screen of this agent in its full app (on this deployment when the gateway names the app's host). */
export function useAppHref(workflow: WalkthroughId) {
  const origin = appOrigin(workflow, useGateway());
  return (path: string, hash?: string) => `${origin}${BASE}${path}${hash ? `#${hash}` : ""}`;
}
