import { z } from "zod";
import { EventSchemas } from "@ag-ui/core/schemas";

export const simulationStages = ["agreement", "invoice", "approval", "submitted", "settled", "rejected", "unresolved"] as const;
export type SimulationStage = typeof simulationStages[number];
export const GuideInput = z.strictObject({
  mode: z.enum(["rehearsal", "live"]), stage: z.enum([...simulationStages, "live"]),
  role: z.enum(["executor", "approve-only", "unknown"]), question: z.string().trim().min(1).max(800),
}).superRefine((input, ctx) => {
  if ((input.mode === "live") !== (input.stage === "live")) ctx.addIssue({ code: "custom", message: "Live mode requires the live stage" });
});
export type GuideRequest = z.infer<typeof GuideInput>;
export const GuideScene = z.strictObject({
  title: z.string().trim().min(1).max(100), narration: z.string().trim().min(1).max(700),
  layout: z.enum(["focus", "compare"]),
  panels: z.array(z.enum(["agreement", "invoice", "signature", "outcome", "roles", "policy"])).min(1).max(3),
  choices: z.array(z.enum(["next", "approve", "reject", "interrupt", "restart", "policy", "supplier", "signing", "payments", "agreements"])).max(4),
}).superRefine((scene, ctx) => {
  if (new Set(scene.panels).size !== scene.panels.length || new Set(scene.choices).size !== scene.choices.length)
    ctx.addIssue({ code: "custom", message: "Duplicate scene entries" });
});
export type Scene = z.infer<typeof GuideScene>;
export type GuideChoice = Scene["choices"][number];
export const choiceLabels: Record<GuideChoice, string> = {
  next: "Continue rehearsal", approve: "Simulate approval", reject: "Explore rejection", interrupt: "Explore unknown outcome",
  restart: "Restart rehearsal", policy: "Explain the policy", supplier: "Show contributor view", signing: "Explain this signature",
  payments: "Review real payments", agreements: "Review real agreements",
};
export function allowedChoices(input: Pick<GuideRequest, "mode" | "stage">): GuideChoice[] {
  if (input.mode === "live") return ["policy", "signing", "payments", "agreements"];
  const transitions: GuideChoice[] = input.stage === "approval" ? ["approve", "reject"] : input.stage === "submitted" ? ["next", "interrupt"]
    : input.stage === "agreement" || input.stage === "invoice" ? ["next"] : ["restart"];
  return [...transitions, "policy", "supplier", "signing"];
}
export function nextStage(stage: SimulationStage, choice: GuideChoice): SimulationStage {
  if (choice === "restart") return "agreement";
  if (stage === "agreement" && choice === "next") return "invoice";
  if (stage === "invoice" && choice === "next") return "approval";
  if (stage === "approval" && choice === "approve") return "submitted";
  if (stage === "approval" && choice === "reject") return "rejected";
  if (stage === "submitted" && choice === "interrupt") return "unresolved";
  if (stage === "submitted" && choice === "next") return "settled";
  return stage;
}

const scenes: Record<SimulationStage | "live", Scene> = {
  agreement: { title: "Good work starts with an agreement.", narration: "Meet Alex, a fictional contributor. The owner has agreed to a design delivery. Let’s follow one sample invoice from those terms to its outcome.", layout: "focus", panels: ["agreement"], choices: ["next", "policy"] },
  invoice: { title: "The contributor asks to be paid.", narration: "Alex files an invoice against the agreed terms. The executor checks the request under the signed policy and grant. In this example, the provider holds the payout for the owner’s approval.", layout: "compare", panels: ["agreement", "invoice"], choices: ["next", "supplier"] },
  approval: { title: "Now the owner decides.", narration: "Review the exact recipient, amount and purpose. Approving this held payout authorizes release; it does not prove payment completion. Try approving or explore a rejection.", layout: "focus", panels: ["signature", "invoice"], choices: ["approve", "reject", "signing"] },
  submitted: { title: "Approval is recorded. Follow the payment.", narration: "The owner’s approval and the payment outcome are separate observations. The guide follows the same payment identity while waiting for a provider outcome.", layout: "focus", panels: ["outcome"], choices: ["next", "interrupt"] },
  settled: { title: "A recorded outcome closes the loop.", narration: "The sample provider record now reports success for this exact payment. In your workspace, that claim must come from the retained operation evidence. This rehearsal moved no funds.", layout: "focus", panels: ["outcome", "roles"], choices: ["restart", "supplier"] },
  rejected: { title: "The owner chose not to release it.", narration: "This branch illustrates a rejected approval. A rejection is its own recorded outcome; the interface must not label the payment as paid. Restart to explore the other path.", layout: "focus", panels: ["outcome"], choices: ["restart", "policy"] },
  unresolved: { title: "An unknown outcome stays unknown.", narration: "The response was interrupted in this example. Keep the same payment identity and review its records. An unresolved operation blocks new sends; retrying the payment is not a recovery step.", layout: "focus", panels: ["outcome", "policy"], choices: ["restart", "signing"] },
  live: { title: "Your agent. Your decisions.", narration: "Use the real review controls below. The guide can explain the flow and suggest where to look. It does not inspect or create a signing payload, submit a payment, or establish an outcome.", layout: "focus", panels: ["roles"], choices: ["payments", "agreements", "signing"] },
};
export const sceneFor = (stage: SimulationStage | "live"): Scene => GuideScene.parse(scenes[stage]);

export const GuideEvent = z.strictObject({
  type: z.literal("CUSTOM"), name: z.literal("multiagency.payables.guide"),
  value: z.strictObject({ version: z.literal(1), source: z.enum(["scripted", "model"]), mode: GuideInput.shape.mode,
    stage: GuideInput.shape.stage, role: GuideInput.shape.role, scene: GuideScene }),
}).superRefine((event, ctx) => {
  if (!EventSchemas.safeParse(event).success) ctx.addIssue({ code: "custom", message: "Invalid AG-UI event" });
  const value = event.value;
  if ((value.mode === "live") !== (value.stage === "live")) ctx.addIssue({ code: "custom", message: "Live stage mismatch" });
  if (value.scene.choices.some(choice => !allowedChoices(value).includes(choice))) ctx.addIssue({ code: "custom", message: "Choice not available in this scene" });
  if (value.mode === "live" && value.scene.panels.some(panel => !["roles", "policy", "signature"].includes(panel)))
    ctx.addIssue({ code: "custom", message: "Live guidance cannot display simulated records" });
});
export function guideEvent(input: GuideRequest, scene: Scene, source: "scripted" | "model") {
  GuideInput.parse(input);
  return GuideEvent.parse({ type: "CUSTOM", name: "multiagency.payables.guide", value: {
    version: 1, source, mode: input.mode, stage: input.stage, role: input.role, scene,
  } });
}
