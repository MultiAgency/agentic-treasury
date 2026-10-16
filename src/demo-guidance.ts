import { EventSchemas } from "@ag-ui/core/schemas";
import { z } from "zod";

/** Observational UI protocol only. No tool calls, authority, inferred settlement or run completion. */
const state = z.strictObject({
  version: z.literal(1), source: z.literal("ui-observation"),
  agentId: z.string().min(1), workflow: z.enum(["treasury", "payables", "invoices"]),
  stage: z.enum(["check", "review", "follow"]),
  blocker: z.string().min(1).nullable(),
  record: z.strictObject({ kind: z.enum(["plan", "payment"]), id: z.string().min(1) }).nullable(),
});
export const GuidanceEventSchema = z.strictObject({
  type: z.literal("CUSTOM"), name: z.literal("multiagency.walkthrough"), value: state,
}).superRefine((event, ctx) => {
  if (!EventSchemas.safeParse(event).success) ctx.addIssue({ code: "custom", message: "Invalid AG-UI event" });
  if (event.value.record && (event.value.workflow === "invoices" || event.value.record.kind !== (event.value.workflow === "treasury" ? "plan" : "payment"))) ctx.addIssue({ code: "custom", message: "Record does not belong to this workflow" });
  if ((event.value.stage === "follow") !== Boolean(event.value.record)) ctx.addIssue({ code: "custom", message: "Following requires an exact selected record" });
});
export function guidanceEvent(input: {
  agentId: string; workflow: z.infer<typeof state>["workflow"]; blocker?: string;
  record?: { kind: "plan" | "payment"; id: string };
}) {
  return GuidanceEventSchema.parse({ type: "CUSTOM", name: "multiagency.walkthrough", value: {
    version: 1, source: "ui-observation", agentId: input.agentId, workflow: input.workflow,
    stage: input.record ? "follow" : input.blocker ? "check" : "review",
    blocker: input.blocker ?? null, record: input.record ?? null,
  } });
}
