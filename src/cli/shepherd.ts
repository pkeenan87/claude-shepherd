/**
 * shepherd: the command line of the Claude Code plugin. `cost` and `status` are for people and skills; `hook` is what the
 * plugin's hooks run (stdin is Claude Code's hook JSON). A hook never throws and exits 0 except where it blocks by its
 * JSON output; any internal error is one line on stderr and no stdout. `main` returns the exit code.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, writeFileSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
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
import { dailyRecordsOf, readJson, registerRepo, registeredRepos, removeFile, sessionFile, shepherdHome, writeJson } from "../shepherd-home.js";
import { guardHits, type GuardHit } from "./bash-guard.js";
import type { HerdrClient } from "../herdr/client.js";
import type { CheckRunner } from "../review/review.js";
import type { TabTimings } from "../runner/tab.js";
import type { WorkflowOptions } from "../orchestrator/types.js";
import { buildCommand, BUILD_USAGE, type OpenSession } from "./build.js";
import { fixCommand, FIX_USAGE, reviewCommand, REVIEW_USAGE } from "./review.js";
import { herdrInstall, HERDR_INSTALL_USAGE } from "./herdr-install.js";
import { migrateConfig, MIGRATE_USAGE } from "./migrate-config.js";
import { approvalReason, PLAN_USAGE, planCommand, plansCommand, taskCommand } from "./plan.js";
import { installStatusLine, refreshStatusLine, STATUSLINE_USAGE } from "./statusline.js";

const run = promisify(execFile);

const USAGE = `Usage:
  shepherd version
  shepherd cost [--json]
  shepherd status
  shepherd hook <stop|prompt|pretool>   (reads the hook JSON on stdin)
  shepherd build [--once] [--json]   (runs the approved plan's tickets as herdr sub-agents; --once builds one ticket)
  shepherd review [--with <model>] [--json]   (checks, static scan and the model pass in a herdr sub-agent; writes the numbered report)
  shepherd fix <--tab|--list> [--json]   (fix the latest review's findings in a herdr sub-agent, or print them for this chat)
  shepherd plan <start|spec|tickets|show|revise|approve> ...   (shepherd plan --help)
  shepherd plans [<name> | close <name> | --all]
  shepherd task <list|use <name>|close [<name>]>
  shepherd herdr-install [--layout <name>] [--no-dock]   (installs the herdr panel into the herdr app; re-run after a plugin update)
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
  workflow: Workflow;
  config: WorkflowConfig;
  shepherd: string;
  now: () => Date;
}

type Opened = { session: Session } | { problem: "no-repo" } | { problem: "config"; message: string };

/** The repo around `cwd`, its config, and a Workflow whose daily budget spans every registered repo. No UI. */
async function open(cwd: string, options: CliOptions, confirm?: () => Promise<boolean>, extras: Partial<WorkflowOptions> = {}): Promise<Opened> {
  let root: string;
  try {
    root = (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  } catch {
    return { problem: "no-repo" };
  }
  if (!root) return { problem: "no-repo" };
  let config: WorkflowConfig;
  try {
    config = loadConfig(root);
  } catch (error) {
    if (error instanceof ConfigFileError) return { problem: "config", message: error.message };
    throw error;
  }
  const now = options.now ?? (() => new Date());
  const home = options.home ?? homedir();
  const shepherd = shepherdHome(options.env ?? process.env, home);
  const workspace = path.join(root, config.workspaceDir);
  ignoreWorkspace(workspace);
  await registerRepo(shepherd, workspace);
  const workflow = new Workflow({ cwd: root, config, now, ...(confirm ? { confirm } : {}), agentLogHome: home, knownSessions: () => knownSessions(shepherd), dailyRecords: () => dailyRecordsOf([...registeredRepos(shepherd), workspace], now()), ...extras });
  return { session: { root, workflow, config, shepherd, now } };
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
  const { workflow, shepherd } = opened.session;
  await workflow.activeTask();
  await workflow.sweepAgentLogs({ known: knownSessions(shepherd) });
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

/** The folder Claude Code's status line JSON names (`workspace.current_dir`, else `cwd`), if stdin holds one. */
function statusLineCwd(stdin: string | undefined): string | undefined {
  try {
    const input = JSON.parse(stdin ?? "") as { cwd?: unknown; workspace?: { current_dir?: unknown } };
    const dir = input?.workspace?.current_dir ?? input?.cwd;
    return typeof dir === "string" && dir ? dir : undefined;
  } catch {
    return undefined;
  }
}

async function statusCommand(rest: string[], io: CliIo, options: CliOptions): Promise<number> {
  try {
    const fromClaude = rest.includes("--statusline") ? statusLineCwd(options.stdin) : undefined;
    const opened = await open(fromClaude ?? options.cwd ?? process.cwd(), options);
    if ("problem" in opened) {
      io.out(opened.problem === "no-repo" ? "shepherd · no repo\n" : "shepherd · config error\n");
      return 0;
    }
    const { session } = opened;
    const task = openTask(await session.workflow.activeTask());
    const { state } = budgetOf(session, task);
    const { taskUsd, dailyUsd } = session.config.budgets;
    io.out(`shepherd · ${task ? `${task.name ?? task.taskId} · plan ${spend(state.task)}/$${taskUsd}` : "no plan"} · today ${spend(state.daily)}/$${dailyUsd}\n`);
  } catch {
    io.out("shepherd · status unavailable\n");
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
  model: string;
  /** Recorded so a `shepherd cost` run mid-turn can tell this session's log from outside use. */
  transcriptPath: string;
  sessionId: string;
}

/** The sessions the hooks have seen (`sessions/<id>.json`), for labelling their logs. */
function knownSessions(shepherd: string): { transcriptPath: string; sessionId: string }[] {
  try {
    return readdirSync(path.join(shepherd, "sessions"))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".pending.json"))
      .flatMap((name) => {
        const note = readJson<Partial<SessionNote>>(path.join(shepherd, "sessions", name));
        return note && typeof note.transcriptPath === "string" && typeof note.sessionId === "string" ? [{ transcriptPath: note.transcriptPath, sessionId: note.sessionId }] : [];
      });
  } catch {
    return [];
  }
}

/** The usage of the last assistant message in a transcript, reading only its tail; a half-written last line is skipped. */
function lastAssistant(file: string): { contextTokens: number; model: string; at?: string } | undefined {
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
        let line: { type?: string; isSidechain?: boolean; timestamp?: string; message?: { model?: string; usage?: Record<string, number> } };
        try {
          line = JSON.parse(rows[i]!);
        } catch {
          continue;
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

const PENDING_MS = 2 * 60_000;

const GUARD_WHY: Record<GuardHit, string> = {
  "git push": "shepherd never pushes while a build runs",
  "git branch change": "a build is running on its branch; switching branches would break it",
  "git worktree": "a build is running in this checkout; worktree changes would break it",
  "shepherd run": "",
  "hc run": "",
  "plan approve": "",
};

async function runHook(kind: string, input: HookInput, session: Session): Promise<object | undefined> {
  const { workflow, config, shepherd, now } = session;
  const sessionId = input.session_id;
  const sweep = () => workflow.sweepAgentLogs({ known: knownSessions(shepherd), ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}), ...(sessionId ? { sessionId } : {}) });
  const task = await workflow.activeTask();

  if (kind === "stop") {
    await sweep();
    if (sessionId && input.transcript_path) {
      const last = lastAssistant(input.transcript_path);
      if (last) writeJson(sessionFile(shepherd, sessionId), { lastTurnEnd: now().toISOString(), contextTokens: last.contextTokens, model: last.model, transcriptPath: input.transcript_path, sessionId } satisfies SessionNote);
    }
    return undefined;
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
    const idle = idleBlock(session, sessionId, prompt, input.transcript_path);
    if (idle) return { decision: "block", reason: idle };
    if (budget.status === "soft") {
      const open = openTask(task);
      const mark = path.join(shepherd, "warned.json");
      const day = now().toISOString().slice(0, 10);
      const key = open?.taskId ?? "daily";
      const warned = readJson<{ day?: string; keys?: string[] }>(mark);
      const keys = warned?.day === day ? (warned.keys ?? []) : [];
      if (!keys.includes(key)) {
        writeJson(mark, { day, keys: [...keys, key] });
        return { systemMessage: `Budget warning: ${budget.text}. Run /cost for details.` };
      }
    }
    return undefined;
  }

  if (kind === "pretool") {
    const command = input.tool_input?.command;
    if (input.tool_name !== "Bash" || typeof command !== "string") return undefined;
    const hits = guardHits(command);
    if (hits.length === 0) return undefined;
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    const open = openTask(task);
    // A live claim (a ticket is running) or the marker (a build has more tickets to go, between `build --once` runs).
    const building = open && (workflow.store.liveBuildClaim(open.taskId) || workflow.store.buildInProgress(open.taskId));
    const blocked = hits.find((hit) => building && GUARD_WHY[hit]);
    if (blocked) return deny(`Blocked \`${blocked}\`: ${GUARD_WHY[blocked]} (task ${open?.name ?? open?.taskId}).`);
    const spendHit = hits.find((hit) => hit === "shepherd run" || hit === "hc run");
    if (spendHit) {
      const budget = budgetOf(session, task);
      if (budget.status === "hard") return deny(`Budget exhausted: ${budget.text}. Not starting more agent work (${spendHit === "hc run" ? "hc run" : "shepherd build/review/fix"}). Raise budgets in ~/.claude/shepherd.yaml or wait until tomorrow.`);
    }
    // Approval is the user's: Claude Code asks them, whatever the skill's allowed-tools say.
    if (hits.includes("plan approve")) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: await approvalReason(workflow, config) } };
    return undefined;
  }
  return undefined;
}

/** The idle-cache warning as a block reason, or undefined to let the prompt through (see AGENTS.md). */
/**
 * The idle-cache warning. The last reply is read from the transcript now, when it is complete: at Stop, Claude Code may
 * not have written it yet, so the Stop note is only the fallback.
 */
function idleBlock(session: Session, sessionId: string | undefined, prompt: string, transcriptPath?: string): string | undefined {
  const { config, shepherd, now } = session;
  const { idleWarnMinutes, idleWarnTokens } = config.budgets;
  if (!sessionId || idleWarnMinutes <= 0 || idleWarnTokens <= 0) return undefined;
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
  const pendingFile = sessionFile(shepherd, sessionId, ".pending");
  const hash = createHash("sha256").update(prompt).digest("hex");
  const pending = readJson<{ hash?: string; at?: string }>(pendingFile);
  if (pending?.hash === hash && at.getTime() - Date.parse(pending.at ?? "") < PENDING_MS) {
    removeFile(pendingFile);
    return undefined;
  }
  writeJson(pendingFile, { hash, at: at.toISOString() });
  const row = note.model ? priceFor(config.pricing, "anthropic", note.model, at) : undefined;
  const rate = row ? (row.cacheWritePerMillionUsd ?? row.inputPerMillionUsd) : undefined;
  const cost = rate === undefined ? "" : ` (≈$${((note.contextTokens * rate) / 1_000_000).toFixed(2)} at ${note.model} rates)`;
  return `This chat holds ${formatTokens(note.contextTokens)} tokens and has been idle ${formatIdle(idleMs)}, so the prompt cache has probably expired: sending re-sends the whole context${cost}. Send the same message again within 2 minutes to send anyway, or run /clear to start fresh; your shepherd task resumes from the branch.`;
}

async function hookCommand(kind: string | undefined, io: CliIo, options: CliOptions): Promise<number> {
  try {
    if (kind !== "stop" && kind !== "prompt" && kind !== "pretool") {
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
    if (kind === "prompt") refreshStatusLine(shepherdHome(options.env ?? process.env, options.home ?? homedir()), selfEntry(options));
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
    const opened = await open(cwd, options, force ? async () => true : undefined);
    if ("problem" in opened) return emit(fail(opened.problem === "no-repo" ? "NO_REPO" : "CONFIG", opened.problem === "no-repo" ? "shepherd: not inside a git repository." : opened.message), json, io);
    const { workflow, config } = opened.session;
    const result =
      command === "plan" ? await planCommand({ workflow, config, args, stdin: options.stdin ?? "", cwd }) : command === "plans" ? await plansCommand(workflow, args) : await taskCommand(workflow, args);
    return emit(result, json, io);
  } catch (error) {
    return emit(fail("ERROR", redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!)), json, io);
  }
}

/** The workspace is shepherd's state, never the user's code: it ignores itself, so hooks never leave untracked files. */
function ignoreWorkspace(workspace: string): void {
  const file = path.join(workspace, ".gitignore");
  if (existsSync(file)) return;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(file, "*\n");
}

/** The session opener `build`, `review` and `fix` share: the Workflow gets the command's own progress, herdr client and seams. */
function opener(cwd: string, options: CliOptions): OpenSession {
  return async (extras) => {
    const opened = await open(cwd, options, undefined, extras).catch((error: unknown) => ({ problem: "error" as const, message: redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!) }));
    if ("problem" in opened) return { problem: opened.problem === "no-repo" ? "shepherd: not inside a git repository." : opened.message };
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
    return emit(migrateConfig({ home: options.home, ...(options.cwd ? { cwd: options.cwd } : {}), force: rest.includes("--force") }), json, io);
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
