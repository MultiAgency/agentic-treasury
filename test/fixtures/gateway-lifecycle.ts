// Run the real gateway with a real, slow-stopping synthetic child, never an executor.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
childProcess.spawn = ((_file: string, _args: string[], options: object) => spawn(process.execPath, ["-e", `
  const fs = require('node:fs');
  process.on('SIGTERM', () => setTimeout(() => {
    fs.writeFileSync('child-stopped', 'done'); process.exit(0);
  }, 300));
  fs.writeFileSync('child-ready', String(process.pid));
  setInterval(() => {}, 1000);
`], options)) as typeof childProcess.spawn;
syncBuiltinESMExports();
await import("../../src/gateway/server.js");
