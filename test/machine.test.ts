import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connect } from "../src/commands.ts";
import { ROLES } from "../src/config.ts";
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

test("a role's client reaches only the scopes that role is issued with", () => {
  const typed = (connect: Connect) => {
    const read: Machine<"read"> = connect("propose");
    const execute: Machine<"execute-plan"> = connect("execute");
    void read; void execute;
    // @ts-expect-error the execute role's credential doesn't read
    const readWithExecute: Machine<"read"> = connect("execute");
    // @ts-expect-error the sweep role's credential doesn't execute plans
    const executeWithSweep: Machine<"execute-plan"> = connect("sweep");
    // @ts-expect-error the propose role's credential doesn't execute plans
    const executeWithPropose: Machine<"execute-plan"> = connect("propose");
    void readWithExecute; void executeWithSweep; void executeWithPropose;
    // @ts-expect-error the execute role's credential doesn't read
    void connect("execute").call("activity");
    // @ts-expect-error the propose role's credential doesn't sweep
    void connect("propose").stream("sweep", { execute: true });
  };
  assert.equal(typeof typed, "function");
  assert.deepEqual(Object.fromEntries(Object.entries(ROLES).map(([role, { scopes }]) => [role, [...scopes]])),
    { propose: ["read", "prepare"], execute: ["execute-plan"], sweep: ["sweep"] });
});

test("exit codes: 0 ok, 2 nothing sent, 3 unknown, 4 partial", () => {
  assert.equal(exitCode({ ok: true }), 0);
  for (const kind of ["session", "forbidden", "refused", "busy", "unresolved", "provider", "unavailable"] as const)
    assert.equal(exitCode({ ok: false, kind } as Parameters<typeof exitCode>[0]), 2, kind);
  assert.equal(exitCode({ ok: false, kind: "unknown", procedure: "executePlan", identity: { planId: "p" } }), 3);
  assert.equal(exitCode({ ok: false, kind: "partial", error: "", legs: [] }), 4);
});
