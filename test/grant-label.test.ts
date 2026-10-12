import assert from "node:assert/strict";
import { test } from "node:test";
import { grantLabel } from "../src/intents.js";

test("a grant's label names its purpose, then any suffix the owner's signature binds", () => {
  assert.equal(grantLabel("payout"), "payout");
  assert.equal(grantLabel("invoices"), "invoices");
  const digest = "0123456789abcdef0123456789abcdef";
  assert.equal(grantLabel("treasury", digest), `treasury:${digest}`);
});

test("a label over the API's 64 characters is refused before anything is signed", () => {
  assert.equal(grantLabel("treasury", "x".repeat(55)).length, 64);
  assert.throws(() => grantLabel("treasury", "x".repeat(56)), /64 characters/);
});
