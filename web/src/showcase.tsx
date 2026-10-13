import { ArrowRight, ChartPieSlice, HandCoins, Receipt } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { type Brief, type Kind, type Known, knownLabel, PROTOTYPES, PROVEN, type Requirement, STOPPER_LABEL } from "./beats";
import { Card, Details } from "./ui";

/** How a requirement is known, as one mark: full when seen on mainnet, half when tested offline, empty when not yet. */
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
  ["mainnet", "Held or working on mainnet"],
  ["offline", "Tested offline"],
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

/** A set of requirements counted: guarantees the signed policy enforces, and requirements seen on mainnet, by where. */
function figures(requirements: Requirement[]) {
  const guarantees = requirements.filter((r) => r.type === "guarantee");
  const seen = requirements.filter((r) => r.known === "mainnet");
  return {
    total: requirements.length,
    guarantees: guarantees.length,
    byPolicy: guarantees.filter((r) => r.stoppedBy === "policy").length,
    mainnet: seen.length,
    here: seen.filter((r) => r.where === "agent").length,
    elsewhere: seen.filter((r) => r.where === "other").length,
  };
}

/** "4 of 5 guarantees enforced by the signed policy, 4 of 8 on mainnet": a brief's figures in words. */
const counted = (requirements: Requirement[]) => {
  const f = figures(requirements);
  return `${f.byPolicy} of ${f.guarantees} ${f.guarantees === 1 ? "guarantee" : "guarantees"} enforced by the signed policy, ${f.mainnet} of ${f.total} on mainnet`;
};

/** A row's second line: for a guarantee, who stops it and how that's known; for a capability, how it's known. */
const detail = (r: Requirement) =>
  r.type === "guarantee" && r.stoppedBy
    ? r.stoppedBy === "policy" || r.stoppedBy === "server"
      ? `Enforced by ${STOPPER_LABEL[r.stoppedBy].toLowerCase()}, ${knownLabel(r).toLowerCase()}`
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

/** Each brief requirement by requirement, with how each is known (beats.ts): only for signed-in viewers. */
export function WhatThisShows({ kind, dao }: { kind: Kind; dao?: string }) {
  const { name, tagline, briefs } = PROTOTYPES[kind];
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{name}</h2>
        <p className="text-sm text-muted-foreground">{tagline}</p>
      </div>
      {briefs.map((brief) => (
        <Details key={brief.catalog} summary={`${brief.catalog} ${brief.title}: ${counted(brief.requirements)}`}>
          <ul className="flex flex-col divide-y">
            {brief.requirements.map((r) => (
              <li key={r.text} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    <span className="text-muted-foreground">{r.type === "guarantee" ? "Guarantee: " : "Capability: "}</span>
                    {r.text}
                  </span>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
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
      ))}
    </Card>
  );
}

const PROTOTYPE_ICON: Record<Kind, typeof HandCoins> = { facilitator: HandCoins, treasury: ChartPieSlice };

/** The running brief's two counts, guarantees first. */
function AreaFigures({ requirements }: { requirements: Requirement[] }) {
  const f = figures(requirements);
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
      <dt className="font-heading text-2xl font-semibold text-foreground">
        {f.byPolicy}/{f.guarantees}
      </dt>
      <dd>guarantees enforced by the signed policy</dd>
      <dt className="font-heading text-2xl font-semibold text-foreground">
        {f.mainnet}/{f.total}
      </dt>
      <dd>
        requirements on mainnet ({f.here} on this agent, {f.elsewhere} on another)
      </dd>
    </dl>
  );
}

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
      <RequirementList heading="Capabilities" requirements={requirements.filter((r) => r.type === "capability")} />
      <RequirementList heading="Guarantees" requirements={requirements.filter((r) => r.type === "guarantee")} />
    </div>
  );
}

/**
 * An area as the front door shows it: what it does, its running brief's two counts (guarantees enforced
 * by the signed policy, requirements on mainnet), that brief's capabilities and guarantees, its
 * roadmap folded and uncounted, and how to try it. Labels only: signed out, nothing beyond the chain is
 * shown.
 */
export function PrototypeCard({ kind, open, invoices, status }: { kind: Kind; open?: string; invoices?: string | null; status?: ReactNode }) {
  const { name, tagline, briefs, demo } = PROTOTYPES[kind];
  const Icon = PROTOTYPE_ICON[kind];
  const [running, ...planned] = briefs;
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h2 className="flex items-center gap-3 font-heading text-2xl font-semibold tracking-tight">
          <Icon size={26} className="shrink-0 text-brand-strong" /> {name}
        </h2>
        <AreaFigures requirements={running.requirements} />
        {status}
        <p className="max-w-prose text-muted-foreground">{tagline}</p>
      </div>
      <section className="flex flex-col gap-3">
        <h3>
          <BriefTitle brief={running} />
        </h3>
        <Requirements requirements={running.requirements} />
      </section>
      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm text-muted-foreground">Roadmap, not counted above</h3>
        {planned.map((brief) => (
          <details key={brief.catalog}>
            <summary className="cursor-pointer">
              <BriefTitle brief={brief} />
              <span className="block pl-4 text-sm text-muted-foreground">{counted(brief.requirements)}</span>
            </summary>
            <div className="mt-3">
              <Requirements requirements={brief.requirements} />
            </div>
          </details>
        ))}
      </div>
      <Details summary={open ? "Run the demo" : "How the demo runs"}>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {demo.map((step) => (
            <li key={step.text}>
              <span className="text-muted-foreground">{step.on === "invoices" ? "Invoice page" : "Dashboard"}: </span>
              {step.text}
            </li>
          ))}
        </ol>
      </Details>
      <div className="mt-auto flex flex-wrap gap-3">
        {open && (
          <a className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 font-medium text-primary-foreground hover:bg-primary/90" href={open}>
            Open <ArrowRight size={16} />
          </a>
        )}
        {kind === "facilitator" && invoices && (
          <a className="inline-flex h-11 items-center gap-2 rounded-full border px-5 font-medium hover:bg-muted" href={invoices}>
            <Receipt size={16} /> Request a payment
          </a>
        )}
      </div>
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
