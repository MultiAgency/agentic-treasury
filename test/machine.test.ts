import { test } from "node:test";
import assert from "node:assert/strict";
import { machine, type Machine } from "../src/machine.ts";
import { exitCode } from "../src/outcome.ts";

test("a credential's scopes bound what compiles", () => {
  const typed = (read: Machine<"read">, propose: Machine<"read" | "prepare">, execute: Machine<"execute-plan">) => {
    void read.call("overview");
    void propose.stream("rebalance", undefined);
    void execute.stream("executePlan", { planId: "p" });
    // @ts-expect-error held is an owner read the machine route doesn't serve
    void read.call("held");
    // @ts-expect-error reading doesn't permit preparing
    void read.call("externalPlan", { swaps: [] });
    // @ts-expect-error preparing doesn't permit executing
    void propose.stream("executePlan", { planId: "p" });
    // @ts-expect-error executing doesn't permit reading
    void execute.call("activity");
    // @ts-expect-error nothing on the machine route signs owner actions
    void propose.call("owner/prepare", { action: { type: "agent_freeze" }, signer: "wallet" });
  };
  assert.equal(typeof typed, "function");
  assert.equal(typeof machine, "function");
});

test("exit codes: 0 ok, 2 nothing sent, 3 unknown", () => {
  assert.equal(exitCode({ ok: true }), 0);
  for (const kind of ["session", "forbidden", "refused", "busy", "unresolved", "provider", "unavailable"] as const)
    assert.equal(exitCode({ ok: false, kind } as Parameters<typeof exitCode>[0]), 2, kind);
  assert.equal(exitCode({ ok: false, kind: "unknown", procedure: "executePlan", identity: { planId: "p" } }), 3);
});
