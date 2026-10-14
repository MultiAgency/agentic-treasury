import { client } from "./lib";

/** Shared private observation; server controls recheck authorization before enabling. */
export const strategyQuery = { queryKey: ["strategy"], queryFn: () => client.strategy.get(), refetchInterval: 30_000, retry: false } as const;
