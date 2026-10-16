import { reviewCompensationRequest } from "../../src/compensation-store.js";
try {
  const result = reviewCompensationRequest("owner.near", JSON.parse(process.argv[2]!));
  console.log(JSON.stringify({ state: result.state }));
  if (process.argv[3] === "crash-after-commit") process.kill(process.pid, "SIGKILL");
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
