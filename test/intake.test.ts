import assert from "node:assert/strict";
import { test } from "node:test";
import { requestId, usdcUnits, validate } from "../src/intake.js";

test("amounts are positive USDC with at most 6 decimals", () => {
  assert.equal(usdcUnits("250"), "250000000");
  assert.equal(usdcUnits(" 99.5 "), "99500000");
  assert.equal(usdcUnits("0.000001"), "1");
  for (const bad of ["0", "0.0", "-1", "1.0000001", "1e3", "abc", "", "1,000"]) assert.equal(usdcUnits(bad), null, bad);
});

test("every field is checked, whatever proposed it", () => {
  assert.deepEqual(validate({ payee: " Alice.Near ", amount: "250", reference: "Invoice 1042" }), {
    payee: "alice.near",
    amount: "250000000",
    reference: "Invoice 1042",
  });
  assert.match(String((validate({ payee: "not an account!", amount: "1", reference: "x" }) as { invalid: string }).invalid), /^payee/);
  assert.match(String((validate({ payee: "a.near", amount: "lots", reference: "x" }) as { invalid: string }).invalid), /^amount/);
  assert.match(String((validate({ payee: "a.near", amount: "1", reference: "" }) as { invalid: string }).invalid), /^reference/);
  assert.match(String((validate({ payee: "a.near", amount: "1", reference: "x".repeat(121) }) as { invalid: string }).invalid), /^reference/);
  assert.match(String((validate({ payee: "a.near", amount: 1, reference: "x" }) as { invalid: string }).invalid), /^amount/);
});

test("the same payee, amount and reference always name the same request", () => {
  const request = { payee: "a.near", amount: "1000000", reference: "Invoice 7" };
  assert.equal(requestId(request), requestId({ ...request }));
  assert.match(requestId(request), /^[0-9a-f]{32}$/);
  assert.notEqual(requestId(request), requestId({ ...request, amount: "1000001" }));
  assert.notEqual(requestId(request), requestId({ ...request, reference: "Invoice 8" }));
});
