/** Additive payee HTTP capabilities; no capability grants authority. */
export const payeeContract = {
  version: 1,
  product: "invoices",
  capabilities: ["supplier-session-v1", "supplier-invoices-v1", "supplier-work-orders-v1", "supplier-work-order-requests-v1", "supplier-compensation-v2", "supplier-agent-connections-v1"],
} as const;
/** A release manifest is compatible when its version and product match and every required capability is provided. */
export function compatibleRelease(value: unknown, product: string, provided: readonly string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const release = value as Record<string, unknown>;
  return release.version === 1 && release.product === product && Array.isArray(release.required) &&
    release.required.length > 0 && release.required.every(capability => typeof capability === "string" && provided.includes(capability));
}
export const compatiblePayeeFrontend = (value: unknown) => compatibleRelease(value, payeeContract.product, payeeContract.capabilities);
