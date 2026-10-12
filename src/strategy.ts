import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { ENV_FILE } from "./env.js";
import { canonical } from "./mandate.js";
import { ASSETS } from "./policy.js";

/**
 * The owner's strategy mandate: what the agent aims for and how much it may do alone, beside the
 * policy the wallet enforces. The policy can't express targets, costs or an auto-execute ceiling, so
 * this server enforces them, and its digest says which mandate the agent ran under. One file per
 * instance, `.strategy/<settings file>.json`; without one, the defaults below apply.
 *
 * A grant's label is signed by the owner, so a grant labelled `<kind>:<strategyLabelSuffix>` is the
 * owner's approval of exactly this mandate (`grantApproves`). Every number is an integer, so the
 * canonical form, and the digest, is the same in any language.
 */

const asset = z.enum(Object.values(ASSETS) as [string, ...string[]]);

const Strategy = z.object({
  /** Each asset's share of the book's USD value, in basis points; they add up to 10 000. */
  targetBps: z
    .record(asset, z.number().int().min(0).max(10_000))
    .refine((t) => Object.values(t).reduce((sum, bps) => sum + bps, 0) === 10_000, "targets must add up to 10 000 bps"),
  /** Drift below this is left alone: not worth a fee, and likely under the route minimum. */
  minLegUsd: z.number().int().min(1),
  /**
   * Most a swap may lose, in basis points of its input value, measured at its guaranteed floor: fees,
   * price impact and the slippage the floor allows (the API sets it about 1% under the quote).
   */
  maxCostBps: z.number().int().min(1).max(1_000),
  autopilot: z.object({
    /** Minutes between the agent's own runs. */
    everyMin: z.number().int().min(5),
    /** The largest rebalance, in USD, the agent executes without the owner; 0 leaves every swap to the owner. */
    maxUsd: z.number().int().min(0),
  }),
});

export type Strategy = z.infer<typeof Strategy>;

export const DEFAULT_STRATEGY: Strategy = {
  targetBps: { [ASSETS.USDC]: 5_000, [ASSETS.wNEAR]: 2_500, [ASSETS.ETH]: 2_500 },
  minLegUsd: 2,
  maxCostBps: 250,
  autopilot: { everyMin: 60, maxUsd: 0 },
};

export const STRATEGY_FILE = join(".strategy", `${basename(ENV_FILE)}.json`);

/** This instance's strategy, read on use so an edit applies at once; refuses a file that doesn't parse. */
export function loadStrategy(): Strategy {
  if (!existsSync(STRATEGY_FILE)) return DEFAULT_STRATEGY;
  const parsed = Strategy.safeParse(JSON.parse(readFileSync(STRATEGY_FILE, "utf8")));
  if (!parsed.success) throw new Error(`${STRATEGY_FILE}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Replaces this instance's strategy, whole: checked first, then written and renamed over the old file. */
export function saveStrategy(strategy: Strategy) {
  const checked = Strategy.parse(strategy);
  mkdirSync(dirname(STRATEGY_FILE), { recursive: true });
  writeFileSync(`${STRATEGY_FILE}.tmp`, `${JSON.stringify(checked, null, 2)}\n`);
  renameSync(`${STRATEGY_FILE}.tmp`, STRATEGY_FILE);
}

const hex = (strategy: Strategy) => createHash("sha256").update(canonical(strategy), "utf8").digest("hex");

/** The strategy as one reproducible digest, in the policy digest's canonical form. */
export const strategyDigest = (strategy: Strategy) => `sha256:${hex(strategy)}`;

/** What a grant's label carries to approve this strategy: 128 bits of its digest, within the label's 64 characters. */
export const strategyLabelSuffix = (strategy: Strategy) => hex(strategy).slice(0, 32);

/** Whether a grant with this label is the owner's approval of `strategy`. */
export const grantApproves = (label: string, strategy: Strategy) => label.endsWith(`:${strategyLabelSuffix(strategy)}`);
