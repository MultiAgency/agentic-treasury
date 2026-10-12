import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceId, usdcUnits, validate } from "../src/invoices.js";

test("amounts are positive USDC with at most 6 decimals", () => {
  assert.equal(usdcUnits("250"), "250000000");
  assert.equal(usdcUnits(" 99.5 "), "99500000");
  assert.equal(usdcUnits("0.000001"), "1");
  for (const bad of ["0", "0.0", "-1", "1.0000001", "1e3", "abc", "", "1,000"]) assert.equal(usdcUnits(bad), null, bad);
});

const SUBMISSION = "4f6b2c1e-9d7a-4c3b-8e2f-1a2b3c4d5e6f";

test("every field is checked", () => {
  assert.deepEqual(validate({ payee: " Alice.Near ", amount: "250", note: " October design work ", submission: SUBMISSION }), {
    payee: "alice.near",
    amount: "250000000",
    note: "October design work",
    submission: SUBMISSION,
  });
  assert.equal((validate({ payee: "a.near", amount: "1", submission: SUBMISSION }) as { note: string }).note, "", "the note is optional");
  const invalid = (input: Record<string, unknown>) => String((validate({ payee: "a.near", amount: "1", submission: SUBMISSION, ...input }) as { invalid?: string }).invalid);
  assert.match(invalid({ payee: "not an account!" }), /^payee/);
  assert.match(invalid({ amount: "lots" }), /^amount/);
  assert.match(invalid({ amount: 1 }), /^amount/);
  assert.match(invalid({ note: "x".repeat(201) }), /^note/);
  assert.match(invalid({ note: "two\nlines" }), /^note/);
  assert.match(invalid({ submission: "" }), /^form/);
  assert.match(invalid({ submission: "<script>" }), /^form/);
});

test("one submission is one invoice: retries match, a new form doesn't", () => {
  const invoice = { payee: "a.near", amount: "1000000", note: "", submission: SUBMISSION };
  assert.equal(invoiceId(invoice), invoiceId({ ...invoice, note: "changed on retry" }));
  assert.match(invoiceId(invoice), /^[0-9a-f]{32}$/);
  assert.notEqual(invoiceId(invoice), invoiceId({ ...invoice, submission: "0f6b2c1e-9d7a-4c3b-8e2f-1a2b3c4d5e6f" }));
  assert.notEqual(invoiceId(invoice), invoiceId({ ...invoice, payee: "b.near" }));
});

test("a wallet that signs the page's URL as NEP-413 callbackUrl verifies with it (real sign-in, 2026-10-12)", async () => {
  const { nep413Hash, signatureBytes, verifyEd25519 } = await import("../src/nep413.js");
  const key = "ed25519:7g2kKQYuRXPVhn8HTLiRdBfJTF1fd7UZ8xASAcrht3nk";
  const signature = signatureBytes("uu24iawRTfSXfM4A5gFcO4XRt0l9ZaVJw8UI7ARMFSV0kuTDxAarmhliRjJBDD7UwD3+sKroBOX75NmeuihNDw==");
  const nonce = Buffer.from("m8M+4IBj1wrjbIOG8NW7WNWNzJcfOzWL4dMw0FUN06s=", "base64");
  const message = "Sign in to localhost:8791";
  assert.equal(verifyEd25519(key, nep413Hash(message, nonce, "localhost:8791"), signature), false);
  assert.equal(verifyEd25519(key, nep413Hash(message, nonce, "localhost:8791", "http://localhost:8791/"), signature), true);
});
