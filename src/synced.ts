import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";

/** Appends one JSON line and syncs it to disk before returning; throws if it can't. */
export function appendSynced(path: string, line: object) {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces a file whole: written beside it, then renamed over it, so a crash mid-write leaves the
 * previous version, never a truncated one. `mode` applies to the new file.
 */
export function writeAtomic(path: string, text: string, mode?: number) {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true }); // a leftover from a crash would keep its own mode
  writeFileSync(tmp, text, { mode, flush: true });
  renameSync(tmp, path);
}
