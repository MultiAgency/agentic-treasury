import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

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
