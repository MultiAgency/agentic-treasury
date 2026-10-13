import { CheckCircle, Flask, Info, MinusCircle, Scroll } from "@phosphor-icons/react";
import { type Kind, type Proof, PROOF_LABEL, PROTOTYPES } from "./beats";
import { Badge, Card, Details, type Tone } from "./ui";

const TONE: Record<Proof, Tone> = { mainnet: "success", offline: "info", design: "neutral", "provider-docs": "warning", "not-applicable": "neutral" };
const ICON: Record<Proof, typeof CheckCircle> = { mainnet: CheckCircle, offline: Flask, design: Info, "provider-docs": Scroll, "not-applicable": MinusCircle };

/** What this prototype shows and how each claim is known (beats.ts): only for signed-in viewers. */
export function WhatThisShows({ kind }: { kind: Kind }) {
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
                <span className="text-muted-foreground">{beat.evidence}</span>
              </li>
            );
          })}
        </ul>
      </Details>
    </Card>
  );
}
