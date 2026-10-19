import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConsumerContract, checkFrontendUsage } from "../scripts/check-consumer-contract.mjs";

test("consumer contract preflight rejects missing procedures and incompatible inputs/outputs without executing routers", () => {
  const directory = mkdtempSync(join(tmpdir(), "sdk-fixture-"));
  const provider = join(directory, "provider"), consumer = join(directory, "consumer");
  const imports = `
import type { os as Os } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@orpc/server")).replace(/\.mjs$/, ".d.mts"))};
import type { z as Z } from ${JSON.stringify(resolve("node_modules/zod/index.d.ts"))};
declare const os: typeof Os;
declare const z: typeof Z;
throw new Error("Router modules must never execute during preflight");
`;
  const router = (input: string, output: string, extra = "") => `${imports}
export const router = { read: os.input(z.object({ id: z.${input}() })).handler(() => ${output})${extra} };
export type Router = typeof router;
`;
  try {
    for (const root of [provider, consumer]) mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(provider, "src/router.ts"), router("string", '"value"'));
    writeFileSync(join(consumer, "src/router.ts"), router("string", '"value"'));
    const compatible = checkConsumerContract(consumer, provider);
    assert.equal(compatible.ok, true, compatible.diagnostics);
    for (const source of [router("string", '"value"', ', missing: os.handler(() => true)'),
      router("number", '"value"'), router("string", "123")]) {
      writeFileSync(join(consumer, "src/router.ts"), source);
      const incompatible = checkConsumerContract(consumer, provider);
      assert.equal(incompatible.ok, false);
      assert.match(incompatible.diagnostics, /TS(2322|2741)/);
    }
    assert.throws(() => checkConsumerContract(join(directory, "absent"), provider), /Missing router/);

    // Backend-only procedures do not belong to the frontend's required contract.
    writeFileSync(join(consumer, "src/router.ts"), router("string", '"value"', ', missing: os.handler(() => true)'));
    assert.equal(checkConsumerContract(consumer, provider, ["read"]).ok, true);
    mkdirSync(join(consumer, "web/src/shared"), { recursive: true });
    writeFileSync(join(consumer, "web/tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, target: "ESNext", module: "ESNext", moduleResolution: "Bundler", types: [] },
      include: ["src"],
    }));
    const clientPath = join(consumer, "web/src/shared/client.ts");
    const clientSource = `
import type { RouterClient } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@orpc/server")).replace(/\.mjs$/, ".d.mts"))};
import type { Router } from '../../../src/router.js';
export declare const client: RouterClient<Router>;
export type { GatewayOnly } from '../../../src/gateway.js';
`;
    writeFileSync(clientPath, clientSource);
    writeFileSync(join(consumer, "src/gateway.ts"), "import type { Router } from './router.js'; export type GatewayOnly = Router['missing'];");
    const entry = join(consumer, "web/src/main.ts");
    writeFileSync(entry, "import { client as api } from './shared/client.js'; api.read({ id: 'value' });");
    const validUsage = checkFrontendUsage(consumer, ["read"]);
    assert.equal(validUsage.ok, true, validUsage.diagnostics);
    writeFileSync(entry, "import { client as api } from './shared/client.js'; const factory = () => api; factory().missing();");
    const undeclared = checkFrontendUsage(consumer, ["read"]);
    assert.equal(undeclared.ok, false);
    assert.match(undeclared.diagnostics, /missing/);
    assert.equal(checkFrontendUsage(consumer, ["read", "missing"]).ok, true);
    assert.equal(readFileSync(clientPath, "utf8"), clientSource, "virtual checks preserve the consumer checkout");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
