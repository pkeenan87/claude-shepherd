import path from "node:path";
import { loadConfig, type WorkflowConfig } from "../config.js";
import { type CommandResult, type CostRecord, type TicketRun, type TokenUsage } from "../domain.js";
import { GitWorkspace } from "../git/workspace.js";
import { TaskStore } from "../storage/store.js";
import { buildReport, finishChunk, nextChunk, peekNextTicket, startBuild, unstartChunk } from "./build.js";
import { budgetState, observeUsage, recordAgentUsage, recordPiUsage } from "./budget.js";
import { active, fail, guard, type WorkflowContext } from "./context.js";
import { ledgerChildSession, sweepTicketSessions } from "../herdr/session-file.js";
import { activeTask, displayName } from "./tasks.js";
import { isSessionLog, sweepAgentLogs, type SweepOptions } from "./agent-sweep.js";
import { cachingRunner, defaultRunner } from "./exec.js";
import { requestPlanChanges, savePlanSpec, startPlan, activePlanning } from "./interview.js";
import { checkTickets, commitTickets, requireTicketStage } from "./ticket-plan.js";
import { plans } from "./plans.js";
import { approveDraft, showPlan } from "./planning.js";
import { review } from "./review.js";
import { fixList, fixLatestInTab, fixModel, latestReview } from "./review-latest.js";
import { cost } from "./reports.js";
import type { WorkflowOptions } from "./types.js";

export type { WorkflowOptions } from "./types.js";

/**
 * Public facade. Each command lives in its own module as a function of a shared WorkflowContext;
 * this class owns the context.
 */
export class Workflow {
  readonly store: TaskStore;
  readonly git: GitWorkspace;
  readonly cwd: string;
  private readonly ctx: WorkflowContext;

  constructor(options: WorkflowOptions) {
    this.cwd = options.cwd;
    const config = options.config ?? loadConfig(options.cwd);
    this.store = options.store ?? new TaskStore(path.join(options.cwd, config.workspaceDir));
    this.git = options.git ?? new GitWorkspace(options.cwd);
    const ctx: WorkflowContext = {
      cwd: this.cwd,
      config,
      store: this.store,
      git: this.git,
      now: options.now ?? (() => new Date()),
      id: options.id ?? (() => `id-${Math.random().toString(16).slice(2, 10)}`),
      checkRunner: cachingRunner(this.git, options.runner ?? defaultRunner),
      warned: new Set(),
      confirm: options.confirm ?? (async () => false),
      notify: options.notify ?? ((message) => this.store.notify(message)),
      progress: options.progress,
      report: options.report,
      herdr: options.herdr,
      herdrTimings: options.herdrTimings,
      ticketModePath: options.ticketModePath,
      piAvailable: options.piAvailable,
      agentLogHome: options.agentLogHome,
      dailyRecords: options.dailyRecords,
      knownSessions: options.knownSessions,
    };
    this.ctx = ctx;
  }

  /** The config in effect. It changes when `reconfigure` is called. */
  get config(): WorkflowConfig {
    return this.ctx.config;
  }

  /** Applies a reloaded config without rebuilding the workflow. */
  reconfigure(config: WorkflowConfig): void {
    this.ctx.config = config;
  }

  activeTaskId(): string | undefined {
    return this.store.readActive();
  }

  /** `shepherd plan start`: starts or resumes the plan being drafted. */
  startPlan(request: string): Promise<CommandResult> {
    return startPlan(this.ctx, request);
  }

  /** The stage of the /plan being drafted ("interview" until the spec is saved, then "tickets"), else undefined. */
  planningStage(): "interview" | "tickets" | undefined {
    return activePlanning(this.ctx)?.task.planning?.stage;
  }

  /** The active task's and today's spend against the budgets (the stored active task, no git call). */
  budgetState(taskId?: string) {
    return budgetState(this.ctx, taskId ?? active(this.ctx)?.taskId);
  }

  /** The active task, resolved from the checked-out branch (see `activeTask`). */
  activeTask() {
    return activeTask(this.ctx);
  }

  /** Whether an agent log file is a main session's own transcript (or its subagents'), which agent meters never count. */
  isSessionLog(file: string): boolean {
    return isSessionLog(this.ctx, file);
  }

  /** The agent-log sweep (see `sweepAgentLogs`): ledgers use that shepherd did not start, and the main session's own turns. */
  sweepAgentLogs(options?: SweepOptions) {
    return sweepAgentLogs(this.ctx, options);
  }

  savePlanSpec(input: unknown) {
    return savePlanSpec(this.ctx, input);
  }

  /** Throws unless the spec is saved and the tickets may be written. */
  requireTicketStage(): void {
    requireTicketStage(this.ctx);
  }

  checkTickets(input: unknown) {
    return checkTickets(this.ctx, input);
  }

  commitTickets(tickets: Parameters<typeof commitTickets>[1]) {
    return commitTickets(this.ctx, tickets);
  }

  /** Sends the active draft back to planning with the person's requested changes (the caller redrafts). */
  async reviseDraft(feedback: string): Promise<CommandResult> {
    const task = await activeTask(this.ctx);
    return task ? requestPlanChanges(this.ctx, task, feedback) : fail("NO_TASK", "No active task.");
  }

  /** Approves the active draft: freezes plan.vN.approved.json. */
  approveDraft(): Promise<CommandResult> {
    return approveDraft(this.ctx);
  }

  showPlan(): Promise<CommandResult> {
    return showPlan(this.ctx);
  }

  /** `/plans`: list the tasks, switch to one, or close one. */
  plans(arg = ""): Promise<CommandResult> {
    return plans(this.ctx, arg);
  }

  /** `/build`: starts or resumes the build (branch, budget, approval). The ticket loop is `runBuild` (`build.ts`). */
  startBuild(): Promise<CommandResult> {
    return startBuild(this.ctx);
  }

  /** The first ticket not done, in build order. */
  peekTicket(): ReturnType<typeof peekNextTicket> {
    return peekNextTicket(this.ctx);
  }

  releaseBuild(): void {
    const taskId = this.store.readActive();
    if (taskId) this.store.releaseBuild(taskId);
  }

  /** The build is done or stopped: clears the active task's build-in-progress marker (the pretool guard stops applying). */
  endBuild(): void {
    const taskId = this.store.readActive();
    if (taskId) this.store.clearBuilding(taskId);
  }

  /** The next ticket to build, routed and with its prompt, or `done`. */
  nextChunk(): ReturnType<typeof nextChunk> {
    return nextChunk(this.ctx);
  }

  /** Checks, commit, and bookkeeping for the chunk that just ran. */
  finishChunk(ticketId: string, result: { lastText: string; aborted: boolean }, options: { final?: boolean } = {}): ReturnType<typeof finishChunk> {
    return finishChunk(this.ctx, ticketId, result, options);
  }

  /** Rolls a ticket back to not started when its session never took its first turn. */
  unstartChunk(ticketId: string, previous?: TicketRun): Promise<void> {
    return unstartChunk(this.ctx, ticketId, previous);
  }

  /** The build's ticket table and next step, as markdown. */
  buildReport(stopped?: string): string {
    return buildReport(this.ctx, stopped);
  }

  /** The branch /build made for the active task, while it has a build. */
  buildBranch(): string | undefined {
    const id = this.store.readActive();
    return id ? this.store.load(id)?.build?.branch : undefined;
  }

  /** One-line progress event, when a listener is bound. */
  progress(text: string): void {
    this.ctx.progress?.(text);
  }

  /** Multi-line markdown block (a ticket's result, the build table), when a listener is bound. */
  report(markdown: string): void {
    this.ctx.report?.(markdown);
  }

  /** `/review [--with <model>]`: checks, static scan, and the advisory model pass over the changes against the base branch; offers to fix the findings in this session. Never commits or pushes. */
  review(args = ""): Promise<CommandResult> {
    return review(this.ctx, args);
  }

  /** The latest saved review report and where it is on disk; undefined before any review. */
  latestReview() {
    return latestReview(this.ctx);
  }

  /** `models.medium` when "Fix all in a tab" can run here, else why not. */
  fixModel() {
    return fixModel(this.ctx);
  }

  /** `shepherd fix --tab`: the latest report's findings fixed by `models.medium` in a herdr sub-agent. Never commits. */
  fixInTab(): Promise<CommandResult> {
    return guard(() => fixLatestInTab(this.ctx));
  }

  /** `shepherd fix --list`: the findings and rules as text, for fixing in the chat. */
  fixList(): Promise<CommandResult> {
    return guard(() => fixList(this.ctx));
  }


  cost(format = ""): Promise<CommandResult> {
    return cost(this.ctx, format);
  }

  observeUsage(input: { provider: string; model: string; usage: TokenUsage }, extra?: Parameters<typeof observeUsage>[2]): CostRecord | undefined {
    return observeUsage(this.ctx, input, extra);
  }

  /** `<task dir>/sessions` of the active task: where the Pi ticket runner keeps a child's session dirs and status files. */
  ticketSessionsRoot(): string | undefined {
    const state = active(this.ctx);
    return state ? path.join(this.store.taskDir(state.taskId), "sessions") : undefined;
  }

  /** The active task's readable name (for a herdr tab name). */
  ticketSessionsName(): string {
    const state = active(this.ctx);
    return state ? displayName(state) : "";
  }

  /** Ledgers a Pi ticket child's new session entries (`src/herdr/session-file.ts`). */
  ledgerChildSession(files: Parameters<typeof ledgerChildSession>[1], options: Parameters<typeof ledgerChildSession>[2]): CostRecord[] {
    return ledgerChildSession(this.ctx, files, options);
  }

  /** The resume sweep over a ticket's earlier child session dirs. */
  sweepTicketSessions(ticketId: string, options: Parameters<typeof sweepTicketSessions>[2] = {}): CostRecord[] {
    return sweepTicketSessions(this.ctx, ticketId, options);
  }

  /** Ledgers what an external agent spent on a ticket (`src/runner/agent-usage.ts`): metered calls, or one "not metered" row. */
  recordAgentUsage(input: Parameters<typeof recordAgentUsage>[1]): CostRecord[] {
    return recordAgentUsage(this.ctx, input);
  }

  /** A ticket meter has read an agent log to `offset`: the repo's watermark moves there so the sweep skips it (asynchronous: the watermark lock orders it before any later sweep in this process). */
  advanceAgentLog(file: string, offset: number, owner?: string): void {
    this.store.advanceAgentLog(file, offset, owner).catch(() => undefined);
  }

  /** Ledgers the calls Pi made on its own (cache warming, its own compaction and branch summaries) from the session file. */
  recordPiUsage(input: Parameters<typeof recordPiUsage>[1]): CostRecord[] {
    return recordPiUsage(this.ctx, input);
  }

  now(): Date {
    return this.ctx.now();
  }
}
