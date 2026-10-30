import { config, token } from "./config.ts";
import { machine } from "./machine.ts";
import { EXIT } from "./outcome.ts";
import { status } from "./status.ts";

const USAGE = "Usage: treasury status";

/** Results as JSON; the SDK parses atomic amounts as bigint, printed as decimal strings. */
const print = (value: unknown) => console.log(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2));

async function main(command: string | undefined): Promise<number> {
  switch (command) {
    case "status": {
      const { report, code } = await status(machine(config(), token("propose"), ["read"]));
      print(report);
      return code;
    }
    default:
      console.error(USAGE);
      return EXIT.notSent;
  }
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (error) {
  // Configuration and usage errors, before anything is sent.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = EXIT.notSent;
}
