// Checks a backup copy of an executor's state with this candidate's operation-journal reader before a release: every
// `.ops/<agent>.jsonl` (with its invoice SQLite) must read cleanly, or sends would refuse after the deploy.
// The backup is copied to a temporary directory first, so the reader never writes to it.
// Usage: pnpm journal:check <backup state directory>   (the directory that holds .ops/ and .invoices/)
// Exit 0: every journal reads; exit 1: at least one is invalid (the line and reason are printed).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

if (process.env.JOURNAL_CHECK_AGENT) {
  // Child: one agent, cwd is the temporary copy.
  const { blocksDispatch, readOps } = await import("../src/ops.js");
  try {
    const ops = readOps();
    console.log(JSON.stringify({ agent: process.env.JOURNAL_CHECK_AGENT, ok: true, operations: ops.length, blocking: ops.filter(blocksDispatch).length }));
  } catch (error) {
    console.log(JSON.stringify({ agent: process.env.JOURNAL_CHECK_AGENT, ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
} else {
  const source = process.argv[2] && resolve(process.argv[2]);
  if (!source || !existsSync(join(source, ".ops"))) { console.error("Usage: pnpm journal:check <backup state directory containing .ops/>"); process.exit(2); }
  const copy = mkdtempSync(join(tmpdir(), "journal-check-"));
  try {
    cpSync(source, copy, { recursive: true });
    const agents = readdirSync(join(copy, ".ops")).filter(f => f.endsWith(".jsonl")).map(f => basename(f, ".jsonl"));
    let failed = agents.length === 0;
    if (failed) console.log(JSON.stringify({ ok: false, error: "no .ops/<agent>.jsonl journal in the backup" }));
    for (const agent of agents) {
      const child = spawnSync(join(import.meta.dirname, "../node_modules/.bin/tsx"), [import.meta.filename], { cwd: copy, encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, JOURNAL_CHECK_AGENT: agent, AGENT_ID: agent } });
      process.stdout.write(child.stdout || `${JSON.stringify({ agent, ok: false, error: child.stderr.trim().split("\n").at(-1) })}\n`);
      if (child.status !== 0) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  } finally { rmSync(copy, { recursive: true, force: true }); }
}
