import { WorkflowError, type CommandResult, type CostRecord, type Phase, type TaskState } from "../domain.js";
import type { WorkflowConfig } from "../config.js";
import type { GitWorkspace } from "../git/workspace.js";
import type { HerdrClient } from "../herdr/client.js";
import type { TabTimings } from "../runner/tab.js";
import type { CheckRunner } from "../review/review.js";
import { redact } from "../redact.js";
import type { TaskStore } from "../storage/store.js";
import { move } from "./machine.js";

/** Everything the orchestrator modules share. */
export interface WorkflowContext {
  readonly cwd: string;
  /** Swapped by `Workflow.reconfigure` when a config file changes. */
  config: WorkflowConfig;
  readonly store: TaskStore;
  readonly git: GitWorkspace;
  readonly now: () => Date;
  readonly id: () => string;
  /** Check runner that skips a check already passed on an identical clean tree. */
  readonly checkRunner: CheckRunner;
  /** Keys of warnings already shown, so each appears once. */
  readonly warned: Set<string>;
  /** Replaces the home directory the agent logs are looked for under (tests, the CLI). */
  agentLogHome?: string;
  /** Main Claude Code sessions the hooks have recorded: their logs are the session's own, never an agent tab's or outside chef. */
  knownSessions?: () => { transcriptPath: string; sessionId: string }[];
  /** Today's budget counts these records (every registered repo's ledger) instead of this repo's own. Absent: the repo ledger. */
  dailyRecords?: () => CostRecord[];
  /** Ledger ids of a Pi ticket child's calls already recorded (`recordPiUsage`), loaded from the ledger on first use. */
  piLedgered?: Set<string>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (message: string) => void;
  /** Progress lines while /build runs. Absent without a listener. */
  progress?: (message: string) => void;
  /** Multi-line markdown blocks (the build table, a review). Absent without a listener. */
  report?: (markdown: string) => void;
  /** The herdr client: ticket, review and fix runs open a tab through it. Absent without herdr; a test sets a fake. */
  herdr?: HerdrClient;
  /** Timings and sleeps of the herdr tab waits; a test seam (the defaults are right for a person). */
  herdrTimings?: TabTimings;
  /** Absolute path of this install's `src/ticket-mode.ts`: a Pi model fix in a tab (`review-fix.ts`) needs it. A test sets it. */
  ticketModePath?: string;
  /** Whether a `pi` program can be started for a Pi model's ticket or review. Unset, no such check is made. */
  piAvailable?: () => boolean;
}

export function fail(code: string, text: string): CommandResult {
  return { ok: false, code, text };
}

export function done(text: string, data?: unknown): CommandResult {
  return { ok: true, text, data };
}

export function iso(ctx: WorkflowContext): string {
  return ctx.now().toISOString();
}

export function active(ctx: WorkflowContext): TaskState | undefined {
  const id = ctx.store.readActive();
  return id ? ctx.store.load(id) : undefined;
}

export function requireActive(ctx: WorkflowContext): TaskState {
  const state = active(ctx);
  if (!state) throw new WorkflowError("NO_TASK", "No active task.");
  return state;
}

export function asResult(error: unknown): CommandResult {
  if (error instanceof WorkflowError) return fail(error.code, error.message);
  return fail("ERROR", redact((error as Error).message || "Unknown error"));
}

/** Runs a command body and turns anything it throws into a failed CommandResult. */
export async function guard(fn: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await fn();
  } catch (error) {
    return asResult(error);
  }
}

/** Moves a task to another phase through the store, so the change is logged under `reason`. */
export function transition(ctx: WorkflowContext, taskId: string, reason: string, to: Phase, note?: string): Promise<TaskState> {
  return ctx.store.update(taskId, reason, (task) => move(task, to, iso(ctx), note));
}

/** The workspace dir as a repo-relative path (`.shepherd`): workflow state, never the user's code. */
export function workspaceName(ctx: WorkflowContext): string {
  return ctx.config.workspaceDir.replace(/^\.\//, "").replace(/\/$/, "");
}

/** Repo-relative paths that are never the user's code: the workspace dir. Commits, diffs and the dirty-tree test skip them. */
export function excludedPaths(ctx: WorkflowContext): string[] {
  return [workspaceName(ctx)];
}
