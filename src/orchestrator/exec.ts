import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitWorkspace } from "../git/workspace.js";
import type { CheckRunner } from "../review/review.js";
import { atomicWrite, withLock } from "../storage/store.js";

const exec = promisify(execFile);
const MAX_CACHED_CHECKS = 200;
const CHECK_CACHE_TTL_MS = 24 * 60 * 60_000;
/** Output a check may print before it is stopped. A test suite's log fits; a runaway loop does not. */
const CHECK_MAX_BUFFER = 64 * 1024 * 1024;
/** A check that runs longer than this is stopped and fails, so a hung check cannot stall /review or /build. */
export const CHECK_TIMEOUT_MS = 30 * 60_000;

/** Runs a command with execFile and reports its exit code instead of throwing. */
export const defaultRunner: CheckRunner = {
  async run(command, args, cwd) {
    try {
      const { stdout, stderr } = await exec(command, args, { cwd, encoding: "utf8", maxBuffer: CHECK_MAX_BUFFER, timeout: CHECK_TIMEOUT_MS });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number | string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string };
      // Say why a check was stopped, so the failure is not read as a test failure.
      const why =
        failed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? `\n[shepherd: stopped after ${CHECK_MAX_BUFFER / 1024 / 1024} MB of output]`
          : failed.killed && failed.signal
            ? `\n[shepherd: stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes (${failed.signal})]`
            : "";
      return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: `${failed.stderr ?? ""}${why}` };
    }
  },
};

/** Tree sha of a clean checkout, or undefined when it is dirty or not a git directory. */
async function cleanTree(git: GitWorkspace, cwd: string): Promise<string | undefined> {
  const status = await git.git(["status", "--porcelain"], cwd);
  if (status.code !== 0 || status.stdout.trim()) return undefined;
  const tree = await git.git(["rev-parse", "HEAD^{tree}"], cwd);
  return tree.code === 0 ? tree.stdout.trim() : undefined;
}

interface PersistedCheckCache {
  entries: Record<string, { at: number; stdout: string }>;
}

function readDiskCache(file: string | undefined, now: number): Map<string, { at: number; stdout: string }> {
  const map = new Map<string, { at: number; stdout: string }>();
  if (!file || !existsSync(file)) return map;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedCheckCache>;
    if (!parsed.entries || typeof parsed.entries !== "object") return map;
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (v && typeof v.at === "number" && typeof v.stdout === "string" && now - v.at <= CHECK_CACHE_TTL_MS) {
        map.set(k, v);
      }
    }
  } catch {
    /* ignore corrupt cache */
  }
  return map;
}

/** Lightweight checkout environment fingerprint so worktrees without dependencies or changed toolchains never reuse a cached pass. */
function envStamp(cwd: string): string {
  const parts = [path.resolve(cwd), process.version];
  for (const rel of ["node_modules", ".venv", "target"]) {
    try {
      const st = statSync(path.join(cwd, rel));
      parts.push(`${rel}:${Math.floor(st.mtimeMs)}`);
    } catch {
      /* absent */
    }
  }
  return parts.join("|");
}

async function persistCacheEntry(
  file: string | undefined,
  key: string,
  entry: { at: number; stdout: string },
  nowMs: number,
): Promise<void> {
  if (!file) return;
  try {
    await withLock(`${file}.lock`, () => {
      const merged = readDiskCache(file, nowMs);
      if (merged.size >= MAX_CACHED_CHECKS) merged.clear();
      merged.set(key, entry);
      const entries: PersistedCheckCache["entries"] = {};
      for (const [k, v] of merged) entries[k] = v;
      atomicWrite(file, JSON.stringify({ entries }, null, 2));
    });
  } catch {
    /* best-effort cache */
  }
}

/** Skips re-running a check that already passed on an identical clean tree in the same checkout/env (optionally persisted across CLI runs). */
export function cachingRunner(git: GitWorkspace, runner: CheckRunner, cacheFile?: string, now: () => number = () => Date.now()): CheckRunner {
  const passed = readDiskCache(cacheFile, now());
  return {
    run: async (command, args, cwd) => {
      const tree = await cleanTree(git, cwd);
      const key = tree ? `${envStamp(cwd)}\u0000${tree}\u0000${command}\u0000${args.join("\u0000")}` : undefined;
      const currentNow = now();
      const cached = key ? passed.get(key) : undefined;
      if (cached && currentNow - cached.at <= CHECK_CACHE_TTL_MS) return { code: 0, stdout: cached.stdout, stderr: "" };
      const result = await runner.run(command, args, cwd);
      if (key && result.code === 0) {
        const entry = { at: now(), stdout: `cached: passed earlier on identical tree ${tree}\n${result.stdout.slice(0, 1000)}` };
        if (passed.size >= MAX_CACHED_CHECKS) passed.clear();
        passed.set(key, entry);
        await persistCacheEntry(cacheFile, key, entry, entry.at);
      }
      return result;
    },
  };
}
