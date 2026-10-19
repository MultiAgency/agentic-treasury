import { Badge } from "../../shared/ui";
import type { SurfaceSource } from "./catalog";

/** Every demo surface names its data: fixture data, a past recording, or the signed-in owner's real records. */
export function SourceLabel({ source }: { source: SurfaceSource }) {
  return <Badge tone={source === "Live" ? "warning" : "info"}>{source}</Badge>;
}
