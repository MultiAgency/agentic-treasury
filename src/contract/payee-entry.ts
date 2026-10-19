/**
 * `@multiagency/sdk/payee`: the payee side of the contract. It depends on zod alone (no oRPC or
 * AG-UI), so an app that never calls owner procedures installs none of the owner peers.
 */
export { contractPackage } from "./package-version.js";
export { payeeContract, compatiblePayeeFrontend, compatibleRelease } from "../payee-contract.js";
export * from "../compensation-contract.js";
export * from "./payee.js";
export * from "./client.js";
export * from "./agent-connection.js";
