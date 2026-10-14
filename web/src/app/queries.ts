import { queryOptions } from "@tanstack/react-query";
import { clientFor, gw } from "../shared/client";
import type { Decoded } from "../../../src/gateway/proposals.js";
import { loadGateway } from "./session";

export const gatewayQueries = {
  entry: queryOptions({ queryKey: ["gateway"], queryFn: loadGateway, retry: false, staleTime: "static", refetchOnReconnect: false }),
  metadata: queryOptions({ queryKey: ["gw", "me"], queryFn: loadGateway, staleTime: 60_000 }),
  proposals: (dao: string | undefined) => queryOptions({ queryKey: ["gw", "proposals", dao],
    queryFn: () => gw<Decoded[]>(`/gw/proposals?dao=${encodeURIComponent(dao!)}`), enabled: Boolean(dao), refetchInterval: 15_000 }),
  sibling: (name: string) => queryOptions({ queryKey: ["sibling", name], staleTime: 60_000, queryFn: async () => {
    const api = clientFor(`/a/${name}`);
    const [setup, overview] = await Promise.all([api.setup(), api.overview()]);
    return { setup, overview };
  } }),
};
