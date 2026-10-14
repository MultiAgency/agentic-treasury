import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { clientFor, gw } from "../shared/client";
import type { Decoded } from "../../../src/gateway/proposals.js";
import { loadGateway } from "./session";
import { visibleProposals } from "../shared/access";

export function redactProposalCaches(client: QueryClient) {
  for (const query of client.getQueryCache().findAll({ queryKey: ["gw", "proposals"] })) {
    const data = query.state.data as Decoded[] | undefined;
    // Redaction is not a successful read: keep existing denials, freshness and fetch state.
    if (data) query.setState({ data: visibleProposals(data) });
  }
}

export const gatewayQueries = {
  entry: queryOptions({ queryKey: ["gateway"], queryFn: loadGateway, retry: false, staleTime: Infinity, refetchOnReconnect: false }),
  metadata: queryOptions({ queryKey: ["gw", "me"], queryFn: loadGateway, staleTime: 60_000 }),
  proposals: (dao: string | undefined) => queryOptions({ queryKey: ["gw", "proposals", dao],
    queryFn: async () => visibleProposals(await gw<Decoded[]>(`/gw/proposals?dao=${encodeURIComponent(dao!)}`)), enabled: Boolean(dao), refetchInterval: 15_000,
    retry: (failures, error) => !["UNAUTHORIZED", "FORBIDDEN"].includes((error as { code?: string }).code ?? "") && failures < 3 }),
  sibling: (name: string) => queryOptions({ queryKey: ["sibling", name], staleTime: 60_000, queryFn: async () => {
    const api = clientFor(`/a/${name}`);
    const [setup, overview] = await Promise.all([api.setup(), api.overview()]);
    return { setup, overview };
  } }),
};
