import { ArrowRight, ChartPieSlice, CheckCircle, Flask, HandCoins, Info, MinusCircle, Question, Receipt, Scroll } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { type Beat, type Kind, type Proof, PROOF_LABEL, PROTOTYPES } from "./beats";
import { Badge, Card, Details, type Tone } from "./ui";

const TONE: Record<Proof, Tone> = { mainnet: "success", offline: "info", design: "neutral", "provider-docs": "warning", unverified: "warning", "not-applicable": "neutral" };
const ICON: Record<Proof, typeof CheckCircle> = { mainnet: CheckCircle, offline: Flask, design: Info, "provider-docs": Scroll, unverified: Question, "not-applicable": MinusCircle };

/** What this prototype shows and how each claim is known (beats.ts): only for signed-in viewers. */
export function WhatThisShows({ kind, dao }: { kind: Kind; dao?: string }) {
  const { name, tagline, beats } = PROTOTYPES[kind];
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{name}</h2>
        <p className="text-sm text-muted-foreground">{tagline}</p>
      </div>
      <Details summary={`What this shows, and how each claim is known (${beats.length})`}>
        <ul className="flex flex-col divide-y">
          {beats.map((beat) => {
            const Icon = ICON[beat.proof];
            return (
              <li key={beat.claim} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{beat.claim}</span>
                  <Badge tone={TONE[beat.proof]}>
                    <Icon size={12} /> {PROOF_LABEL[beat.proof]}
                  </Badge>
                </div>
                <span className="text-muted-foreground">
                  {beat.evidence}
                  {beat.proposal !== undefined && dao && (
                    <>
                      {" · "}
                      <a className="underline hover:text-foreground" href={`https://trezu.app/${dao}/requests/${beat.proposal}`} target="_blank" rel="noreferrer">
                        proposal #{beat.proposal}
                      </a>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </Details>
    </Card>
  );
}

const PROTOTYPE_ICON: Record<Kind, typeof HandCoins> = { facilitator: HandCoins, treasury: ChartPieSlice };

/** A card's three strongest claims: shown on mainnet before tested offline. */
const RANK: Partial<Record<Proof, number>> = { mainnet: 0, offline: 1 };
const strongest = (beats: Beat[]) =>
  beats.filter((b) => RANK[b.proof] !== undefined).sort((a, b) => RANK[a.proof]! - RANK[b.proof]!).slice(0, 3);

/**
 * A prototype as the front door shows it: what it is, its strongest claims with how each is known,
 * and how to try it. Claims only, never their evidence: signed out, nothing beyond the chain is shown.
 */
export function PrototypeCard({ kind, open, invoices, status }: { kind: Kind; open?: string; invoices?: string | null; status?: ReactNode }) {
  const { name, tagline, beats, demo } = PROTOTYPES[kind];
  const Icon = PROTOTYPE_ICON[kind];
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icon size={24} />
        <h2 className="font-heading text-2xl font-semibold">{name}</h2>
      </div>
      {status}
      <p className="text-sm text-muted-foreground">{tagline}</p>
      <ul className="flex flex-col gap-2 text-sm">
        {strongest(beats).map((b) => (
          <li key={b.claim} className="flex items-start gap-2">
            {b.proof === "mainnet" ? <CheckCircle size={16} className="mt-0.5 shrink-0 text-success" /> : <Flask size={16} className="mt-0.5 shrink-0 text-info-muted-foreground" />}
            <span>
              {b.claim} <span className="text-muted-foreground">· {PROOF_LABEL[b.proof].toLowerCase()}</span>
            </span>
          </li>
        ))}
      </ul>
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
