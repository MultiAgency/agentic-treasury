import type { Gateway } from "../../app/session";
import { walkthroughs, type WalkthroughId } from "./catalog";

/**
 * The full app's origin for a workflow, on this deployment: the gateway names the host serving that area, so a local
 * stack links locally. The hosted URL is used only when no host is configured for the area.
 */
export function appOrigin(workflow: WalkthroughId, gateway: Gateway | null | undefined) {
  const item = walkthroughs.find(entry => entry.id === workflow)!;
  const host = gateway?.apps?.[item.area];
  return host ? `${location.protocol}//${host}` : item.app;
}
