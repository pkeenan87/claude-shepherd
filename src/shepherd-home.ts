/**
 * The user-wide shepherd home (`$SHEPHERD_HOME`, default `~/.claude/shepherd`): the list of repos shepherd has worked in
 * (so the daily budget covers all of them), per-session hook state, and the once-a-day warning marks.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CostRecord } from "./domain.js";
import { makeDayKey, recordsForDay } from "./cost/ledger.js";
import { atomicWrite, TaskStore, withLock } from "./storage/store.js";

const repoStoreCache = new Map<string, TaskStore>();
function cachedStore(dir: string): TaskStore {
  let store = repoStoreCache.get(dir);
  if (!store) {
    store = new TaskStore(dir);
    repoStoreCache.set(dir, store);
  }
  return store;
}

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
export function dailyRecordsOf(dirs: readonly string[], now: Date, timeZone?: string): CostRecord[] {
  const out: CostRecord[] = [];
  const dayKey = makeDayKey(timeZone);
  for (const dir of new Set(dirs.map((item) => path.resolve(item)))) {
    try {
      if (existsSync(dir)) out.push(...recordsForDay(cachedStore(dir).readLedger(), now, dayKey));
    } catch {
      /* unreadable: skipped */
    }
  }
  return out;
}

/** Removes entries in `repos.json` whose directories no longer exist on disk. Returns removed paths. */
export async function pruneMissingRepos(shepherd: string): Promise<string[]> {
  const removed: string[] = [];
  try {
    await withLock(path.join(shepherd, "repos.lock"), () => {
      const known = registeredRepos(shepherd);
      const keep: string[] = [];
      for (const dir of known) {
        if (existsSync(dir)) keep.push(dir);
        else {
          removed.push(dir);
          repoStoreCache.delete(dir);
        }
      }
      if (removed.length > 0) atomicWrite(reposFile(shepherd), JSON.stringify(keep, null, 2));
    });
  } catch {
    /* best-effort */
  }
  return removed;
}

/** Removes session hook state files older than `maxAgeDays` (default 7). Returns count removed. */
export function pruneOldSessions(shepherd: string, now: Date, maxAgeDays = 7): number {
  const dir = path.join(shepherd, "sessions");
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) {
          rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        /* ignore concurrent removal */
      }
    }
  } catch {
    /* ignore unreadable dir */
  }
  return removed;
}

export const sessionFile = (shepherd: string, sessionId: string, kind: "" | ".pending" | ".compact" = "") => path.join(shepherd, "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}${kind}.json`);

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
