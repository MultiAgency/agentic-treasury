import { closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";

/**
 * Appends one JSON line and syncs it to disk before returning; throws if it can't. After a crash
 * mid-append the file ends without a newline: this line then starts its own, so only the torn line
 * is lost, never the complete one written after it.
 */
export function appendSynced(path: string, line: object) {
  const fd = openSync(path, "a+");
  try {
    const { size } = fstatSync(fd);
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(line)}\n`);
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
