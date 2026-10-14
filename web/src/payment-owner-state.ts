import type { client } from "./lib";

type OwnerActions = Awaited<ReturnType<typeof client.owner.actions>>;

/** Submitted actions remain in recovery after expiry; approval and payment outcomes are separate. */
export function paymentOwnerState(actions: OwnerActions, correlationId: string) {
  const records = actions.filter(a => a.payment?.correlationId === correlationId);
  const recovering = records.find(a => a.stage === "submitted" || a.stage === "prepared");
  const succeeded = records.find(a => a.ownerSucceeded);
  return { records, recovering, succeeded,
    approved: succeeded?.payment?.verdict === "approve",
    rejected: succeeded?.payment?.verdict === "reject" };
}
