import { existsSync } from "node:fs";
import { join } from "node:path";

/** Consent is shared infrastructure even on a host with an independent product frontend. */
export function accessFrontend(productDist: string | undefined, sharedDist: string, pathname: string,
  exists: (file: string) => boolean = existsSync): string {
  if (!productDist || /^\/a\/[a-z0-9-]+\/access\/?$/.test(pathname)) return sharedDist;
  // Build assets use content-hashed names. Keep product assets first, and make the shared consent
  // app's chunks/fonts available on the same host without changing sessions or product routes.
  if (pathname.startsWith("/static/") && !exists(join(productDist, pathname))) return sharedDist;
  return productDist;
}
