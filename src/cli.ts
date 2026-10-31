import { createInterface } from "node:readline/promises";
import { run } from "./commands.ts";
import { config, type Config } from "./config.ts";
import { machine } from "./machine.ts";
import { EXIT } from "./outcome.ts";

/** Results as JSON, one value after another; the SDK parses atomic amounts as bigint, printed as decimal strings. */
const print = (value: unknown) => console.log(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2));

/** An answer at a terminal. Without one, nothing is sent. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await prompt.question(`${question} This moves funds. [y/N] `)).trim()); } finally { prompt.close(); }
}

// Configuration is read when a command first connects, after its arguments are checked.
let target: Config | undefined;
try {
  process.exitCode = await run(process.argv.slice(2), role => machine(target ??= config(), role),
    { print, warn: text => console.error(text), confirm });
} catch (error) {
  // Configuration errors, before anything is sent: a throw once a stream has an event is `unknown` (see `follow`).
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = EXIT.notSent;
}
