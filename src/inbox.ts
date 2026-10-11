import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentId } from "./agent.js";

/**
 * What the agent tells its owner while no one is watching, `.inbox/<agent id>.jsonl`, append-only
 * like the ops log. A `run` entry records one autopilot tick; `warn` and `action` entries ask for the
 * owner and stay open until dismissed.
 */

export type Level = "run" | "warn" | "action";
export type Entry = { id: string; at: string; level: Level; text: string; dismissed?: boolean };

type Line = Omit<Entry, "dismissed"> | { dismiss: string };

const file = () => {
  mkdirSync(".inbox", { recursive: true });
  return join(".inbox", `${agentId()}.jsonl`);
};

export function post(level: Level, text: string): Entry {
  const entry = { id: randomUUID(), at: new Date().toISOString(), level, text };
  appendFileSync(file(), `${JSON.stringify(entry satisfies Line)}\n`);
  return entry;
}

export function dismiss(id: string) {
  appendFileSync(file(), `${JSON.stringify({ dismiss: id } satisfies Line)}\n`);
}

/** Every entry, newest first, with whether the owner dismissed it. */
export function readInbox(): Entry[] {
  const path = file();
  if (!existsSync(path)) return [];
  const entries = new Map<string, Entry>();
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text.trim()) continue;
    const line = JSON.parse(text) as Line;
    if ("dismiss" in line) {
      const entry = entries.get(line.dismiss);
      if (entry) entry.dismissed = true;
    } else entries.set(line.id, { ...line });
  }
  return [...entries.values()].reverse();
}
