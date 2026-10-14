import { ArrowRight, ChartPieSlice, HandCoins, Receipt } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { type Brief, type Kind, type Known, knownLabel, REQUIREMENTS_CONTEXT, PROTOTYPES, PROVEN, type Requirement, STOPPER_LABEL, summarizeRequirements } from "./beats";
import { Card, Details } from "./ui";

/** How a requirement is known, as one mark: full when seen on mainnet, half when tested offline, empty when deployed behavior is unverified. */
export function KnownMark({ known, size = 14 }: { known: Known; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={`shrink-0 ${known === "not-yet" ? "text-muted-foreground" : "text-brand-strong"}`}>
      {known === "mainnet" ? (
        <circle cx="8" cy="8" r="7" fill="currentColor" />
      ) : (
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
      {known === "offline" && <path d="M8 1a7 7 0 0 0 0 14z" fill="currentColor" />}
    </svg>
  );
}

const KNOWN_LEGEND: [Known, string][] = [
  ["mainnet", "Observed on mainnet"],
  ["offline", "Tested offline"],
  ["provider-source", "Provider source; deployed behavior unverified"],
  ["not-yet", "Not yet"],
];

/** The key to every mark on the page: how each requirement is known. */
export function KnownLegend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground" aria-label="How each requirement is known">
      {KNOWN_LEGEND.map(([known, label]) => (
        <li key={known} className="flex items-center gap-2">
          <KnownMark known={known} /> {label}
        </li>
      ))}
    </ul>
  );
}

/** A row's second line: for a guarantee, who stops it and how that's known; for a capability, how it's known. */
const detail = (r: Requirement) =>
  r.type === "guarantee" && r.stoppedBy
    ? r.stoppedBy === "policy" || r.stoppedBy === "server"
      ? `Control: ${STOPPER_LABEL[r.stoppedBy].toLowerCase()}. ${knownLabel(r)}`
      : STOPPER_LABEL[r.stoppedBy]
    : knownLabel(r);

/** A brief's catalog number and title. */
function BriefTitle({ brief }: { brief: Brief }) {
  return (
    <span className="font-medium text-foreground">
      <span className="mr-2 text-muted-foreground tabular-nums">{brief.catalog}</span>
      {brief.title}
    </span>
  );
}

/** The running brief and its evidence; planned briefs stay in the planning docs. */
export function WhatThisShows({ kind, dao, openRunning = false }: { kind: Kind; dao?: string; openRunning?: boolean }) {
  const { name, tagline, briefs } = PROTOTYPES[kind];
  const [brief] = briefs;
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{name}: requirements and evidence</h2>
        <p className="text-sm text-muted-foreground">{tagline}</p>
      </div>
      <p className="text-sm text-muted-foreground">{REQUIREMENTS_CONTEXT}</p>
      <Details open={openRunning} summary={`${brief.catalog} ${brief.title}`}>
        <ul className="flex flex-col divide-y">
          {brief.requirements.map((r) => (
            <li key={r.text} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  <span className="text-muted-foreground">{r.type === "guarantee" ? "Safety target: " : "Capability target: "}</span>
                  {r.text}
                </span>
                <span className="inline-flex max-w-full items-start gap-1.5 text-xs text-muted-foreground">
                  <KnownMark known={r.known} size={12} /> {detail(r)}
                </span>
              </div>
              <span className="text-muted-foreground">
                {r.evidence}
                {dao &&
                  r.proposals?.map((n) => (
                    <span key={n}>
                      {", "}
                      <a className="underline hover:text-foreground" href={`https://trezu.app/${dao}/requests/${n}`} target="_blank" rel="noreferrer">
                        proposal #{n}
                      </a>
                    </span>
                  ))}
              </span>
            </li>
          ))}
        </ul>
      </Details>
    </Card>
  );
}

const PROTOTYPE_ICON: Record<Kind, typeof HandCoins> = { facilitator: HandCoins, treasury: ChartPieSlice };

/** A list of requirements of one kind, each with its mark and detail. */
function RequirementList({ heading, requirements }: { heading: string; requirements: Requirement[] }) {
  if (requirements.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium text-muted-foreground">{heading}</h4>
      <ul className="flex flex-col gap-3">
        {requirements.map((r) => (
          <li key={r.text} className="grid grid-cols-[14px_1fr] gap-x-3">
            <span className="flex h-6 items-center">
              <KnownMark known={r.known} />
            </span>
            <span className="flex flex-col">
              <span className={r.known === "not-yet" ? "text-muted-foreground" : ""}>{r.text}</span>
              <span className="text-sm text-muted-foreground">{detail(r)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A brief's requirements: its capabilities (what the agent does), then its guarantees (what it can't do). */
function Requirements({ requirements }: { requirements: Requirement[] }) {
  return (
    <div className="flex flex-col gap-4">
      <RequirementList heading="Capability targets" requirements={requirements.filter((r) => r.type === "capability")} />
      <RequirementList heading="Safety targets" requirements={requirements.filter((r) => r.type === "guarantee")} />
    </div>
  );
}

/** Public-safe coverage and limitations from the running brief, also visible on compact cards. */
function ProgressSummary({ brief, name }: { brief: Brief; name: string }) {
  const summary = summarizeRequirements(brief.requirements);
  const categories = [
    ["Mainnet · this agent", summary.agent],
    ["Mainnet · another agent", summary.other],
    ["Offline only", summary.offline],
    ["Not yet demonstrated", summary.unverified],
  ] as const;
  return (
    <div role="group" aria-label={`Evidence coverage for ${name}`} className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-sm font-medium">Evidence coverage <span className="font-normal text-muted-foreground">· {summary.total} requirements</span></h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {categories.map(([label, count]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-lg font-medium tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">Recorded observations, not live status. Observations do not establish every guarantee.</p>
      <div className="flex flex-col gap-1 text-sm">
        <h4 className="font-medium">Known limitations</h4>
        {brief.limitations?.length ? (
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            {brief.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        ) : <p className="text-muted-foreground">Limitations have not yet been catalogued.</p>}
      </div>
    </div>
  );
}

/** Public cards disclose requirement stages without private evidence; member cards lead into the area. */
export function PrototypeCard({ kind, open, invoices, status, compact = false }: { kind: Kind; open?: string; invoices?: string | null; status?: ReactNode; compact?: boolean }) {
  const { name, tagline, briefs, demo } = PROTOTYPES[kind];
  const Icon = PROTOTYPE_ICON[kind];
  const [running] = briefs;
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h2 className="flex items-center gap-3 font-heading text-2xl font-semibold tracking-tight">
          <Icon size={26} className="shrink-0 text-brand-strong" /> {name}
        </h2>
        {status}
        <p className="max-w-prose text-muted-foreground">{tagline}</p>
      </div>
      <ProgressSummary brief={running} name={name} />
      <div className="mt-auto flex flex-wrap gap-3">
        {open && (
          <a className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 font-medium text-primary-foreground hover:bg-primary/90" href={open}>
            Open {name} <ArrowRight size={16} />
          </a>
        )}
        {kind === "facilitator" && invoices && (
          <a className="inline-flex h-11 items-center gap-2 rounded-full border px-5 font-medium hover:bg-muted" href={invoices}>
            <Receipt size={16} /> Request a payment
          </a>
        )}
      </div>
      {!compact && (
        <>
          <Details summary="Requirements and stages">
            <p className="text-sm text-muted-foreground">{REQUIREMENTS_CONTEXT}</p>
            <KnownLegend />
            <h3><BriefTitle brief={running} /></h3>
            <Requirements requirements={running.requirements} />
          </Details>
          <Details summary="How the demo runs">
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {demo.map((step) => (
                <li key={step.text}>
                  <span className="text-muted-foreground">{step.on === "invoices" ? "Invoice page" : "Dashboard"}: </span>
                  {step.text}
                </li>
              ))}
            </ol>
          </Details>
        </>
      )}
    </Card>
  );
}

/** What our code has shown on mainnet beyond the briefs (beats.ts): claims only, as the front door shows them. */
export function ProvenOnMainnet() {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
        <KnownMark known="mainnet" /> Also working on mainnet, October 12–13, 2026
      </h2>
      <ul className="grid gap-x-8 gap-y-2 text-muted-foreground sm:grid-cols-2">
        {PROVEN.map((claim) => (
          <li key={claim}>{claim}</li>
        ))}
      </ul>
    </section>
  );
}
