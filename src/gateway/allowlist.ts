import { OWNER_PROPOSALS, READS } from "../contract/permissions.js";
export { mayCall } from "../contract/permissions.js";

/** Preserve the historical intervention classification, including invoice review reads. */
export const isIntervention = (path: string) => path === "invoices" || (!READS.has(path) && !OWNER_PROPOSALS.has(path));
