import { ORPCError } from "@orpc/server";
function verifiedActor(actor?: string) { if (!actor) throw new ORPCError("UNAUTHORIZED", { message: "Verified owner session required" }); return actor; }
import { os } from "./base.js";
import { agreementCommand, reviewCommand, paymentPreparation } from "../compensation-contract.js";
import { compensationSend, ownerCompensation } from "../compensation.js";
export const compensationRoutes = { compensation: {
  list: os.handler(({ context }) => ownerCompensation(verifiedActor(context.actor), { type: "list" })),
  agreement: os.input(agreementCommand).handler(({ input, context }) => ownerCompensation(verifiedActor(context.actor), { type: "agreement", command: input })),
  review: os.input(reviewCommand).handler(({ input, context }) => ownerCompensation(verifiedActor(context.actor), { type: "review", command: input })),
  prepare: os.input(paymentPreparation).handler(({ input, context }) => ownerCompensation(verifiedActor(context.actor), input)),
  send: os.input(compensationSend).handler(({ input, context }) => ownerCompensation(verifiedActor(context.actor), input)),
} };
