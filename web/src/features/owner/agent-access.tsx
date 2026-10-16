import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onAccessDenial } from "../../shared/access";
import { FieldGroup, FieldSet, FieldLegend } from "../../components/ui/field";
import { useGateway } from "../../app/gateway-context";
import { useViewer } from "../../app/viewer";
import { BASE, errorMessage } from "../../shared/lib";
import { Field } from "../../shared/form";
import { Badge, Button, ErrorBox, input } from "../../shared/ui";
import type { MachineCredentials, MachineScope } from "../../../../src/gateway/machine-auth.js";

type Credential = ReturnType<MachineCredentials["list"]>[number];
const permissions: { scope: MachineScope; label: string; detail: string }[] = [
  { scope: "read", label: "Read Treasury", detail: "See balances, policy, strategy and operation records." },
  { scope: "prepare", label: "Prepare plans", detail: "Quote and save chosen swaps or a rebalance under the owner’s policy and strategy limits. Moves no funds." },
  { scope: "execute-plan", label: "Execute saved plans", detail: "Execute saved swap plans within existing Treasury authority. Can move funds." },
  { scope: "sweep", label: "Sweep public balances", detail: "Shield managed public balances into confidentiality. Can move funds." },
];
const lifetimes = [{ seconds: 900, label: "15 minutes" }, { seconds: 3600, label: "1 hour" }, { seconds: 28800, label: "8 hours" }, { seconds: 86400, label: "24 hours" }];
type Review = { label: string; scopes: MachineScope[]; ttlSeconds: number };
const date = (time: number) => new Date(time).toLocaleString();

/** A context-keyed child owns all private state; old responses cannot populate a new owner context. */
export function AgentAccess() {
  const gateway = useGateway();
  const viewer = useViewer();
  const name = BASE.split("/")[2];
  const agent = gateway?.agents.find(a => a.name === name);
  return <AccessForm key={`${location.host}:${name}:${agent?.owner}:${viewer?.account}:${viewer?.access?.canManage}`} />;
}
function AccessForm() {
  const gateway = useGateway();
  const viewer = useViewer();
  const name = BASE.split("/")[2];
  const treasury = gateway?.agents.find(agent => agent.name === name);
  const canManage = viewer?.access?.canManage === true && treasury && treasury.area !== "payables";
  const canIssue = canManage && !treasury.dao && viewer.account === treasury.owner;
  const endpoint = `/gw/machine-credentials/${name}`;
  const [records, setRecords] = useState<Credential[]>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<MachineScope[]>(["read"]);
  const [ttlSeconds, setTtl] = useState(3600);
  const [review, setReview] = useState<Review>();
  const [issued, setIssued] = useState<{ token: string; credential: Credential }>();
  const [revoke, setRevoke] = useState<Credential>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const denied = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const focus = useRef<HTMLDivElement>(null);
  const formFocus = { get current() { return document.getElementById("access-label"); } };
  const listFocus = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(Date.now());

  const clearPrivate = () => {
    denied.current = true; generation.current++;
    setIssued(undefined); setReview(undefined); setRevoke(undefined); setRecords(undefined);
    setMessage(undefined); setError(undefined); setLoadError(undefined); setLabel(""); setScopes(["read"]); setTtl(3600); setUnavailable(true);
  };
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 || response.status === 403) clearPrivate();
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new Error(response.status === 404 || response.status === 405
      ? "Agent access is not available on this host." : body?.error ?? "Agent access could not be confirmed.");
    return body as T;
  }
  const valid = (epoch: number) => generation.current === epoch && !denied.current;
  async function refresh(epoch = generation.current) {
    if (!valid(epoch)) return;
    setLoading(true); setLoadError(undefined);
    try {
      const result = await request<{ credentials: Credential[] }>(endpoint);
      if (!Array.isArray(result.credentials)) throw new Error("Access records could not be read.");
      if (valid(epoch)) setRecords(result.credentials);
    } catch (e) { if (valid(epoch)) { setRecords(undefined); setLoadError(errorMessage(e)); } }
    finally { if (valid(epoch)) setLoading(false); }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    if (canManage) void refresh(epoch);
    const unsubscribe = onAccessDenial(denial => {
      if (denial.scope === "session" || denial.base === BASE) clearPrivate();
    });
    const hide = () => clearPrivate();
    window.addEventListener("pagehide", hide);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { generation.current++; unsubscribe(); clearInterval(timer); window.removeEventListener("pagehide", hide); };
  }, []);
  const previousPanel = useRef<"revoke" | "form" | null>(null);
  useLayoutEffect(() => {
    if (review || issued || revoke) focus.current?.focus();
    else if (previousPanel.current === "revoke") listFocus.current?.focus();
    else if (previousPanel.current === "form") formFocus.current?.focus();
    previousPanel.current = revoke ? "revoke" : review || issued ? "form" : null;
  }, [review, issued, revoke]);

  async function grant() {
    if (!review || !canIssue || lock.current || denied.current || uncertain) return;
    const epoch = generation.current;
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const result = await request<{ token: string; credential: Credential }>(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(review) });
      if (typeof result.token !== "string" || !result.credential?.id) throw new Error("Access details were not received.");
      if (valid(epoch)) { setIssued(result); setReview(undefined); setLabel(""); setScopes(["read"]); setMessage(undefined); }
    } catch (e) {
      if (valid(epoch)) { setReview(undefined); setUncertain(true); setError(`${errorMessage(e)} Access may have been created. Inspect and revoke any inaccessible credential before authorizing again.`); }
    } finally {
      if (valid(epoch)) { await refresh(epoch); lock.current = false; setBusy(false); }
    }
  }
  async function revokeAccess() {
    if (!revoke || !canManage || lock.current || denied.current) return;
    const epoch = generation.current;
    lock.current = true; setBusy(true); setError(undefined);
    // A failed response must never leave the possibly revoked secret visible.
    if (issued?.credential.id === revoke.id) setIssued(undefined);
    try {
      await request(`${endpoint}/${revoke.id}`, { method: "DELETE" });
      if (valid(epoch)) { setMessage(`Access revoked for ${revoke.label}.`); setRevoke(undefined); }
    } catch (e) { if (valid(epoch)) setError(`${errorMessage(e)} Revocation is not confirmed. Refresh access and retry revocation if needed.`); }
    finally {
      if (valid(epoch)) { await refresh(epoch); lock.current = false; setBusy(false); listFocus.current?.focus(); }
    }
  }
  return <main id="agent-main" tabIndex={-1} className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8">
    <a href={`${BASE}/`} className="inline-flex min-h-11 w-fit items-center underline underline-offset-4">Back to agent</a>
    <div className="flex flex-col gap-3"><h1 className="text-2xl font-semibold">Agent access</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">Choose what your agent may do with this Treasury, for how long, and revoke its access here.</p>
      {treasury && <p className="break-words text-sm">Treasury owner: <strong>{treasury.owner}</strong></p>}
    </div>
    {unavailable ? <p role="alert">Access could not be verified. Private details are hidden. <a href={location.pathname} className="underline">Check access again</a></p> : !canManage ? <p role="status">{gateway ? "Treasury management permission is required to manage agent access." : "Agent access requires a hosted Treasury gateway."}</p> : <>
      {treasury.dao && <p role="status" className="text-sm leading-relaxed">DAO delegation is unavailable until a verified DAO approval flow exists. DAO membership alone cannot authorize machine access.</p>}
      <ErrorBox error={error} />{message && <p role="status" className="break-all text-sm">{message}</p>}
      {issued && <section aria-label="New access details" className="flex flex-col gap-4 border-y py-6">
        <div ref={focus} tabIndex={-1}><h2 className="text-xl font-semibold">Save your agent’s access details</h2></div>
        <p className="text-sm text-muted-foreground">This credential is shown once. Put it in your agent runtime’s secret store, not a chat or skill file. Anyone holding it can use the permissions below until expiry or revocation.</p>
        <dl className="flex flex-col gap-2 break-words text-sm"><div><dt className="font-medium">Treasury URL</dt><dd>{location.origin}</dd></div><div><dt className="font-medium">Treasury name</dt><dd>{name}</dd></div><div><dt className="font-medium">Expires</dt><dd>{date(issued.credential.expiresAt)}</dd></div></dl>
        <label className="flex flex-col gap-2 text-sm font-medium">Access credential<textarea readOnly value={issued.token} className={`${input} min-h-24 w-full resize-y break-all font-mono text-xs`} spellCheck={false} autoComplete="off" /></label>
        <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={async () => { const epoch = generation.current; try { await navigator.clipboard.writeText(issued.token); if (valid(epoch)) setMessage("Credential copied. Store it securely in your agent runtime."); } catch { if (valid(epoch)) setError("Could not copy. Select the credential and copy it manually."); } }}>Copy credential</Button>
          <Button onClick={() => { setIssued(undefined); setMessage("Access details hidden. The credential remains active until expiry or revocation."); }}>Hide credential</Button></div>
      </section>}
      {canIssue && !issued && !uncertain && <section aria-label="Authorize your agent" className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Authorize your agent</h2>
        {review ? <div className="flex flex-col gap-4 border-y py-5" role="region" aria-label="Review agent access">
          <div ref={focus} tabIndex={-1}><h3 className="break-all font-semibold">Review access for {review.label}</h3></div>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">{permissions.filter(permission => review.scopes.includes(permission.scope)).map(permission => <li key={permission.scope}><strong>{permission.label}.</strong> {permission.detail}</li>)}</ul>
          <p className="text-sm">Expires {lifetimes.find(lifetime => lifetime.seconds === review.ttlSeconds)?.label} after issuance. Access is limited to this Treasury and host.</p>
          {review.scopes.some(scope => scope === "execute-plan" || scope === "sweep") && <p className="text-sm leading-relaxed">This permits your agent to move funds without asking again for each action. Existing policy and grant checks apply. There is no separate budget for this credential; the scheduled autopilot’s per-run ceiling does not limit external plan execution. Spending caps do not bound market exposure. Provider concurrency guarantees remain unverified.</p>}
          <p className="text-sm text-muted-foreground">Granting access creates no provider grant and moves no funds. Your agent can use the existing authority you delegate.</p>
          <div className="flex flex-wrap gap-3"><Button onClick={grant} disabled={busy}>{busy ? "Granting access…" : "Grant access"}</Button><Button variant="outline" disabled={busy} onClick={() => { setReview(undefined); }}>Change permissions</Button></div>
        </div> : <form className="flex flex-col gap-5" onSubmit={event => { event.preventDefault(); if (label.trim() && scopes.length) { setError(undefined); setReview({ label: label.trim(), scopes: [...scopes], ttlSeconds }); } }}>
          <FieldGroup><Field id="access-label" label="Access label" value={label} onChange={event => setLabel(event.target.value)} required maxLength={80} placeholder="For example, my Treasury assistant" /></FieldGroup><p className="text-sm text-muted-foreground">This label helps you recognize access. It is not proof of the agent’s identity.</p>
          <FieldSet><FieldLegend>Permissions</FieldLegend>
            {permissions.map(permission => <label key={permission.scope} className="flex min-h-11 cursor-pointer items-start gap-3 py-3 text-sm">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={scopes.includes(permission.scope)} onChange={event => setScopes(current => event.target.checked ? [...current, permission.scope] : current.filter(scope => scope !== permission.scope))} />
              <span className="flex flex-col gap-1"><span className="font-medium">{permission.label}</span><span className="leading-relaxed text-muted-foreground">{permission.detail}</span></span>
            </label>)}
          </FieldSet>
          <label className="flex flex-col gap-2 text-sm font-medium">Access duration<select className={input} value={ttlSeconds} onChange={event => setTtl(Number(event.target.value))}>{lifetimes.map(lifetime => <option key={lifetime.seconds} value={lifetime.seconds}>{lifetime.label}</option>)}</select></label>
          <Button type="submit" className="self-start" disabled={!label.trim() || !scopes.length || busy || loading || Boolean(loadError)}>Review access</Button>
        </form>}
      </section>}
      {uncertain && <div role="status" className="flex flex-col items-start gap-3"><p>Issuance outcome is unknown. Refresh access and revoke credentials you cannot use.</p><Button variant="outline" disabled={loading || busy || !records} onClick={() => { setUncertain(false); setError(undefined); }}>I reviewed existing access</Button></div>}
      <section aria-label="Existing agent access" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 ref={listFocus} tabIndex={-1} className="text-xl font-semibold">Existing access</h2><Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh access"}</Button></div>
        <p className="text-sm text-muted-foreground">Status reflects expiry and revocation only. It does not establish current ownership or operation settlement. Access is restricted to {location.host}.</p>
        <ErrorBox error={loadError} />
        {records && !records.length && <p className="text-sm text-muted-foreground">No agent access has been issued for this Treasury.</p>}
        <div className="divide-y">{records?.map(record => {
          const expired = record.expiresAt <= now;
          const active = record.version === 2 && !record.revoked && !expired;
          return <article key={record.id} aria-label={`Access for ${record.label}`} className="flex flex-col gap-3 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="break-all font-semibold">{record.label}</h3><Badge tone={active ? "success" : "neutral"}>{record.revoked ? "Revoked" : expired ? "Expired" : record.version === 1 ? "Unsupported" : "Active"}</Badge></div>
            <ul className="flex flex-col gap-1 text-sm">{record.scopes.map(scope => <li key={scope}>{permissions.find(permission => permission.scope === scope)?.label ?? "Earlier execution permission (unsupported)"}</li>)}</ul>
            <p className="break-words text-sm text-muted-foreground">Issued by {record.account} · {date(record.createdAt)}<br />Expires {date(record.expiresAt)}<br />Host: {record.host}</p>
            {!record.revoked && <Button variant="outline" className="h-auto min-h-11 max-w-full self-start whitespace-normal break-all" disabled={busy} onClick={() => { setRevoke(record); setError(undefined); }}>Revoke access for {record.label}</Button>}
          </article>;
        })}</div>
        {revoke && <div role="region" aria-label="Confirm revocation" className="flex flex-col gap-3 border-y py-5">
          <div ref={focus} tabIndex={-1}><h3 className="break-all font-semibold">Revoke access for {revoke.label}?</h3></div><p className="text-sm">Future calls will be refused. Revocation does not cancel operations already forwarded or turn off the Treasury schedule.</p>
          <div className="flex flex-wrap gap-3"><Button onClick={revokeAccess} disabled={busy}>{busy ? "Revoking…" : "Confirm revocation"}</Button><Button variant="outline" onClick={() => { setRevoke(undefined); listFocus.current?.focus(); }} disabled={busy}>Keep access</Button></div>
        </div>}
      </section>
    </>}
  </main>;
}
