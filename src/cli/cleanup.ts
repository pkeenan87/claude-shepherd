/**
 * `shepherd cleanup`: CLI adapter for cleaning stale worktrees, merged local/remote branches,
 * closed plan files/ephemeral task logs, dead claims, and `$SHEPHERD_HOME` hygiene.
 */
import type { CommandResult } from "../domain.js";
import { done, fail } from "../orchestrator/context.js";
import { runCleanup, type CleanupOptions } from "../orchestrator/cleanup.js";
import { redact } from "../redact.js";
import type { Workflow } from "../orchestrator/service.js";
import type { CliIo } from "./shepherd.js";

export const CLEANUP_USAGE = `Usage:
  shepherd cleanup [--dry-run] [--worktrees] [--branches] [--plans] [--sessions] [--remote] [--force] [--json]

Without category flags, cleans stale local worktrees, merged local <branchPrefix>/* branches,
closed plan mirrors & ephemeral session files, dead build claims, and expired session notes.
Pass --remote to also prune origin and delete merged remote <branchPrefix>/* branches (confirmation-gated).`;

const ALLOWED_FLAGS = new Set(["--dry-run", "--worktrees", "--branches", "--plans", "--sessions", "--remote", "--force", "--json", "--help", "-h"]);

export function cleanupRemoteReason(command: string): string {
  return `Delete merged remote shepherd branches on origin (\`${command.trim()}\`)? Local main/master are never touched; only merged branches under branchPrefix are deleted.`;
}

export async function cleanupCommand(
  rest: string[],
  io: CliIo,
  open: () => Promise<{ workflow: Workflow; shepherd: string } | { problem: string; code?: string }>,
): Promise<number> {
  const json = rest.includes("--json");
  const emit = (result: CommandResult): number => {
    if (json) {
      io.out(`${JSON.stringify({ ok: result.ok, ...(result.code ? { code: result.code } : {}), text: result.text, ...(result.data !== undefined ? { data: result.data } : {}) }, null, 2)}\n`);
    } else {
      (result.ok ? io.out : io.err)(`${result.text}\n`);
    }
    return result.ok ? 0 : 1;
  };
  if (rest.includes("--help") || rest.includes("-h")) return emit(done(CLEANUP_USAGE));
  const unknown = rest.filter((arg) => !ALLOWED_FLAGS.has(arg));
  if (unknown.length > 0) return emit(fail("USAGE", `Unknown option(s): ${unknown.join(", ")}\n${CLEANUP_USAGE}`));
  const opened = await open();
  if ("problem" in opened) return emit(fail(opened.code ?? "NO_REPO", opened.problem));
  const opts: CleanupOptions = {
    dryRun: rest.includes("--dry-run"),
    worktrees: rest.includes("--worktrees"),
    branches: rest.includes("--branches"),
    plans: rest.includes("--plans"),
    sessions: rest.includes("--sessions"),
    remote: rest.includes("--remote"),
    force: rest.includes("--force"),
    shepherdHome: opened.shepherd,
  };
  try {
    return emit(await opened.workflow.cleanup(opts));
  } catch (error) {
    return emit(fail("ERROR", redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!)));
  }
}

export { runCleanup };
