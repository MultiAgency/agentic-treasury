/** Additive supplier HTTP capabilities; no capability grants authority. */
export const supplierContract = {
  version: 1,
  product: "invoices",
  capabilities: ["supplier-session-v1", "supplier-invoices-v1", "supplier-work-orders-v1", "supplier-work-order-requests-v1", "supplier-compensation-v2"],
} as const;
export function compatibleSupplierFrontend(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const release = value as Record<string, unknown>;
  return release.version === 1 && release.product === "invoices" && Array.isArray(release.required) &&
    release.required.length > 0 && release.required.every(capability => typeof capability === "string" && (supplierContract.capabilities as readonly string[]).includes(capability));
}
