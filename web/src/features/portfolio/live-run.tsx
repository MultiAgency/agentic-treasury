import { queries } from "../../shared/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { client } from "../../shared/lib";
import { inspectRecording, observationLabel } from "../evidence/recording-model";
import { Badge, Button, Details, StatusBadge } from "../../shared/ui";

/** Supplement the actual run/receipt flow; never start, retry or reconstruct an operation. */
export function RunUpdates({ agentId, tickId, startedAt, ended }: { agentId: string; tickId: string; startedAt: string; ended: boolean }) {
  const [paused, setPaused] = useState(false);
  const cache = useQueryClient();
  const deadline = Date.parse(startedAt) + 10 * 60_000;
  const [recent, setRecent] = useState(() => Date.now() < deadline);
  // Expiry must also work while paused or disconnected, when no query causes a render.
  useEffect(() => {
    const remaining = deadline - Date.now();
    setRecent(remaining > 0);
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setRecent(false), remaining);
    return () => clearTimeout(timer);
  }, [deadline]);
  const query = useQuery({
    ...queries.recording(agentId, tickId),
    queryFn: async ({ signal }) => inspectRecording(await client.autopilot.log({ tickId }, { signal }), agentId, tickId),
    enabled: recent && !paused,
    refetchInterval: (q) => !recent || paused || q.state.status === "error" ? false : q.state.data?.completion === "recorded-end" ? 15_000 : 3_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    gcTime: 0,
  });
  const recording = query.error ? undefined : query.data;
  const progress = recording?.events.filter(event => event.type === "STEP_STARTED" || event.type === "STEP_FINISHED" || (event.type === "CUSTOM" && event.value.stage === "submission")) ?? [];
  const latest = progress.at(-1);
  useEffect(() => {
    if (!ended && recording?.completion === "recorded-end") {
      void cache.invalidateQueries({ queryKey: ["autopilot", "evidence", "timeline", "history"] });
    }
  }, [cache, ended, recording?.completion]);
  return <section aria-label="Run updates" className="flex min-w-0 flex-col gap-3 rounded-xl border p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Run updates</h3>
      <Badge>{query.error ? "Read unavailable" : !recent ? "On request" : paused ? "Paused" : "Following"}</Badge>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true" className="text-muted-foreground">
      {query.error ? "Run updates unavailable. The last recorded details below may be out of date."
        : !recent ? "Automatic following ended. Refresh outcomes to read the latest recorded evidence."
          : paused ? "Automatic updates paused. The agent may still be running."
          : !recording ? "Checking run updates…"
            : !ended && latest ? `Last recorded: ${observationLabel(latest)}.`
            : ended ? "Following later operation outcomes." : "Following this run. Detailed observations arrive when its end is recorded."}
    </p>
    <Button variant="outline" size="sm" className="self-start" aria-busy={query.isFetching} disabled={query.isFetching} onClick={() => void query.refetch()}>{query.error ? "Retry run updates" : "Refresh outcomes"}</Button>
    {query.dataUpdatedAt > 0 && !query.error && <p className="text-xs text-muted-foreground">Last read {new Date(query.dataUpdatedAt).toLocaleTimeString()}{paused || !recent ? ". Updates are not automatic." : "."}</p>}
    {recording && recording.gaps.length > 0 && <p className="text-muted-foreground">Some evidence is incomplete. Inspect recording for details.</p>}
    {progress.length > 0 && <Details summary="Recorded run stages">
      <p className="text-muted-foreground">These are recorded observations. A stage returning does not mean every operation settled.</p>
      <ol className="flex flex-col gap-3">{progress.map(event => <li key={event.metadata.eventId} className="flex flex-col gap-1">
        <span>{observationLabel(event)}</span>
        <span className="text-xs text-muted-foreground">{event.timestamp === undefined ? "Timing unknown" : new Date(event.timestamp).toLocaleTimeString()}</span>
        {event.type === "CUSTOM" && event.value.stage === "submission" && <Link to="/activity" hash={`operation-${event.value.correlationId}`} className="inline-flex min-h-11 items-center underline">Inspect submitted {event.value.method}</Link>}
      </li>)}</ol>
    </Details>}
    {recording && recording.laterObservations.length > 0 && <div>
      <h4 className="font-medium">Later operation outcomes</h4>
      <p className="text-muted-foreground">Recorded after the run ended; these do not replace its original observations.</p>
      <ul className="divide-y">{recording.laterObservations.map((entry) => {
        const matches = recording.events.filter(event => event.type === "CUSTOM" && (event.value.stage === "send" || event.value.stage === "shield") && event.value.correlationId === entry.correlationId);
        const event = matches.length === 1 ? matches[0] : undefined;
        const label = event?.type === "CUSTOM" && (event.value.stage === "send" || event.value.stage === "shield")
          ? `${event.value.stage === "send" ? "Swap" : "Shield"} ${event.value.index + 1}` : "Operation";
        return <li key={`${entry.correlationId}:${entry.record.line}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
          <div className="flex flex-col gap-1">
            <span className="font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{entry.record.recordedAt ? new Date(entry.record.recordedAt).toLocaleString() : "Timing unknown"}</span>
          </div>
          <StatusBadge status={entry.record.status ?? entry.record.type} />
          <Link to="/activity" hash={`operation-${entry.correlationId}`} className="inline-flex min-h-11 items-center underline" aria-label={`Inspect ${label.toLowerCase()} in Activity`}>Inspect operation</Link>
        </li>;
      })}</ul>
    </div>}
    <Details summary="Automatic update details">
      <p>Checks every {recording?.completion === "recorded-end" ? 15 : 3} seconds for ten minutes after the run starts. Pauses in background tabs. Pausing this view does not stop the executor.</p>
      {recent && <Button variant="outline" size="sm" onClick={() => setPaused(!paused)}>{paused ? "Resume updates" : "Pause updates"}</Button>}
    </Details>
  </section>;
}
