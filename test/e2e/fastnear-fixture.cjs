// E2E only: FastNear's Transfers API reports no public movements, so reconciliation reads run offline.
// Every other request is unchanged and still passes through the offline network guard.
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.host === 'transfers.main.fastnear.com' && url.pathname === '/v0/transfers')
    return new Response(JSON.stringify({ transfers: [], resume_token: null }), { headers: { 'content-type': 'application/json' } });
  return original(input, init);
};
