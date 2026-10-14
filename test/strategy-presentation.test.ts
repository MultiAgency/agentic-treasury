import assert from "node:assert/strict";
import { test } from "node:test";
import { strategyPresentation } from "../web/src/strategy-presentation.js";
import type { StrategyStatus } from "../src/strategy-status.js";
import { DEFAULT_STRATEGY } from "../src/strategy-digest.js";
const snapshot: StrategyStatus = { strategy: DEFAULT_STRATEGY, digest: "reviewed", grantSuffix: "fixture", executor: true,
  on: false, grantMatches: true, unresolved: 0, grant: null, observedAt: "2026-01-01T00:00:00Z",
  readiness: { state: "off", reasons: [], canEnable: true } };
const facts = () => ({ status: { data: snapshot, error: null as unknown }, schedule: { data: { on: false }, error: null as unknown },
  actions: { data: [] as { type: string; stage: string }[], error: null, isSuccess: true },
  review: snapshot, executor: true, operator: true, busy: false, canSign: true });

test("failed observations cannot produce ready labels or grant/enable controls; stop and drafts remain available", () => {
  for (const source of ["status", "schedule"] as const) {
    const input = facts(); input[source].error = new Error("unavailable");
    const view = strategyPresentation(input);
    assert.equal(view.readinessLabel, "Readiness unknown");
    assert.equal(view.canEnable, false); assert.equal(view.canReview, false); assert.equal(view.canAuthorize, false);
    assert.equal(view.showStop, true); assert.equal(view.canEdit, true); assert.equal(view.value, snapshot);
  }
});

test("review identity, pending owner actions, and operator permissions govern their respective controls", () => {
  const input = facts();
  assert.equal(strategyPresentation(input).canAuthorize, true);
  input.review = { ...snapshot, digest: "old" };
  assert.equal(strategyPresentation(input).canAuthorize, false);
  input.review = snapshot; input.actions.data = [{ type: "grant_issue", stage: "submitted" }];
  assert.equal(strategyPresentation(input).canAuthorize, false);
  assert.equal(strategyPresentation(input).canEdit, false);
  input.actions.data = []; input.operator = false;
  assert.equal(strategyPresentation(input).canAuthorize, true, "members who can sign may propose owner authorization");
  assert.equal(strategyPresentation(input).canEnable, false);
  assert.equal(strategyPresentation(input).canEdit, false);
});
