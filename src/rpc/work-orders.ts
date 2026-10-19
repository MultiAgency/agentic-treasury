import { z } from "zod";
import { os } from "./base.js";
import { workOrderProgress } from "../work-order-protocol.js";
import { readOutput } from "./read-output.js";
import { workOrderId } from "../work-order-store.js";
import { newWorkOrder, workOrders } from "../work-orders.js";

export const workOrderRoutes = { workOrders: {
  list: os.use(readOutput("workOrders/list")).handler(() => workOrders.list()),
  create: os.input(newWorkOrder).handler(({ input }) => workOrders.create(input)),
  // Readiness is computed here, by the same rules the server uses, so apps never copy them.
  get: os.input(z.object({ id: workOrderId })).use(readOutput("workOrders/get")).handler(async ({ input }) => {
    const snapshot = await workOrders.get(input.id);
    return { ...snapshot, progress: workOrderProgress(snapshot) };
  }),
  file: os.input(z.object({ id: workOrderId }).strict()).handler(({ input }) => workOrders.file(input.id)),
  deposit: os.input(z.object({ id: workOrderId })).handler(({ input }) => workOrders.deposit(input.id)),
  prepare: os.input(z.object({ id: workOrderId, action: z.enum(["create", "grant", "approve", "reject", "revoke"]), signer: z.enum(["wallet", "dao"]) }))
    .handler(({ input }) => workOrders.prepare(input.id, input.action, input.signer)),
  submit: os.input(z.object({ id: workOrderId, correlationId: z.string().min(1).max(200), signedData: z.record(z.string(), z.unknown()) }))
    .handler(({ input }) => workOrders.submit(input.id, input.correlationId, input.signedData)),
  status: os.input(z.object({ id: workOrderId, correlationId: z.string().min(1).max(200) })).use(readOutput("workOrders/status"))
    .handler(({ input }) => workOrders.status(input.id, input.correlationId)),
} };
