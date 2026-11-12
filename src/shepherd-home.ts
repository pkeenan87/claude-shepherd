/**
 * The user-wide shepherd home (`$SHEPHERD_HOME`, default `~/.claude/shepherd`): the list of repos shepherd has worked in
 * (so the daily budget covers all of them), per-session hook state, and the once-a-day warning marks.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CostRecord } from "./domain.js";
import { recordsForDay } from "./cost/ledger.js";
import { atomicWrite, TaskStore, withLock } from "./storage/store.js";

export function shepherdHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.SHEPHERD_HOME || path.join(home, ".claude", "shepherd");
}

const reposFile = (shepherd: string) => path.join(shepherd, "repos.json");

/** Absolute workspace dirs of the registered repos. A missing or unreadable file is none. */
export function registeredRepos(shepherd: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(reposFile(shepherd), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && path.isAbsolute(item)) : [];
  } catch {
    return [];
  }
}

/** Adds a workspace dir to `repos.json` (no repeats, atomic write, under a lock). Never throws. */
export async function registerRepo(shepherd: string, workspaceDir: string): Promise<void> {
  try {
    await withLock(path.join(shepherd, "repos.lock"), () => {
      const known = registeredRepos(shepherd);
      const dir = path.resolve(workspaceDir);
      if (known.includes(dir)) return;
      atomicWrite(reposFile(shepherd), JSON.stringify([...known, dir], null, 2));
    });
  } catch {
    /* the daily budget then covers fewer repos; nothing else depends on it */
  }
}

/** Today's records from the ledger of every workspace dir listed (and `extra`), read-only; an unreadable one is skipped. */
export function dailyRecordsOf(dirs: readonly string[], now: Date): CostRecord[] {
  const out: CostRecord[] = [];
  for (const dir of new Set(dirs.map((item) => path.resolve(item)))) {
    try {
      if (existsSync(dir)) out.push(...recordsForDay(new TaskStore(dir).readLedger(), now));
    } catch {
      /* unreadable: skipped */
    }
  }
  return out;
}

export const sessionFile = (shepherd: string, sessionId: string, kind: "" | ".pending" = "") => path.join(shepherd, "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}${kind}.json`);

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, value: unknown): void {
  atomicWrite(file, JSON.stringify(value, null, 2));
}

export function removeFile(file: string): void {
  rmSync(file, { force: true });
}
