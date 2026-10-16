import { Context, Layer } from "effect";

export class FastnearHttp extends Context.Service<FastnearHttp, {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  apiKey: () => string | undefined;
}>()("Proto/FastnearHttp") {}

/** Built once per read workflow, not once per page. No global runtime or owned socket pool. */
export const FastnearHttpLive = Layer.sync(FastnearHttp, () => {
  const key = process.env.FASTNEAR_API_KEY;
  const transport = globalThis.fetch;
  return { fetch: (url: string, init: RequestInit) => transport(url, init), apiKey: () => key };
});

export const fastnearHttpLayer = (client: typeof FastnearHttp.Service) => Layer.succeed(FastnearHttp, client);
