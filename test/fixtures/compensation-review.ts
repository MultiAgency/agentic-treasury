import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reviewCompensationRequest } from "../../src/compensation-store.js";

// With COMPENSATION_BARRIER=<dir> and COMPENSATION_NAME=<name>, the review transaction reports when it is attempted and
// entered, then holds its decision until <dir>/release exists, so a parent can witness the other review contending.
const barrier = process.env.COMPENSATION_BARRIER, name = process.env.COMPENSATION_NAME;
if (barrier && name) {
  const exec = DatabaseSync.prototype.exec;
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  DatabaseSync.prototype.exec = function (sql: string) {
    const review = /^BEGIN( IMMEDIATE| DEFERRED)?$/.test(sql.trim());
    if (review) writeFileSync(join(barrier, `${name}.attempt`), "");
    const result = exec.call(this, sql);
    if (review) {
      writeFileSync(join(barrier, `${name}.entered`), "");
      while (!existsSync(join(barrier, "release"))) sleep(20);
    }
    return result;
  };
}
try {
  const result = reviewCompensationRequest("owner.near", JSON.parse(process.argv[2]!));
  console.log(JSON.stringify({ state: result.state }));
  if (process.argv[3] === "crash-after-commit") process.kill(process.pid, "SIGKILL");
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
