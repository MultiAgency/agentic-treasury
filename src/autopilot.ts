import { agentId, LocalRefusal } from "./agent.js";
import { api } from "./api.js";
import { saveEnv } from "./env.js";
import { post, readInbox } from "./inbox.js";
import { liveGrant } from "./intents.js";
import { MoneyLockBusy } from "./lock.js";
import { provenRefusal } from "./ops.js";
import { executePlan } from "./plans.js";
import { context, newTickId, observe, recordEnd, recordStart, type TickEnd, type TickStart } from "./evidence.js";
import { ageMinutes, recover } from "./recover.js";
import { grantApproves, loadStrategy, saveStrategy, type Strategy, strategyLabelSuffix } from "./strategy.js";
import { rebalance, sweep } from "./treasury.js";

/**
 * The agent working on its own: each tick sweeps public balances into the confidential one, then
 * previews a rebalance and executes it only if its swaps are worth no more than the owner's
 * auto-execute limit. A larger plan becomes an inbox item asking the owner to preview it: plans
 * expire in minutes, so none is left waiting. Every step is the same code the dashboard runs, under
 * the same lock, plan checks and policy; the policy's caps and budget stay the hard boundary.
 *
 * Off until the owner turns it on, and with a limit of $0 by default: shields can run under the
 * authorized strategy, while swaps wait for the owner. Every send requires the strategy the
 * owner signed: this server's live grant must carry its digest in its label (`grantApproves`), so
 * editing the strategy file changes nothing the agent does alone until the owner signs a new grant.
 */

/** `everyMin` and `maxUsd` (whole dollars) are part of the strategy, inside its digest; on/off is not: turning off is always safe. */
export type Settings = { on: boolean } & Strategy["autopilot"];

export const MIN_EVERY_MIN = 5;

export function settings(): Settings {
  return { on: process.env.AUTOPILOT === "on", ...loadStrategy().autopilot };
}

export function saveSettings({ on, everyMin, maxUsd }: Settings) {
  saveStrategy({ ...loadStrategy(), autopilot: { everyMin, maxUsd } });
  saveEnv({ AUTOPILOT: on ? "on" : "" });
}

const lastRun = () => readInbox().find((e) => e.level === "run")?.at ?? null;

export function status() {
  const s = settings();
  const last = lastRun();
  const next = s.on ? new Date(Math.max(Date.now(), (last ? new Date(last).getTime() : 0) + s.everyMin * 60_000)).toISOString() : null;
  return { ...s, lastRun: last, nextRun: next };
}

/** Whether this server's live grant is the owner's approval of the strategy in force. */
async function mandateApproved() {
  const grant = liveGrant(await api.listGrants(agentId()), process.env.AGENT_GRANT_TOKEN);
  return grant !== undefined && grantApproves(grant.label, loadStrategy());
}

let running = false;

type Found = Pick<TickEnd, "plan" | "steps" | "shields" | "rejected" | "refusal">;

/**
 * One tick, never two at once: a scheduled tick and "Run now" share this guard. Every tick, skipped
 * ones included, writes a start and an end evidence line (src/evidence.ts). A tick whose start can't
 * be written doesn't run: unrecorded work is never done. A missing end means interrupted or unknown.
 */
export async function tick(trigger: TickStart["trigger"]): Promise<string> {
  const id = newTickId();
  const at = new Date().toISOString();
  const found: Found = { plan: null, steps: [], shields: [], rejected: [], refusal: null };
  const schedule = { ...settings(), lastRun: lastRun() };
  // Claimed before the first await, so two ticks can't both pass.
  const busy = running;
  running = true;
  try {
    try {
      recordStart({ id, at, trigger, schedule, ...(await context()) });
    } catch (error) {
      const outcome = `Not run: the tick's evidence could not be recorded (${error instanceof Error ? error.message : String(error)}).`;
      post("warn", outcome);
      return outcome;
    }
    const end = (outcome: string, before: TickEnd["before"], after: TickEnd["after"]) => {
      try {
        recordEnd({ id, endedAt: new Date().toISOString(), before, after, ...found, outcome });
      } catch (error) {
        post("warn", `Tick ${id} ran, but its evidence end could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
      return outcome;
    };
    if (busy) return end("Skipped: a tick is already running.", { error: "another tick was running" }, { error: "another tick was running" });
    const before = await observe();
    const outcome = await run(found);
    return end(outcome, before, await observe());
  } finally {
    if (!busy) running = false;
  }
}

/** What a tick does, also recorded in the inbox. */
async function run(found: Found): Promise<string> {
  const { maxUsd } = settings();
  const done = (text: string) => post("run", text).text;
  try {
    const { policy } = await api.getPolicy(agentId());
    if (!policy) return done("Skipped: the agent's policy is not applied yet.");
    if (policy.frozen) return done("Skipped: the agent is frozen.");
    // Reads the status of each action without a proven outcome; resends nothing, which is a person's call.
    // A payout held for the owner's approval can't be lost and never blocks, as in the money lock.
    const stuck = (await recover()).filter((r) => r.outcome !== "settled" && r.outcome !== "refused" && r.status !== "PENDING_APPROVAL");
    if (stuck.length > 0) {
      const list = stuck.map((r) => `${r.op.idempotencyKey} (${r.outcome}, ${ageMinutes(r.op)} min old)`).join(", ");
      post("warn", `Money actions without a proven outcome: ${list}. Check them under Activity; the autopilot waits until then.`);
      return done("Skipped: unresolved money actions.");
    }

    const report: string[] = [];
    // Every send, a sweep's shield included, needs the owner's grant for the strategy in force.
    const approved = await mandateApproved();
    if (!approved) report.push("sweep left for the owner: the owner's grant doesn't approve this strategy");
    else for await (const event of sweep({ execute: true })) {
      if (event.type !== "shield") continue;
      report.push(`shielded ${event.asset}: ${event.status}`);
      found.shields.push({ asset: event.asset, status: event.status, correlationId: event.correlationId });
      if (event.status !== "SUCCESS") post("warn", `A sweep shield of ${event.asset} ended ${event.status} (${event.correlationId}).`);
    }

    if (policy.actions.includes("swap")) {
      let usd = 0;
      let planId: string | undefined;
      let legs: { usd: number }[] = [];
      for await (const event of rebalance()) {
        if (event.type === "plan") legs = event.legs;
        if (event.type === "saved") {
          planId = event.plan.id;
          found.plan = { id: event.plan.id, usd: 0, legs: event.plan.actions.flatMap((a) => a.type === "swap"
            ? [{ from: a.from, to: a.to, amount: a.amount, amountOut: a.amountOut, minAmountOut: a.minAmountOut, costBps: a.costBps }] : []) };
          usd = legs.reduce((sum, leg, i) => sum + (event.steps[i] === undefined ? 0 : leg.usd), 0);
          found.plan.usd = usd;
        }
      }
      if (!planId) report.push("book on target");
      else if (usd > maxUsd) {
        post("action", `A rebalance of $${usd.toFixed(2)} is above the $${maxUsd.toFixed(2)} auto-execute limit. Preview and execute it from Automations.`);
        report.push(`rebalance of $${usd.toFixed(2)} left for the owner`);
      } else if (!approved) {
        post(
          "action",
          `A rebalance of $${usd.toFixed(2)} is within the limit, but the owner's grant doesn't approve the strategy in force. Issue a new grant from Policy: its label, treasury:${strategyLabelSuffix(loadStrategy())}, approves it.`,
        );
        report.push(`rebalance of $${usd.toFixed(2)} left for the owner: the owner's grant doesn't approve this strategy`);
      } else {
        for await (const event of executePlan(planId, undefined, { autopilot: true })) {
          if (event.type === "rejected") {
            found.rejected.push(...event.problems);
            report.push(`rebalance not executed: ${event.problems.join("; ")}`);
            continue;
          }
          found.steps.push({ index: event.index, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode ?? null });
          report.push(`step ${event.index + 1}: ${event.status}`);
          if (event.status !== "SUCCESS") post("warn", `Autopilot step ${event.index + 1} ended ${event.status} (${event.correlationId || "no correlation id"}).`);
        }
      }
    }
    return done(report.length ? report.join(", ") : "Nothing to do.");
  } catch (error) {
    if (error instanceof MoneyLockBusy) return done("Skipped: another money action was running.");
    found.refusal = error instanceof LocalRefusal ? error.code : provenRefusal(error) ?? null;
    const message = error instanceof Error ? error.message : String(error);
    post("warn", `The autopilot stopped: ${message}`);
    return done(`Failed: ${message}`);
  }
}

let timer: NodeJS.Timeout | undefined;

/** Checks every minute whether a tick is due, so settings saved from the dashboard apply at once. */
export function startAutopilot() {
  timer ??= setInterval(() => {
    const { on, nextRun } = status();
    if (on && nextRun && new Date(nextRun).getTime() <= Date.now()) void tick("schedule");
  }, 60_000);
  timer.unref();
}
