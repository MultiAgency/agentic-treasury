import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fastnearPostEffect, runFastnear } from "../src/fastnear.js";

test("cancelling a read closes a real upstream HTTP request without retry", { timeout: 3000 }, async t => {
  let accepted!: () => void, disconnected!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { accepted = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer((req, res) => { calls++; req.resume(); res.on("close", disconnected); accepted(); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  const read = runFastnear(fastnearPostEffect(endpoint, {}), controller.signal, { apiKey: () => undefined, fetch });
  const rejected = assert.rejects(read, /read cancelled/);
  await started; controller.abort(); await rejected; await closed;
  assert.equal(calls, 1);
});
