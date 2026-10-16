import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request, type Server } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { invoiceRoute } from '../src/gateway/demo-hosts.js';
import { forwardInvoice } from '../src/gateway/invoice-proxy.js';

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as {port: number}).port)));
test('static supplier entry forwards each exact work-order identity without dropping other query fields', async t => {
  const seen: string[] = [];
  const backend = createServer((req, res) => {
    seen.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url }));
  });
  const upstream = await listen(backend); t.after(() => backend.close());
  // Production route and proxy, with only the HTTPS transport adapted to the offline HTTP fixture.
  const transport = ((_url: URL, options: object, callback: Parameters<typeof request>[2]) => request({ ...options, hostname: '127.0.0.1', port: upstream }, callback)) as unknown as typeof httpsRequest;
  const gateway = createServer((req, res) => {
    const path = invoiceRoute('invoices', new URL(req.url!, 'https://invoices.test'), req.method!);
    assert.notEqual(path, null);
    forwardInvoice(req, res, 'https://retained-executor.invalid', path!, transport);
  });
  const port = await listen(gateway); t.after(() => gateway.close());
  for (const id of ['12345678-1234-4234-8234-123456789abc', '22345678-1234-4234-8234-123456789abc']) {
    for (let reload = 0; reload < 2; reload++) {
      const response = await fetch(`http://127.0.0.1:${port}/submit?source=agency&workOrder=${id}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { path: `/?source=agency&workOrder=${id}` });
    }
  }
  assert.equal(seen.length, 4, 'one upstream request per navigation; no replay or substitution');
});
