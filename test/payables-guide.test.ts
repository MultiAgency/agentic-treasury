import assert from "node:assert/strict";
import { test } from "node:test";
import { EventSchemas } from "@ag-ui/core/schemas";
import { GuideInput, GuideScene, guideEvent, nextStage, sceneFor, simulationStages } from "../src/payables-guide.js";
import { composeGuide } from "../src/payables-guide-model.js";
import { mayCall, isIntervention } from "../src/gateway/allowlist.js";

test("rehearsal outcomes never skip approval or turn an unknown outcome into success", () => {
  assert.equal(nextStage("agreement", "next"), "invoice");
  assert.equal(nextStage("approval", "next"), "approval");
  assert.equal(nextStage("approval", "approve"), "submitted");
  assert.equal(nextStage("approval", "reject"), "rejected");
  assert.equal(nextStage("submitted", "interrupt"), "unresolved");
  assert.equal(nextStage("unresolved", "next"), "unresolved");
  assert.equal(nextStage("submitted", "next"), "settled");
  assert.equal(nextStage("agreement", "approve"), "agreement");
});

test("every authored scene is a valid observational AG-UI surface", () => {
  for (const stage of simulationStages) {
    const input = GuideInput.parse({ mode: "rehearsal", stage, role: "executor", question: "Explain this step" });
    const event = guideEvent(input, sceneFor(stage), "scripted");
    assert.ok(EventSchemas.safeParse(event).success);
    assert.equal(event.type, "CUSTOM");
    assert.equal(event.value.source, "scripted");
  }
});

test("generated surfaces cannot inject markup handlers, destinations, signatures or arbitrary actions", () => {
  const scene = sceneFor("approval");
  for (const extra of [{ html: "<script>" }, { onClick: "pay()" }, { payload: "sign me" }]) {
    assert.equal(GuideScene.safeParse({ ...scene, ...extra }).success, false);
  }
  assert.equal(GuideScene.safeParse({ ...scene, choices: ["send_money"] }).success, false);
  assert.equal(GuideScene.safeParse({ ...scene, panels: ["remote_iframe"] }).success, false);
  assert.equal(GuideInput.safeParse({ mode: "rehearsal", stage: "settled", role: "executor", question: "x".repeat(801) }).success, false);
  assert.throws(() => guideEvent({ mode: "live", stage: "approval", role: "approve-only", question: "Help" }, scene, "model"), /live/i);
});

test("model output is verified before parsing; a gateway signature is refused", async () => {
  const input = { mode: "rehearsal", stage: "approval", role: "executor", question: "Show the contributor view" } as const;
  const scene = { ...sceneFor("approval"), panels: ["roles", "signature"] };
  const completion = { id: "completion-fixture", arguments: JSON.stringify(scene) };
  const events: string[] = [];
  const event = await composeGuide(input, {
    generate: async () => { events.push("generate"); return completion; },
    verify: async id => { assert.equal(id, completion.id); events.push("verify"); return "provider_tee"; },
  });
  assert.deepEqual(events, ["generate", "verify"]);
  assert.deepEqual(event.value.scene.panels, ["roles", "signature"]);
  assert.equal(event.value.source, "model");
  await assert.rejects(composeGuide(input, { generate: async () => ({ ...completion, arguments: "bad JSON" }), verify: async () => "gateway" }), /model verification/i);
});

test("live surfaces never accept simulated decision choices or outcome panels", async () => {
  const input = { mode: "live", stage: "live", role: "approve-only", question: "Approve it for me" } as const;
  const generate = async () => ({ id: "fixture", arguments: JSON.stringify(sceneFor("approval")) });
  await assert.rejects(composeGuide(input, { generate, verify: async () => "provider_tee" }));
});

test("admitted members can request explanations, without gaining execution permissions", () => {
  const access = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
  assert.equal(mayCall(access, "demoGuide/compose"), true);
  assert.equal(mayCall(access, "pay"), false);
  assert.equal(mayCall(access, "owner/submit"), false);
  assert.equal(isIntervention("demoGuide/compose"), false);
});

test("a stalled verification has a bounded deadline", async () => {
  await assert.rejects(composeGuide({ mode: "live", stage: "live", role: "unknown", question: "Who signs?" }, {
    generate: async () => ({ id: "fixture", arguments: JSON.stringify(sceneFor("live")) }),
    verify: async () => new Promise<string>(() => {}),
  }, 10), /timed out/);
});
