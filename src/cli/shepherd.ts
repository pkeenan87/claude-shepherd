/**
 * shepherd: the command line of the Claude Code plugin. `cost` and `status` are for people and skills; `hook` is what the
 * plugin's hooks run (stdin is Claude Code's hook JSON). A hook never throws and exits 0 except where it blocks by its
 * JSON output; any internal error is one line on stderr and no stdout. `main` returns the exit code.
 */
import { execFile } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, writeFileSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigFileError, fromMicroUsd, loadConfig, priceFor, toMicroUsd, type WorkflowConfig } from "../config.js";
import { budgetStatusFor } from "../cost/ledger.js";
import type { CommandResult, TaskState } from "../domain.js";
import { done, fail } from "../orchestrator/context.js";
import { redact } from "../redact.js";
import { formatIdle, formatTokens } from "../orchestrator/format.js";
import { Workflow } from "../orchestrator/service.js";
import { dailyRecordsOf, pruneOldSessions, readJson, registerRepo, registeredRepos, sessionFile, shepherdHome, writeJson } from "../shepherd-home.js";
import { TaskStore, atomicWrite } from "../storage/store.js";
import { guardHits, type GuardHit } from "./bash-guard.js";
import type { HerdrClient } from "../herdr/client.js";
import type { CheckRunner } from "../review/review.js";
import type { TabTimings } from "../runner/tab.js";
import type { WorkflowOptions } from "../orchestrator/types.js";
import { buildCommand, BUILD_USAGE, type OpenSession } from "./build.js";
import { cleanupCommand, cleanupRemoteReason, CLEANUP_USAGE } from "./cleanup.js";
import { fixCommand, FIX_USAGE, reviewCommand, REVIEW_USAGE } from "./review.js";
import { herdrInstall, HERDR_INSTALL_USAGE } from "./herdr-install.js";
import { migrateConfig, MIGRATE_USAGE } from "./migrate-config.js";
import { approvalReason, PLAN_USAGE, planCommand, plansCommand, taskCommand } from "./plan.js";
import { shipCommand, shipRemoteReason, SHIP_USAGE } from "./ship.js";
import { installStatusLine, refreshStatusLine, STATUSLINE_USAGE } from "./statusline.js";

const run = promisify(execFile);

const USAGE = `Usage:
  shepherd version
  shepherd cost [--json]
  shepherd status [--json] [--statusline]
  shepherd hook <stop|prompt|pretool|precompact|postcompact>   (reads the hook JSON on stdin)
  shepherd compact-config [--pct <30..90> | --off] [--json]   (sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in ~/.claude/settings.json)
  shepherd build [--once] [--json] | pause   (runs the approved plan's tickets as herdr sub-agents; --once builds one ticket)
  shepherd review [--with <model>]... [--json]   (checks, static scan and the model pass(es) in herdr sub-agents; writes the numbered report)
  shepherd fix <--tab|--list> [--json]   (fix the latest review's findings in a herdr sub-agent, or print them for this chat)
  shepherd plan <start|spec|tickets|show|revise|approve> ...   (shepherd plan --help)
  shepherd plans [<name> | close <name> | --all]
  shepherd task <list|use <name>|close [<name>]>
  shepherd ship [--push | --pr [--draft]] [--base <branch>] [--json]   (branch preflight, PR body, and confirmation-gated push/PR)
  shepherd cleanup [--dry-run] [--worktrees] [--branches] [--plans] [--sessions] [--remote] [--force] [--json]
  shepherd herdr-install [--layout <name>] [--no-dock] [--remote]   (installs the herdr panel into the herdr app; --remote installs the panel CLI into the shepherd home for a remote machine)
  shepherd statusline-install [--force]   (shows the plan's spend and today's in Claude Code's status line)
  shepherd migrate-config [--force] [--json]   (copies ~/.pi/agent/chef.yaml to ~/.claude/shepherd.yaml, never over an existing one)
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliOptions {
  /** The hook JSON (default: read from process.stdin by the entry point). */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The home directory the agent logs and `~/.claude/shepherd` are under (default: the user's). */
  home?: string;
  /** Where the command runs (default: process.cwd(); a hook uses the cwd in its JSON). */
  cwd?: string;
  /** Test seams for `build`, `review` and `fix`: the herdr client (default: the real `hc`), the check runner, the tab timings, whether `pi` is installed, the ticket-mode path, and what a signal exits with. */
  herdr?: HerdrClient;
  runner?: CheckRunner;
  herdrTimings?: TabTimings;
  piAvailable?: () => boolean;
  ticketModePath?: string;
  exit?: (code: number) => void;
  /** The bundle the status line launcher runs (default: this file). */
  entry?: string;
}

const selfEntry = (options: CliOptions) => options.entry ?? fileURLToPath(import.meta.url);

const defaultIo: CliIo = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };

/** The version in package.json. It sits one level above src/cli, build/cli and dist (the bundle). */
function packageVersion(): string {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "claude-shepherd" && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "unknown";
}

interface Session {
  root: string;
  commonRoot: string;
  isWorktree: boolean;
  workflow: Workflow;
  config: WorkflowConfig;
  shepherd: string;
  now: () => Date;
}

type Opened = { session: Session } | { problem: "no-repo" } | { problem: "config"; message: string };

/** The repo around `cwd`, its config, and a Workflow whose daily budget spans every registered repo. Linked worktrees share `<commonRoot>/.shepherd/` with a per-worktree active pointer. */
async function open(cwd: string, options: CliOptions, confirm?: () => Promise<boolean>, extras: Partial<WorkflowOptions> = {}, readOnly = false): Promise<Opened> {
  let root: string;
  let commonRoot: string;
  let gitDir: string;
  try {
    const res = await run("git", ["rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"], { cwd });
    const [top, commonRaw, dirRaw] = res.stdout.trim().split(/\r?\n/);
    root = top?.trim() ?? "";
    const resolvedCommon = commonRaw ? path.resolve(cwd, commonRaw.trim()) : path.join(root, ".git");
    commonRoot = path.basename(resolvedCommon) === ".git" ? path.dirname(resolvedCommon) : root;
    gitDir = dirRaw ? path.resolve(cwd, dirRaw.trim()) : path.join(root, ".git");
  } catch {
    return { problem: "no-repo" };
  }
  if (!root) return { problem: "no-repo" };
  const isWorktree = path.resolve(gitDir) !== path.resolve(path.join(commonRoot, ".git"));
  let config: WorkflowConfig;
  try {
    config = loadConfig(root, isWorktree ? commonRoot : undefined);
  } catch (error) {
    if (error instanceof ConfigFileError) return { problem: "config", message: error.message };
    throw error;
  }
  const now = options.now ?? (() => new Date());
  const home = options.home ?? homedir();
  const shepherd = shepherdHome(options.env ?? process.env, home);
  // Linked worktrees share the main repo's `.shepherd/` (tasks, ledger, events) while keeping their own active pointer in `<gitDir>/shepherd-active.json`.
  const workspace = path.join(commonRoot, config.workspaceDir);
  if (!readOnly || existsSync(workspace)) {
    ignoreWorkspace(workspace);
    await registerRepo(shepherd, workspace);
  }
  const store = extras.store ?? new TaskStore(workspace, isWorktree ? path.join(gitDir, "shepherd-active.json") : undefined);
  const workflow = new Workflow({ cwd: root, config, store, now, ...(confirm ? { confirm } : {}), agentLogHome: home, knownSessions: () => knownSessions(shepherd), dailyRecords: () => dailyRecordsOf([...registeredRepos(shepherd), workspace], now(), config.budgets.timeZone), ...extras });
  return { session: { root, commonRoot, isWorktree, workflow, config, shepherd, now } };
}

const spend = (s: { knownUsd: number; estimatedUnknownUsd: number; unknownRecords: number }) =>
  `${s.unknownRecords > 0 ? "≈" : ""}$${fromMicroUsd(toMicroUsd(s.knownUsd) + toMicroUsd(s.estimatedUnknownUsd)).toFixed(2)}`;

function openTask(task: TaskState | undefined): TaskState | undefined {
  return task && task.phase !== "IDLE" && task.phase !== "COMPLETE" ? task : undefined;
}

/** Where the budgets stand for the open task and today: the worst status and the sentence that names what is spent. */
function budgetOf(session: Session, task: TaskState | undefined) {
  const { workflow, config } = session;
  const open = openTask(task);
  const state = workflow.budgetState(open?.taskId);
  const { taskUsd, dailyUsd, softWarningRatio } = config.budgets;
  const taskStatus = open ? budgetStatusFor(state.task, taskUsd, softWarningRatio) : "ok";
  const dailyStatus = budgetStatusFor(state.daily, dailyUsd, softWarningRatio);
  const named = (status: string) => [
    ...(taskStatus === status ? [`task ${open?.name ?? open?.taskId} ${spend(state.task)} of $${taskUsd}`] : []),
    ...(dailyStatus === status ? [`today ${spend(state.daily)} of $${dailyUsd}`] : []),
  ];
  const status = taskStatus === "hard" || dailyStatus === "hard" ? "hard" : taskStatus === "soft" || dailyStatus === "soft" ? "soft" : "ok";
  return { status, state, text: status === "ok" ? "" : named(status).join(" and ") };
}

// -- cost, status ------------------------------------------------------------------------------------------------

async function costCommand(args: string[], io: CliIo, options: CliOptions): Promise<number> {
  const json = args.includes("--json");
  const opened = await open(options.cwd ?? process.cwd(), options);
  if ("problem" in opened) {
    io.err(opened.problem === "no-repo" ? "shepherd cost: not inside a git repository.\n" : `${opened.message}\n`);
    return 1;
  }
  const { workflow } = opened.session;
  await workflow.activeTask();
  const result = await workflow.cost("");
  if (!result.ok) {
    io.err(`${result.text}\n`);
    return 1;
  }
  if (json) {
    const budget = workflow.budgetState();
    io.out(`${JSON.stringify({ text: result.text, budget }, null, 2)}\n`);
  } else io.out(`${result.text}\n`);
  return 0;
}

/** Metadata extracted from Claude Code's status line JSON on stdin, if present. */
function statusLineMeta(stdin: string | undefined): { cwd?: string; sessionId?: string } {
  try {
    const input = JSON.parse(stdin ?? "") as { cwd?: unknown; session_id?: unknown; workspace?: { current_dir?: unknown } };
    const dir = input?.workspace?.current_dir ?? input?.cwd;
    return {
      ...(typeof dir === "string" && dir ? { cwd: dir } : {}),
      ...(typeof input?.session_id === "string" && input.session_id ? { sessionId: input.session_id } : {}),
    };
  } catch {
    return {};
  }
}

/** Short phase/progress tag for a status line: "building 2/5 · #03", "2/5 done", "reviewed ✓", "planning", etc. */
function taskBadge(task: TaskState): { badge: string; done: number; total: number; failed: number; current?: string } {
  const runs = Object.values(task.ticketRuns ?? {});
  const total = (task.plan?.tickets ?? []).length || runs.length;
  const doneCount = runs.filter((run) => run.status === "done").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const current = task.build?.currentTicket;
  let badge: string;
  if (current) badge = `building ${doneCount}/${total} · #${current}`;
  else if (total > 0) {
    if (task.review?.passed) badge = `${doneCount}/${total} · reviewed ✓`;
    else if (task.review) badge = `${doneCount}/${total} · review findings`;
    else if (failed > 0) badge = `${doneCount}/${total} · ${failed} failed`;
    else if (doneCount >= total) badge = `${doneCount}/${total} built`;
    else if (doneCount > 0) badge = `${doneCount}/${total} done`;
    else if (task.approvedVersion === task.plan?.version) badge = `approved · 0/${total}`;
    else badge = `draft · 0/${total}`;
  } else if (task.phase === "PLANNING") {
    badge = "planning";
  } else {
    badge = task.phase.toLowerCase();
  }
  return { badge, done: doneCount, total, failed, ...(current ? { current } : {}) };
}

/** Context & prompt-cache warmth for the current (or latest) session note, if available and recent. */
function sessionContextInfo(shepherd: string, config: WorkflowConfig, now: Date, sessionId?: string): { contextTokens: number; warm: boolean; idleMinutes: number; model?: string } | undefined {
  let note: Partial<SessionNote> | undefined;
  if (sessionId) {
    note = readJson<Partial<SessionNote>>(sessionFile(shepherd, sessionId));
  } else {
    try {
      let bestTime = -1;
      for (const name of readdirSync(path.join(shepherd, "sessions"))) {
        if (!name.endsWith(".json") || name.endsWith(".pending.json") || name.endsWith(".compact.json")) continue;
        const candidate = readJson<Partial<SessionNote>>(path.join(shepherd, "sessions", name));
        const t = candidate?.lastTurnEnd ? Date.parse(candidate.lastTurnEnd) : NaN;
        if (Number.isFinite(t) && t > bestTime) {
          bestTime = t;
          note = candidate;
        }
      }
    } catch {
      return undefined;
    }
  }
  if (!note || typeof note.contextTokens !== "number" || note.contextTokens <= 0 || !note.lastTurnEnd) return undefined;
  const ended = Date.parse(note.lastTurnEnd);
  if (!Number.isFinite(ended)) return undefined;
  const idleMs = Math.max(0, now.getTime() - ended);
  if (idleMs > 24 * 60 * 60_000) return undefined;
  const thresholdMs = Math.max(1, config.budgets.idleWarnMinutes || 5) * 60_000;
  return {
    contextTokens: note.contextTokens,
    warm: idleMs < thresholdMs,
    idleMinutes: Math.round(idleMs / 60_000),
    ...(note.model ? { model: note.model } : {}),
  };
}

async function statusCommand(rest: string[], io: CliIo, options: CliOptions): Promise<number> {
  const json = rest.includes("--json");
  try {
    const isStatusLine = rest.includes("--statusline");
    const meta = isStatusLine ? statusLineMeta(options.stdin) : {};
    const opened = await open(meta.cwd ?? options.cwd ?? process.cwd(), options, undefined, {}, isStatusLine);
    if ("problem" in opened) {
      const text = opened.problem === "no-repo" ? "shepherd · no repo" : "shepherd · config error";
      if (json) io.out(`${JSON.stringify({ ok: false, code: opened.problem === "no-repo" ? "NO_REPO" : "CONFIG", text }, null, 2)}\n`);
      else io.out(`${text}\n`);
      return 0;
    }
    const { session } = opened;
    const task = openTask(await session.workflow.activeTask());
    const { status, state } = budgetOf(session, task);
    const { taskUsd, dailyUsd } = session.config.budgets;
    const info = task ? taskBadge(task) : undefined;
    const ctxInfo = sessionContextInfo(session.shepherd, session.config, session.now(), meta.sessionId);
    const budgetFlag = status === "hard" ? " ⛔" : status === "soft" ? " ⚠" : "";
    const wtTag = session.isWorktree ? " · wt" : "";
    const ctxText = ctxInfo ? ` · ctx ${formatTokens(ctxInfo.contextTokens)} ${ctxInfo.warm ? "warm" : "cold"}` : "";
    const text = `shepherd · ${task ? `${task.name ?? task.taskId} [${info!.badge}]${wtTag} · plan ${spend(state.task)}/$${taskUsd}` : `no plan${wtTag}`} · today ${spend(state.daily)}/$${dailyUsd}${budgetFlag}${ctxText}`;
    if (json) {
      io.out(
        `${JSON.stringify(
          {
            ok: true,
            text,
            repo: session.root,
            task: task
              ? {
                  id: task.taskId,
                  name: task.name ?? task.taskId,
                  phase: task.phase,
                  branch: task.build?.branch ?? null,
                  ticketsDone: info!.done,
                  ticketsTotal: info!.total,
                  ticketsFailed: info!.failed,
                  currentTicket: info!.current ?? null,
                  building: Boolean(session.workflow.store.liveBuildClaim(task.taskId) || session.workflow.store.buildInProgress(task.taskId)),
                  reviewPassed: task.review ? task.review.passed : null,
                }
              : null,
            budget: {
              status,
              taskUsd,
              dailyUsd,
              taskSpentUsd: fromMicroUsd(toMicroUsd(state.task.knownUsd) + toMicroUsd(state.task.estimatedUnknownUsd)),
              dailySpentUsd: fromMicroUsd(toMicroUsd(state.daily.knownUsd) + toMicroUsd(state.daily.estimatedUnknownUsd)),
              apiEquivalentTaskUsd: state.task.apiEquivalentUsd,
              apiEquivalentDailyUsd: state.daily.apiEquivalentUsd,
            },
            context: ctxInfo ?? null,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out(`${text}\n`);
    }
  } catch {
    if (json) io.out(`${JSON.stringify({ ok: false, code: "ERROR", text: "shepherd · status unavailable" }, null, 2)}\n`);
    else io.out("shepherd · status unavailable\n");
  }
  return 0;
}

// -- hooks -------------------------------------------------------------------------------------------------------

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

interface SessionNote {
  lastTurnEnd: string;
  contextTokens: number;
  model?: string;
  /** Recorded so a `shepherd cost` run mid-turn can tell this session's log from outside use. */
  transcriptPath: string;
  sessionId: string;
}

/** The sessions the hooks have seen (`sessions/<id>.json`), for labelling their logs. */
function knownSessions(shepherd: string): { transcriptPath: string; sessionId: string }[] {
  try {
    return readdirSync(path.join(shepherd, "sessions"))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".pending.json") && !name.endsWith(".compact.json"))
      .flatMap((name) => {
        const note = readJson<Partial<SessionNote>>(path.join(shepherd, "sessions", name));
        return note && typeof note.transcriptPath === "string" && typeof note.sessionId === "string" ? [{ transcriptPath: note.transcriptPath, sessionId: note.sessionId }] : [];
      });
  } catch {
    return [];
  }
}

/**
 * The usage of the last assistant message in a transcript, reading only its tail; a half-written last line is skipped.
 * A `/compact` boundary after it means the context is now only the summary: 0 tokens, as of the compaction.
 */
function lastAssistant(file: string): { contextTokens: number; model?: string; at?: string } | undefined {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    for (const window of [256 * 1024, 4 * 1024 * 1024]) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      const rows = (length < size ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        let line: { type?: string; subtype?: string; isSidechain?: boolean; timestamp?: string; message?: { model?: string; usage?: Record<string, number> } };
        try {
          line = JSON.parse(rows[i]!);
        } catch {
          continue;
        }
        if (line.type === "system" && line.subtype === "compact_boundary" && line.isSidechain !== true) {
          return { contextTokens: 0, ...(typeof line.timestamp === "string" ? { at: line.timestamp } : {}) };
        }
        const usage = line.message?.usage;
        if (line.type !== "assistant" || line.isSidechain === true || !usage || !line.message?.model || line.message.model === "<synthetic>") continue;
        const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
        return { contextTokens: n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens), model: line.message.model, ...(typeof line.timestamp === "string" ? { at: line.timestamp } : {}) };
      }
      if (length >= size) break;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Prompts Claude Code injects on its own: the idle warning never holds these back. */
const INJECTED = /^<(?:task-notification|bash-notification|teammate-message|local-command-stdout)\b/i;

const GUARD_WHY: Record<GuardHit, string> = {
  "git push": "shepherd never pushes while a build runs",
  "git branch change": "a build is running on its branch; switching branches would break it",
  "git worktree": "a build is running in this checkout; worktree changes would break it",
  "shepherd switch": "a build is running on its branch; switching tasks would break it",
  "shepherd run": "",
  "hc run": "",
  "plan approve": "",
  "cleanup remote": "",
  "ship remote": "shepherd never pushes while a build runs",
  "build pause": "",
  "build override": "",
};

async function runHook(kind: string, input: HookInput, session: Session): Promise<object | undefined> {
  const { workflow, config, shepherd, now } = session;
  const sessionId = input.session_id;
  const sweep = () => workflow.sweepAgentLogs({ known: knownSessions(shepherd), ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}), ...(sessionId ? { sessionId } : {}) });
  const task = await workflow.activeTask();

  if (kind === "stop") {
    await sweep();
    pruneOldSessions(shepherd, now());
    if (sessionId && input.transcript_path) {
      const last = lastAssistant(input.transcript_path);
      if (last) writeJson(sessionFile(shepherd, sessionId), { lastTurnEnd: now().toISOString(), contextTokens: last.contextTokens, ...(last.model ? { model: last.model } : {}), transcriptPath: input.transcript_path, sessionId } satisfies SessionNote);
    }
    return undefined;
  }

  if (kind === "precompact") {
    await sweep();
    const open = openTask(task);
    if (sessionId) {
      const budget = budgetOf(session, task);
      const info = open ? taskBadge(open) : undefined;
      const nextTicket = open ? workflow.peekTicket() : undefined;
      const snapshot = {
        at: now().toISOString(),
        repo: session.root,
        task: open
          ? {
              id: open.taskId,
              name: open.name ?? open.taskId,
              phase: open.phase,
              branch: open.build?.branch ?? null,
              badge: info!.badge,
              done: info!.done,
              total: info!.total,
              failed: info!.failed,
              nextTicket: nextTicket ? `${nextTicket.id} (${nextTicket.title})` : null,
              reviewPassed: open.review ? open.review.passed : null,
            }
          : null,
        taskSpend: `${spend(budget.state.task)}/$${config.budgets.taskUsd}`,
        dailySpend: `${spend(budget.state.daily)}/$${config.budgets.dailyUsd}`,
      };
      writeJson(sessionFile(shepherd, sessionId, ".compact"), snapshot);
      const saved = readJson<Partial<SessionNote>>(sessionFile(shepherd, sessionId));
      if (saved && saved.transcriptPath) {
        writeJson(sessionFile(shepherd, sessionId), {
          ...saved,
          lastTurnEnd: now().toISOString(),
          contextTokens: 0,
          sessionId,
        });
      }
    }
    return undefined;
  }

  if (kind === "postcompact") {
    const snap = sessionId
      ? readJson<{
          task?: { name: string; phase: string; branch: string | null; badge: string; done: number; total: number; failed: number; nextTicket: string | null; reviewPassed: boolean | null } | null;
          taskSpend?: string;
          dailySpend?: string;
        }>(sessionFile(shepherd, sessionId, ".compact"))
      : undefined;
    const open = openTask(task);
    const info = open ? taskBadge(open) : undefined;
    const budget = budgetOf(session, task);
    const nextTicket = open ? workflow.peekTicket() : undefined;
    const t = snap?.task ?? (open
      ? {
          name: open.name ?? open.taskId,
          phase: open.phase,
          branch: open.build?.branch ?? null,
          badge: info!.badge,
          done: info!.done,
          total: info!.total,
          failed: info!.failed,
          nextTicket: nextTicket ? `${nextTicket.id} (${nextTicket.title})` : null,
          reviewPassed: open.review ? open.review.passed : null,
        }
      : null);
    const lines = [
      "[Shepherd state restored after compaction]",
      ...(t
        ? [
            `- Active task: ${t.name} (${t.badge}; phase ${t.phase})${t.branch ? ` on branch ${t.branch}` : ""}`,
            ...(t.nextTicket ? [`- Next ticket: ${t.nextTicket}`] : []),
            ...(t.reviewPassed !== null ? [`- Review: ${t.reviewPassed ? "passed" : "has findings to fix"}`] : []),
          ]
        : ["- Active task: none"]),
      `- Spend: plan ${snap?.taskSpend ?? `${spend(budget.state.task)}/$${config.budgets.taskUsd}`} · today ${snap?.dailySpend ?? `${spend(budget.state.daily)}/$${config.budgets.dailyUsd}`}`,
      "- Run `shepherd status` or `shepherd plan show` if you need full details.",
    ];
    return { hookSpecificOutput: { hookEventName: "PostCompact", additionalContext: lines.join("\n") } };
  }

  if (kind === "prompt") {
    const prompt = (input.prompt ?? "").trim();
    // A command always goes through, so /cost works at any budget.
    if (!prompt || prompt.startsWith("/")) return undefined;
    await sweep();
    // A session's first prompt: remember its transcript for `shepherd cost` (the idle check waits for a Stop's note).
    if (sessionId && input.transcript_path && !existsSync(sessionFile(shepherd, sessionId))) writeJson(sessionFile(shepherd, sessionId), { transcriptPath: input.transcript_path, sessionId });
    const budget = budgetOf(session, task);
    if (budget.status === "hard") {
      return { decision: "block", reason: `Budget exhausted: ${budget.text}. Raise budgets in ~/.claude/shepherd.yaml or wait until tomorrow.` };
    }
    const messages: string[] = [];
    // A message Claude Code injects (a background task finishing) is not typed by anyone, so nobody would re-send it.
    const idle = INJECTED.test(prompt) ? undefined : idleCheck(session, sessionId, input.transcript_path);
    if (idle) {
      if (idle.action === "block") return { decision: "block", reason: idle.text };
      messages.push(idle.text);
    }
    if (budget.status === "soft") {
      const open = openTask(task);
      const mark = path.join(shepherd, "warned.json");
      const day = now().toISOString().slice(0, 10);
      const key = open?.taskId ?? "daily";
      const warned = readJson<{ day?: string; keys?: string[] }>(mark);
      const keys = warned?.day === day ? (warned.keys ?? []) : [];
      if (!keys.includes(key)) {
        writeJson(mark, { day, keys: [...keys, key] });
        messages.push(`Budget warning: ${budget.text}. Run /cost for details.`);
      }
    }
    if (messages.length > 0) return { systemMessage: messages.join("\n") };
    return undefined;
  }

  if (kind === "pretool") {
    const command = input.tool_input?.command;
    if (input.tool_name !== "Bash" || typeof command !== "string") return undefined;
    const hits = guardHits(command);
    if (hits.length === 0) return undefined;
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    const open = openTask(task);
    // Scope the build guard to THIS checkout: a build running in worktree A does not block git commands in worktree B.
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const rootReal = real(session.root);
    const liveClaim = open ? workflow.store.liveBuildClaim(open.taskId) : undefined;
    const claimHere = !!liveClaim && (!liveClaim.checkout || real(liveClaim.checkout) === rootReal);
    const markerHere =
      !!open &&
      workflow.store.buildInProgress(open.taskId) &&
      (!open.worktree || real(open.worktree.path) === rootReal);
    const building = open && (claimHere || markerHere);
    const blocked = hits.find((hit) => building && GUARD_WHY[hit]);
    if (blocked) return deny(`Blocked \`${blocked}\`: ${GUARD_WHY[blocked]} (task ${open?.name ?? open?.taskId}).`);
    const spendHit = hits.find((hit) => hit === "shepherd run" || hit === "hc run");
    if (spendHit) {
      const budget = budgetOf(session, task);
      if (budget.status === "hard") return deny(`Budget exhausted: ${budget.text}. Not starting more agent work (${spendHit === "hc run" ? "hc run" : "shepherd build/review/fix"}). Raise budgets in ~/.claude/shepherd.yaml or wait until tomorrow.`);
    }
    // Approval and remote-mutating actions are always the user's: Claude Code asks them, whatever a skill's allowed-tools say.
    if (hits.includes("plan approve")) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: await approvalReason(workflow, config) } };
    if (hits.includes("cleanup remote")) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: cleanupRemoteReason(command) } };
    if (hits.includes("ship remote")) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: await shipRemoteReason(workflow, command) } };
    if (hits.includes("build pause") && building) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Pause active build for task \`${open?.name ?? open?.taskId}\` and lift the branch/push guard?`,
        },
      };
    }
    if (hits.includes("build override")) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Override the failed per-ticket review for task \`${open?.name ?? open?.taskId}\` and commit if checks pass? Remaining findings will be carried to /shepherd:review.`,
        },
      };
    }
    return undefined;
  }
  return undefined;
}

/**
 * The idle-cache check. The last reply is read from the transcript now, when it is complete: at Stop, Claude Code may
 * not have written it yet, so the Stop note is only the fallback. Honors `budgets.idleAction` ("warn" default, "block", or "off").
 */
function idleCheck(session: Session, sessionId: string | undefined, transcriptPath?: string): { action: "warn" | "block"; text: string } | undefined {
  const { config, shepherd, now } = session;
  const { idleWarnMinutes, idleWarnTokens } = config.budgets;
  const action = config.budgets.idleAction ?? "warn";
  if (action === "off" || !sessionId || idleWarnMinutes <= 0 || idleWarnTokens <= 0) return undefined;
  const saved = readJson<Partial<SessionNote>>(sessionFile(shepherd, sessionId));
  let fresh: ReturnType<typeof lastAssistant>;
  try {
    fresh = transcriptPath ? lastAssistant(transcriptPath) : undefined;
  } catch {
    fresh = undefined;
  }
  const times = [saved?.lastTurnEnd, fresh?.at].map((value) => (value ? Date.parse(value) : NaN)).filter(Number.isFinite);
  const ended = times.length > 0 ? Math.max(...times) : NaN;
  const note = { contextTokens: fresh?.contextTokens ?? saved?.contextTokens, model: fresh?.model ?? saved?.model };
  if (!Number.isFinite(ended) || typeof note.contextTokens !== "number") return undefined;
  const at = now();
  const idleMs = at.getTime() - ended;
  if (idleMs < idleWarnMinutes * 60_000 || note.contextTokens < idleWarnTokens) return undefined;
  // Once per idle stretch: after one warning, any message goes through until a turn ends and a new stretch begins.
  const warnedFile = sessionFile(shepherd, sessionId, ".pending");
  const idleSince = new Date(ended).toISOString();
  if (readJson<{ idleSince?: string }>(warnedFile)?.idleSince === idleSince) return undefined;
  writeJson(warnedFile, { idleSince, at: at.toISOString() });
  const row = note.model ? priceFor(config.pricing, "anthropic", note.model, at) : undefined;
  const rate = row ? (row.cacheWritePerMillionUsd ?? row.inputPerMillionUsd) : undefined;
  const cost = rate === undefined ? "" : ` (≈$${((note.contextTokens * rate) / 1_000_000).toFixed(2)} at ${note.model} rates)`;
  if (action === "block") {
    return {
      action: "block",
      text: `This chat holds ${formatTokens(note.contextTokens)} tokens and has been idle ${formatIdle(idleMs)}, so the prompt cache has probably expired: sending re-sends the whole context${cost}. Send it again (or any message) to go ahead, this warning shows once per idle stretch; or run /compact or /clear to trim/reset context (your shepherd task resumes from the branch).`,
    };
  }
  return {
    action: "warn",
    text: `Prompt cache notice: this chat holds ${formatTokens(note.contextTokens)} tokens and was idle ${formatIdle(idleMs)}, so the prompt cache has probably expired${cost}. Consider running /compact (shepherd preserves your plan state automatically) or /clear; or tune auto-compaction with \`shepherd compact-config --pct 50\`. (Set budgets.idleAction: off in ~/.claude/shepherd.yaml to silence.)`,
  };
}

const COMPACT_CONFIG_USAGE = "Usage: shepherd compact-config [--pct <30..90> | --off] [--json]";

/** Atomically writes `~/.claude/settings.json` while resolving symlinks, preserving permissions (0600 default), and saving a `.bak` backup. */
function writeSettingsSafely(settingsFile: string, content: string): void {
  const existed = existsSync(settingsFile);
  const target = existed ? realpathSync(settingsFile) : settingsFile;
  const mode = existed ? statSync(target).mode & 0o777 : 0o600;
  mkdirSync(path.dirname(target), { recursive: true });
  if (existed) {
    const backup = `${target}.bak`;
    try {
      copyFileSync(target, backup);
      chmodSync(backup, mode);
    } catch {
      /* best-effort backup */
    }
  }
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

/** Reads or updates `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `~/.claude/settings.json` atomically. */
function compactConfigCommand(rest: string[], io: CliIo, options: CliOptions): number {
  const json = rest.includes("--json");
  if (rest.includes("--help") || rest.includes("-h")) return emit(done(COMPACT_CONFIG_USAGE), json, io);
  const off = rest.includes("--off");
  const pctAt = rest.indexOf("--pct");
  const pctRaw = pctAt >= 0 ? rest[pctAt + 1] : undefined;
  const consumed = new Set<number>();
  rest.forEach((word, i) => {
    if (word === "--json" || word === "--off") consumed.add(i);
    if (word === "--pct") {
      consumed.add(i);
      if (i + 1 < rest.length) consumed.add(i + 1);
    }
  });
  if (rest.some((_, i) => !consumed.has(i)) || (off && pctAt >= 0)) return emit(fail("USAGE", COMPACT_CONFIG_USAGE), json, io);
  let pct: number | undefined;
  if (pctAt >= 0) {
    pct = Number(pctRaw);
    if (!Number.isInteger(pct) || pct < 30 || pct > 90) return emit(fail("USAGE", "compact-config: --pct must be a whole number between 30 and 90."), json, io);
  }
  const home = options.home ?? homedir();
  const settingsFile = path.join(home, ".claude", "settings.json");
  let doc: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emit(fail("CONFIG", `${settingsFile} is not a JSON object.`), json, io);
      doc = parsed as Record<string, unknown>;
    } catch (error) {
      return emit(fail("CONFIG", `Could not read ${settingsFile}: ${redact((error as Error).message)}`), json, io);
    }
  }
  if (doc.env !== undefined && (!doc.env || typeof doc.env !== "object" || Array.isArray(doc.env))) {
    return emit(fail("CONFIG", `${settingsFile}: \`env\` must be a JSON object.`), json, io);
  }
  const envObj = doc.env ? { ...(doc.env as Record<string, unknown>) } : {};
  const current = typeof envObj.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === "string" ? envObj.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE : null;
  if (!off && pct === undefined) {
    const msg = current ? `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is ${current}% in ${settingsFile}.` : `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is not set in ${settingsFile} (Claude Code default applies).`;
    return emit(done(msg, { file: settingsFile, pct: current ? Number(current) : null }), json, io);
  }
  if (off) {
    delete envObj.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (Object.keys(envObj).length > 0) doc.env = envObj;
    else delete doc.env;
    writeSettingsSafely(settingsFile, `${JSON.stringify(doc, null, 2)}\n`);
    return emit(done(`Removed CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from ${settingsFile}. Restart Claude Code for the change to take effect.`, { file: settingsFile, pct: null }), json, io);
  }
  envObj.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(pct);
  doc.env = envObj;
  writeSettingsSafely(settingsFile, `${JSON.stringify(doc, null, 2)}\n`);
  return emit(done(`Set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${pct} in ${settingsFile}. Restart Claude Code to auto-compact at ${pct}% context.`, { file: settingsFile, pct }), json, io);
}

async function hookCommand(kind: string | undefined, io: CliIo, options: CliOptions): Promise<number> {
  try {
    if (kind !== "stop" && kind !== "prompt" && kind !== "pretool" && kind !== "precompact" && kind !== "postcompact") {
      io.err(`shepherd hook: unknown hook ${JSON.stringify(kind ?? "")}.\n`);
      return 0;
    }
    let input: HookInput;
    try {
      input = JSON.parse(options.stdin ?? "") as HookInput;
    } catch {
      return 0;
    }
    if (!input || typeof input !== "object") return 0;
    const env = options.env ?? process.env;
    // Shepherd-spawned Claude sub-agents are metered and managed by the parent build/review process:
    // never register their transcripts in sessions/ (which would exclude them from their own meter)
    // or run idle-cache/compaction/sweep hooks inside them. Keep `pretool` active to guard the build branch.
    if (env.SHEPHERD_SUBAGENT === "1" && kind !== "pretool") return 0;
    if (kind === "prompt") refreshStatusLine(shepherdHome(env, options.home ?? homedir()), selfEntry(options));
    const opened = await open(input.cwd || options.cwd || process.cwd(), options);
    if ("problem" in opened) return 0;
    const output = await runHook(kind, input, opened.session);
    if (output) io.out(`${JSON.stringify(output)}\n`);
  } catch (error) {
    io.err(`shepherd hook ${kind ?? ""}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}\n`);
  }
  return 0;
}

// -- plan, plans, task -------------------------------------------------------------------------------------------

/** Prints a command result: `{ok, code?, text, data?}` with --json, else the text (a failure on stderr). Returns the exit code. */
function emit(result: CommandResult, json: boolean, io: CliIo): number {
  if (json) io.out(`${JSON.stringify({ ok: result.ok, ...(result.code ? { code: result.code } : {}), text: result.text, ...(result.data !== undefined ? { data: result.data } : {}) }, null, 2)}\n`);
  else (result.ok ? io.out : io.err)(`${result.text}\n`);
  return result.ok ? 0 : 1;
}

async function planFamily(command: "plan" | "plans" | "task", rest: string[], io: CliIo, options: CliOptions): Promise<number> {
  const json = rest.includes("--json");
  const force = rest.includes("--force");
  // "--help" is the only other flag; "-" (stdin) stays a word.
  const args = rest.filter((word) => word !== "--json" && word !== "--force");
  try {
    if (args.includes("--help") || args.includes("-h")) return emit(done(PLAN_USAGE), json, io);
    const cwd = options.cwd ?? process.cwd();
    const notices: string[] = [];
    const opened = await open(cwd, options, force ? async () => true : undefined, {
      progress: (line) => {
        notices.push(line);
        if (!json) io.out(`${line}\n`);
      },
    });
    if ("problem" in opened) return emit(fail(opened.problem === "no-repo" ? "NO_REPO" : "CONFIG", opened.problem === "no-repo" ? "shepherd: not inside a git repository." : opened.message), json, io);
    const { workflow, config } = opened.session;
    const result =
      command === "plan" ? await planCommand({ workflow, config, args, stdin: options.stdin ?? "", cwd }) : command === "plans" ? await plansCommand(workflow, args) : await taskCommand(workflow, args);
    const withNotices = json && notices.length > 0 ? { ...result, text: [...notices, result.text].join("\n") } : result;
    return emit(withNotices, json, io);
  } catch (error) {
    return emit(fail("ERROR", redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!)), json, io);
  }
}

/** The workspace is shepherd's state, never the user's code: it ignores itself, so hooks never leave untracked files. */
function ignoreWorkspace(workspace: string): void {
  const file = path.join(workspace, ".gitignore");
  if (existsSync(file)) return;
  try {
    mkdirSync(workspace, { recursive: true });
    atomicWrite(file, "*\n");
  } catch {
    /* read-only repo: hooks still run */
  }
}

/** The session opener `build`, `review` and `fix` share: the Workflow gets the command's own progress, herdr client and seams. */
function opener(cwd: string, options: CliOptions): OpenSession {
  return async (extras) => {
    const opened = await open(cwd, options, undefined, extras).catch((error: unknown) => ({ problem: "error" as const, message: redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!) }));
    if ("problem" in opened) {
      return opened.problem === "no-repo"
        ? { problem: "shepherd: not inside a git repository.", code: "NO_REPO" }
        : { problem: opened.message, code: opened.problem === "config" ? "CONFIG" : "ERROR" };
    }
    return { workflow: opened.session.workflow, root: opened.session.root, config: opened.session.config };
  };
}

async function buildFamily(command: "build" | "review" | "fix", rest: string[], io: CliIo, options: CliOptions): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(`${command === "build" ? BUILD_USAGE : command === "review" ? REVIEW_USAGE : FIX_USAGE}\n`);
    return 0;
  }
  const run = command === "build" ? buildCommand : command === "review" ? reviewCommand : fixCommand;
  return run(rest, io, options, opener(options.cwd ?? process.cwd(), options));
}

export async function main(argv: string[], io: CliIo = defaultIo, options: CliOptions = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "version" && rest.length === 0) {
    io.out(`${packageVersion()}\n`);
    return 0;
  }
  if (command === "cost") return costCommand(rest, io, options);
  if (command === "status") return statusCommand(rest, io, options);
  if (command === "statusline-install") {
    const json = rest.includes("--json");
    if (rest.includes("--help") || rest.includes("-h")) return emit(done(STATUSLINE_USAGE), json, io);
    if (rest.some((word) => word !== "--json" && word !== "--force")) return emit(fail("USAGE", STATUSLINE_USAGE), json, io);
    return emit(installStatusLine({ home: options.home ?? homedir(), shepherd: shepherdHome(options.env ?? process.env, options.home ?? homedir()), entry: selfEntry(options), force: rest.includes("--force") }), json, io);
  }
  if (command === "hook") return hookCommand(rest[0], io, options);
  if (command === "compact-config") return compactConfigCommand(rest, io, options);
  if (command === "cleanup") {
    return cleanupCommand(rest, io, async () => {
      const opened = await open(options.cwd ?? process.cwd(), options);
      if ("problem" in opened) {
        return { problem: opened.problem === "no-repo" ? "shepherd cleanup: not inside a git repository." : opened.message, code: opened.problem === "no-repo" ? "NO_REPO" : "CONFIG" };
      }
      return { workflow: opened.session.workflow, shepherd: opened.session.shepherd };
    });
  }
  if (command === "ship") {
    return shipCommand(rest, io, async () => {
      const opened = await open(options.cwd ?? process.cwd(), options);
      if ("problem" in opened) {
        return { problem: opened.problem === "no-repo" ? "shepherd ship: not inside a git repository." : opened.message, code: opened.problem === "no-repo" ? "NO_REPO" : "CONFIG" };
      }
      return { workflow: opened.session.workflow };
    });
  }
  if (command === "build" || command === "review" || command === "fix") return buildFamily(command, rest, io, options);
  if (command === "herdr-install") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.out(`${HERDR_INSTALL_USAGE}\n`);
      return 0;
    }
    return herdrInstall(rest, io.out, io.err);
  }
  if (command === "migrate-config") {
    const json = rest.includes("--json");
    if (rest.includes("--help") || rest.includes("-h")) return emit(done(MIGRATE_USAGE), json, io);
    const unknown = rest.filter((word) => word !== "--json" && word !== "--force");
    if (unknown.length > 0) return emit(fail("USAGE", MIGRATE_USAGE), json, io);
    try {
      return emit(migrateConfig({ home: options.home, ...(options.cwd ? { cwd: options.cwd } : {}), force: rest.includes("--force") }), json, io);
    } catch (error) {
      return emit(fail("ERROR", redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!)), json, io);
    }
  }
  if (command === "plan" || command === "plans" || command === "task") return planFamily(command, rest, io, options);
  io.err(USAGE);
  return 2;
}

/** True when this file is the program being run: directly, or through the `bin/shepherd` shim that imports the bundle. */
function isEntry(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const real = realpathSync(invoked);
    return real === realpathSync(fileURLToPath(import.meta.url)) || path.basename(real) === "shepherd";
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (isEntry()) {
  const argv = process.argv.slice(2);
  readStdinFor(argv)
    .then((stdin) => main(argv, defaultIo, { stdin }))
    .then((code) => void (process.exitCode = code), () => void (process.exitCode = argv[0] === "hook" ? 0 : 1));
}

function readStdinFor(argv: string[]): Promise<string> {
  return argv[0] === "hook" || argv.includes("-") || (argv[0] === "status" && argv.includes("--statusline")) ? readStdin() : Promise.resolve("");
}
