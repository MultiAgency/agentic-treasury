import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createGrantCredential } from "@near-intents-agent-api/sdk";
import { adoptStagedGrant, promoteGrantToken, stageGrantToken } from "../src/intents.js";

// Every test gets an empty directory: the settings file is written to the working directory.
const home = process.cwd();
beforeEach(() => process.chdir(mkdtempSync(join(tmpdir(), "grants-"))));
after(() => process.chdir(home));

const [old, next] = [createGrantCredential(), createGrantCredential()];
type Grants = Parameters<typeof adoptStagedGrant>[0];
const grant = (credential: string, { days = 1, revoked = false } = {}) =>
  ({
    revoked_at: revoked ? new Date().toISOString() : null,
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    owner_message: { credential },
  }) as unknown as Grants[number];

/** The token in use and the staged one, as this process sees them. */
const tokens = () => [process.env.AGENT_GRANT_TOKEN || null, process.env.AGENT_GRANT_TOKEN_PENDING || null];
const staged = () => Object.assign(process.env, { AGENT_GRANT_TOKEN: old.token, AGENT_GRANT_TOKEN_PENDING: next.token });

test("a staged token waits beside the token in use until its grant is in force", () => {
  Object.assign(process.env, { AGENT_GRANT_TOKEN: old.token, AGENT_GRANT_TOKEN_PENDING: "" });
  stageGrantToken(next.token);
  assert.deepEqual(tokens(), [old.token, next.token]);
  promoteGrantToken(next.token);
  assert.deepEqual(tokens(), [next.token, null]);
  assert.equal(readFileSync(".env", "utf8"), `AGENT_GRANT_TOKEN=${next.token}\nAGENT_GRANT_TOKEN_PENDING=\n`);
});

test("a staged token whose grant is not in force is never adopted", () => {
  const cases: [string, Grants][] = [
    ["not issued", [grant(old.commitment)]],
    ["revoked", [grant(old.commitment), grant(next.commitment, { revoked: true })]],
    ["expired", [grant(old.commitment), grant(next.commitment, { days: -1 })]],
  ];
  for (const [name, grants] of cases) {
    staged();
    adoptStagedGrant(grants);
    assert.deepEqual(tokens(), [old.token, next.token], name);
  }
});

test("a staged token whose grant is in force is adopted, even while the token in use still works", () => {
  staged();
  adoptStagedGrant([grant(old.commitment), grant(next.commitment)]);
  assert.deepEqual(tokens(), [next.token, null]);
});
