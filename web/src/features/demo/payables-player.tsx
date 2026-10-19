import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, CheckCircle, FileText, Hand, Pause, Play, ShieldCheck, Sparkle, Users } from "@phosphor-icons/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { GuideEvent, allowedChoices, choiceLabels, nextStage, sceneFor, type GuideChoice, type GuideRequest, type Scene, type SimulationStage } from "../../../../src/payables-guide";
import { useAgent } from "../../app/agent-context";
import { client } from "../../shared/client";
import { Field, FieldGroup } from "../../shared/form";
import { Badge, Button, Details, Spinner } from "../../shared/ui";
import { SigningWalkthrough } from "./signing-walkthrough";

type Mode = "watch" | "try" | "live";
const chapters = ["Agreement", "Invoice", "Owner decision", "Outcome"];
const chapterOf = (stage: SimulationStage) => stage === "agreement" ? 0 : stage === "invoice" ? 1 : stage === "approval" ? 2 : 3;
const outcomeText: Record<SimulationStage, string> = {
  agreement: "No invoice filed", invoice: "Held for owner approval", approval: "Held for owner approval",
  submitted: "Approval recorded · payment not confirmed", settled: "Sample provider outcome: success",
  rejected: "Sample approval rejected · not paid", unresolved: "Payment outcome unknown · new sends blocked",
};

function Facts({ rows }: { rows: [string, string][] }) {
  return <dl className="flex flex-col divide-y">{rows.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-3 py-3">
    <dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-sm font-medium">{value}</dd>
  </div>)}</dl>;
}

/** Catalog-owned facts and controls. Generated prose never supplies a payment or signing payload. */
function Panel({ panel, stage, live, role }: { panel: Scene["panels"][number]; stage: SimulationStage; live: boolean; role: GuideRequest["role"] }) {
  const titles = { agreement: "The agreement", invoice: "Alex’s invoice", signature: "What the owner authorizes", outcome: "Follow this payment", roles: "Who acts next", policy: "The permission behind the payment" };
  const icons = { agreement: Users, invoice: FileText, signature: ShieldCheck, outcome: CheckCircle, roles: Users, policy: ShieldCheck };
  const Icon = icons[panel];
  return <Card>
    <CardHeader>
      <div className="flex items-center justify-between gap-3"><Icon size={24} aria-hidden="true" /><Badge tone={live ? "info" : "neutral"}>{live ? "Explanation" : "Fictional example"}</Badge></div>
      <CardTitle asChild><h3>{titles[panel]}</h3></CardTitle>
      {panel === "agreement" && <CardDescription>Terms agreed before a payment is requested.</CardDescription>}
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      {panel === "agreement" && <><p className="font-heading text-2xl font-medium">A design delivery, agreed.</p><Facts rows={[["Contributor", "Alex · fictional"], ["Invoice ceiling", "40 USDC · sample"], ["Work", "Design delivery"], ["Deadline", "Within 30 days · sample"]]} /></>}
      {panel === "invoice" && <><p className="font-heading text-4xl font-medium tabular-nums">25 <span className="text-xl">USDC</span></p><Facts rows={[["Reference", "DEMO-104 · sample only"], ["Contributor", "Alex · fictional"], ["Work", "Design delivery"], ["Amount check", "Within the sample 40 USDC ceiling"]]} /><p className="text-sm text-muted-foreground">The sample payout is confidential and held for owner approval.</p></>}
      {panel === "signature" && <>
        <p className="text-lg font-medium">{live ? "Review the exact request before signing." : "Release this sample held payout."}</p>
        {!live && <Facts rows={[["Payee", "Alex · fictional"], ["Amount", "25 USDC · sample"], ["Purpose", "Design delivery"], ["Decision", "Approve or reject this held payout"]]} />}
        <p className="text-sm">A wallet owner reviews and signs in their wallet. A DAO owner acts through its proposals, votes and threshold.</p>
        <p className="text-sm text-muted-foreground">{live ? "The real approval view supplies the exact prepared payload. This explanation is not a message to sign." : "Illustrative approval summary only. No wallet opens and no signature is produced in this rehearsal."} Approval does not establish settlement.</p>
      </>}
      {panel === "outcome" && <>
        <Badge tone={stage === "settled" ? "success" : stage === "unresolved" ? "warning" : "neutral"}>{stage === "settled" ? "Simulated success" : stage === "unresolved" ? "Simulated unknown" : "Simulation"}</Badge>
        <p className="text-xl font-medium">{outcomeText[stage]}</p>
        <Facts rows={[["Payment reference", "DEMO-104 · same sample throughout"], ["Real funds moved", "None"]]} />
        <p className="text-sm text-muted-foreground">{stage === "unresolved" ? "Keep this identity. Review retained records before any new send; never infer failure from a missing response." : "In live mode, the provider’s retained evidence determines the outcome. Animation and approval never prove settlement."}</p>
      </>}
      {panel === "roles" && <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li><strong>Contributor</strong> files the invoice through the contributor link.</li>
        <li><strong>Executor</strong> submits within the owner-signed policy and live grant.</li>
        <li><strong>Owner</strong> reviews the held payout and approves or rejects it.</li>
        <li><strong>Provider evidence</strong> establishes the payment’s outcome.</li>
      </ol>}
      {panel === "roles" && live && <p className="text-sm text-muted-foreground">{role === "approve-only" ? "This host is approve-only. Share the contributor link and review the held payout here; that is the expected flow." : role === "executor" ? "This instance is the executor. Existing review controls still determine what your account can do." : "This instance’s role is unconfirmed. Check the real controls below."}</p>}
      {panel === "policy" && <div className="flex flex-col gap-4 text-sm">
        <p><strong>Policy:</strong> the owner-signed limits on actions, assets, amounts and destinations.</p>
        <p><strong>Grant:</strong> permission for the executor to act for this purpose, within those limits.</p>
        <p><strong>Approval:</strong> the owner’s separate decision on this held payout.</p>
        <p className="text-muted-foreground">An agreement records terms. It does not replace the signed policy or authorize a payment on its own.</p>
      </div>}
    </CardContent>
  </Card>;
}

export function PayablesPlayer() {
  const { setup, data } = useAgent();
  const [mode, setMode] = useState<Mode>("watch");
  const [history, setHistory] = useState<SimulationStage[]>(["agreement"]);
  const [playing, setPlaying] = useState(false);
  const [liveMounted, setLiveMounted] = useState(false);
  const [question, setQuestion] = useState("");
  const [detour, setDetour] = useState<Scene>();
  const [generated, setGenerated] = useState<{ key: string; event: ReturnType<typeof GuideEvent.parse> }>();
  const [generationError, setGenerationError] = useState("");
  const revision = useRef(0);
  const request = useRef<AbortController | null>(null);
  const stageTitle = useRef<HTMLHeadingElement>(null);
  const realControls = useRef<HTMLDivElement>(null);
  const stage = history.at(-1)!;
  const role = setup.executor === true ? "executor" : setup.executor === false ? "approve-only" : "unknown";
  const context: Omit<GuideRequest, "question"> = { mode: mode === "live" ? "live" : "rehearsal", stage: mode === "live" ? "live" : stage, role };
  const contextKey = `${data.agentId}:${mode}:${stage}:${role}`;
  const scene = generated?.key === contextKey ? generated.event.value.scene : detour ?? sceneFor(context.stage);
  const isGenerated = generated?.key === contextKey;
  const generation = useMutation({
    mutationFn: async ({ input, signal }: { input: GuideRequest; key: string; version: number; signal: AbortSignal }) => GuideEvent.parse(await client.demoGuide.compose(input, { signal })),
    onSuccess: (event, variables) => {
      if (revision.current !== variables.version) return;
      if (event.value.mode !== variables.input.mode || event.value.stage !== variables.input.stage || event.value.role !== variables.input.role || event.value.source !== "model") {
        setGenerationError("The AI response did not match this scene. The scripted guide remains available."); return;
      }
      setGenerated({ key: variables.key, event }); setDetour(undefined);
    },
    onError: (_error, variables) => {
      if (revision.current === variables.version) setGenerationError("AI guidance is unavailable or could not be verified. You can continue the scripted walkthrough, or try your question again.");
    },
  });
  const clearGeneration = () => {
    revision.current++; request.current?.abort(); setGenerated(undefined); setGenerationError(""); setDetour(undefined); generation.reset();
  };
  useEffect(() => () => { revision.current++; request.current?.abort(); }, []);
  const changeMode = (value: string) => {
    if (!value || value === mode) return;
    clearGeneration(); setPlaying(false); setMode(value as Mode);
    if (value === "live") setLiveMounted(true);
  };
  const choose = (choice: GuideChoice) => {
    if (!allowedChoices(context).includes(choice)) return;
    setPlaying(false); clearGeneration();
    if (choice === "policy" || choice === "supplier" || choice === "signing") {
      setDetour({ title: choice === "policy" ? "Three permissions, three different jobs." : choice === "supplier" ? "Follow the contributor’s side." : "Know what your signature authorizes.", narration: choice === "supplier" ? "The contributor files an invoice; the owner reviews the held payout. Each person keeps their own account and responsibilities." : "The explanation helps you review. The application and provider still verify every real action.", layout: "focus", panels: [choice === "policy" ? "policy" : choice === "supplier" ? "roles" : "signature"], choices: [] });
    } else if (mode !== "live") {
      const next = nextStage(stage, choice);
      setHistory(previous => choice === "restart" ? ["agreement"] : next === stage ? previous : [...previous, next]);
      setMode("try");
    }
    requestAnimationFrame(() => stageTitle.current?.focus());
  };
  const ask = (text: string) => {
    if (!text.trim() || generation.isPending) return;
    setPlaying(false); clearGeneration(); setQuestion(text);
    const controller = new AbortController(); request.current = controller;
    generation.mutate({ input: { ...context, question: text.trim() }, key: contextKey, version: revision.current, signal: controller.signal });
  };
  useEffect(() => {
    if (!playing || mode !== "watch") return;
    if (["settled", "rejected", "unresolved"].includes(stage)) { setPlaying(false); return; }
    const timer = setTimeout(() => {
      if (document.hidden) { setPlaying(false); return; }
      setHistory(previous => [...previous, nextStage(stage, stage === "approval" ? "approve" : "next")]);
    }, stage === "approval" ? 8500 : 6000);
    return () => clearTimeout(timer);
  }, [playing, mode, stage]);
  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);

  return <section aria-label="Interactive Payables demo" className="flex min-w-0 flex-col gap-8">
    <header className="flex flex-col gap-4">
      <h2 className="max-w-2xl font-heading text-3xl font-semibold tracking-tight sm:text-4xl">From good work to a private payment.</h2>
      <p className="max-w-prose text-muted-foreground">Watch it unfold. Take the owner’s seat. Ask the guide to show you another angle.</p>
      <ToggleGroup type="single" variant="outline" value={mode} onValueChange={changeMode} aria-label="Demo mode" className="flex-wrap">
        <ToggleGroupItem value="watch"><Play aria-hidden="true" />Watch</ToggleGroupItem>
        <ToggleGroupItem value="try"><Hand aria-hidden="true" />Try</ToggleGroupItem>
        <ToggleGroupItem value="live"><ShieldCheck aria-hidden="true" />Use my agent</ToggleGroupItem>
      </ToggleGroup>
      <Alert role="note" variant={mode === "live" ? "warning" : "default"}>
        <AlertTitle>{mode === "live" ? "Live · real funds" : "Fictional rehearsal · no funds move"}</AlertTitle>
        <AlertDescription>{mode === "live" ? "Each money action uses the existing review and confirmation controls. The guide never signs or submits for you." : "No wallet signatures or payment calls. Watch plays the sample approval path; Try lets you choose. Reload starts this rehearsal again."}</AlertDescription>
      </Alert>
    </header>

    {mode !== "live" && <div className="flex flex-col gap-4">
      <ol aria-label="Rehearsal chapters" className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{chapters.map((title, index) => <li key={title} aria-current={chapterOf(stage) === index ? "step" : undefined} className={cn("flex items-center gap-2 border-b pb-3", chapterOf(stage) === index ? "border-primary font-medium text-foreground" : "text-muted-foreground")}><span>{index + 1}.</span>{title}</li>)}</ol>
      <div className="flex flex-wrap items-center gap-2">
        {mode === "watch" && <Button variant="outline" disabled={["settled", "rejected", "unresolved"].includes(stage)} onClick={() => { clearGeneration(); setPlaying(value => !value); }}>{playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{playing ? "Pause demo" : "Play demo"}</Button>}
        <Button variant="ghost" disabled={history.length < 2} onClick={() => { setPlaying(false); clearGeneration(); setHistory(previous => previous.slice(0, -1)); }}><ArrowLeft data-icon="inline-start" />Back one scene</Button>
        <Button variant="ghost" onClick={() => { setPlaying(false); clearGeneration(); setHistory(["agreement"]); }}><ArrowCounterClockwise data-icon="inline-start" />Restart</Button>
        {mode === "watch" && <Button variant="ghost" onClick={() => changeMode("try")}><Hand data-icon="inline-start" />Let me try</Button>}
        <span role="status" className="text-sm text-muted-foreground">{playing ? "Playing the sample approval path. You can pause at any time." : mode === "try" ? "You choose the next step." : "Ready when you are."}</span>
      </div>
    </div>}

    <div className="grid items-start gap-8 lg:grid-cols-5">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-3">
        <div className="flex flex-col gap-3" aria-live="polite" aria-atomic="true">
          <h3 ref={stageTitle} tabIndex={-1} className="font-heading text-2xl font-medium outline-none">{scene.title}</h3>
          <p className="max-w-prose text-muted-foreground">{scene.narration}</p>
          <p className="text-xs text-muted-foreground">{isGenerated ? "AI-composed explanation · verify real decisions in the review controls" : "Scripted guide · ask AI to reshape this scene"}</p>
        </div>
        <div className={cn("grid min-w-0 gap-4", scene.layout === "compare" && "sm:grid-cols-2")}>
          {scene.panels.map(panel => <Panel key={`${contextKey}:${panel}`} panel={panel} stage={stage} live={mode === "live"} role={role} />)}
        </div>
        <div className="flex flex-wrap gap-3" aria-label="Suggested next actions">
          {scene.choices.filter(choice => allowedChoices(context).includes(choice)).map((choice, index) => choice === "payments" || choice === "agreements"
            ? <Button key={choice} variant="outline" asChild><Link to={choice === "payments" ? "/workspace" : "/payees"}>{choiceLabels[choice]}</Link></Button>
            : <Button key={choice} variant={index === 0 && !playing ? "default" : "outline"} onClick={() => choose(choice)}>{choiceLabels[choice]}{choice === "next" && <ArrowRight data-icon="inline-end" />}</Button>)}
          {detour && <Button variant="outline" onClick={() => setDetour(undefined)}>Back to this scene</Button>}
        </div>
      </div>

      <aside aria-label="Ask the walkthrough guide" className="flex min-w-0 flex-col gap-5 border-t pt-6 lg:col-span-2 lg:border-t-0 lg:pt-0">
        <div className="flex items-center gap-2"><Sparkle size={22} aria-hidden="true" /><h3 className="text-lg font-medium">Make the guide yours</h3></div>
        <p className="text-sm text-muted-foreground">Ask a question and AI will compose an explanation and choose the views that help. Only your question and this guide’s mode, scene and role are sent; live records are not attached.</p>
        <form onSubmit={event => { event.preventDefault(); ask(question); }} className="flex flex-col gap-3">
          <FieldGroup><Field label="Ask about this step" value={question} onChange={event => setQuestion(event.target.value)} maxLength={800} placeholder="What exactly am I approving?" disabled={generation.isPending} /></FieldGroup>
          <Button variant="outline" type="submit" disabled={generation.isPending || !question.trim()}>{generation.isPending ? <Spinner /> : <Sparkle data-icon="inline-start" />}{generation.isPending ? "Composing your scene…" : "Ask AI guide"}</Button>
        </form>
        <div className="flex flex-col items-start gap-2">
          {["Show me who acts next", "Explain the policy and grant side by side", "What does the owner sign?"].map(prompt => <Button key={prompt} variant="ghost" className="h-auto min-h-11 max-w-full justify-start whitespace-normal text-left" disabled={generation.isPending} onClick={() => ask(prompt)}>{prompt}</Button>)}
        </div>
        {generationError && <Alert variant="warning"><AlertTitle>Keep going with the scripted guide</AlertTitle><AlertDescription>{generationError}</AlertDescription></Alert>}
        {isGenerated && <Button variant="ghost" onClick={clearGeneration}>Return to scripted scene</Button>}
        <Details summary="How this guide works"><p>AI chooses from a bounded set of views and suggested actions. The application supplies sample facts and real review controls. Generated text is explanatory; it is not policy, authority or payment evidence.</p><p>AI requests use this agent’s configured NEAR AI Cloud connection. If generation or verification fails, the scripted guide stays available.</p></Details>
      </aside>
    </div>

    {mode === "live" && <Button variant="outline" className="self-start" onClick={() => { realControls.current?.scrollIntoView({ behavior: "instant", block: "start" }); realControls.current?.focus(); }}>Show my real review controls</Button>}
    {/* Once opened, keep existing confirmations, stream state and exact selections mounted. */}
    {liveMounted && <div ref={realControls} tabIndex={-1} hidden={mode !== "live"} className="border-t pt-8"><SigningWalkthrough workflow="payables" short /></div>}
  </section>;
}
