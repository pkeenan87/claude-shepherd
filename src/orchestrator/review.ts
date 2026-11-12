import path from "node:path";
import { AGENT_PROVIDER, parseTicketModel, ranModelText, type TicketModel } from "../agents.js";
import { fromMicroUsd, toMicroUsd } from "../config.js";
import { ticketDifficulty, WorkflowError, type CommandResult, type ModelReview, type PlanDocument, type ReviewStage, type TaskState } from "../domain.js";
import { reviewDiff } from "../review/review.js";
import { redact } from "../redact.js";
import { atomicWrite } from "../storage/store.js";
import { budgetState, gateBudget, SESSION_TASK_ID } from "./budget.js";
import { done, excludedPaths, guard, iso, type WorkflowContext } from "./context.js";
import { activeTask } from "./tasks.js";
import { formatDuration } from "./format.js";
import { reviewItems, reviewMarkdown, type ReviewItem, type ReviewTicketRow } from "./review-report.js";
import { costLabel, reviewLabel } from "./build.js";
import { announce, reviewModel, routeFor, type Route } from "./routing.js";
import { carriedFindings } from "./ticket-review.js";
import { sweepAgentLogs } from "./agent-sweep.js";
import { runAgentReview } from "./agent-review.js";
import { splitCheckLine } from "./tickets.js";

export { reviewItems, reviewMarkdown, type ReviewItem };

/**
 * The checks a review runs: the configured ones, else every distinct check the plan's tickets carry (already
 * validated at plan time), so a project without `checks:` still gets tool evidence.
 */
export function reviewChecks(ctx: WorkflowContext, plan?: PlanDocument): { name: string; command: string; args: string[] }[] {
  if (ctx.config.checks.length > 0) return ctx.config.checks.map((check) => ({ name: check.name, command: check.command, args: check.args }));
  const lines = [...new Set((plan?.tickets ?? []).flatMap((ticket) => ticket.checks ?? []))];
  return lines.map((line) => ({ name: line, ...splitCheckLine(line) }));
}

/** The model that runs the /review model pass: `models.review`, or `override` (`--with`). It always runs in a herdr sub-agent that reads the repository itself (`agent-review.ts`). */
function passModel(ctx: WorkflowContext, override?: TicketModel): { route: Route; model: TicketModel } {
  const model = override ?? reviewModel(ctx.config);
  return { route: routeFor(ctx, "review", model), model };
}

/** `--with <ref>` from the arguments: the review model for this run. Throws a `USAGE`/`CONFIG_INVALID` error for anything else. */
export function parseReviewArgs(ctx: WorkflowContext, args: string): TicketModel | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words[0] !== "--with" || words.length !== 2) throw new WorkflowError("USAGE", "Use /review, or /review --with <provider/id | agent:name[/model]> to review with another model for this run.");
  return parseTicketModel(words[1]!, ctx.config);
}

/**
 * The model pass: the review model runs in a herdr sub-agent, reads the checkout and lists advisory findings. Budget-gated
 * first, each call ledgered under REVIEWING with reason "model review", and never a reason for the review to pass or fail.
 * Returns undefined when the pass is off: `review.model: false`, unless `--with` names a model.
 */
async function modelPass(ctx: WorkflowContext, taskId: string, plan: PlanDocument, picked: ReturnType<typeof passModel>, enabled: boolean, agentInput: Omit<Parameters<typeof runAgentReview>[1], "taskId" | "plan" | "model">): Promise<ModelReview | undefined> {
  if (!enabled) return undefined;
  if (picked.route.blocked) return { provider: "none", model: picked.route.label, findings: [], truncated: false, error: picked.route.blocked };
  const exhausted = budgetState(ctx, taskId).status === "hard" ? "the task or daily budget is exhausted." : undefined;
  if (exhausted) return picked.model.kind === "agent" ? { provider: AGENT_PROVIDER, model: picked.model.name, findings: [], truncated: false, error: exhausted } : { provider: picked.model.provider, model: picked.model.id, findings: [], truncated: false, error: exhausted };
  return runAgentReview(ctx, { ...agentInput, taskId, plan, model: picked.model }, (line) => ctx.progress?.(`Review: ${line}`));
}

/**
 * What the ledger entries of this review cost: the model pass. An unknown charge makes the stage unknown, never $0.
 * Undefined when the review made no billed call.
 */
function modelCost(ctx: WorkflowContext, taskId: string, sinceMs: number): ReviewStage | undefined {
  let sum: number | null | undefined;
  let metered = false;
  for (const entry of ctx.store.readLedger()) {
    if (entry.taskId !== taskId || new Date(entry.at).getTime() < sinceMs || entry.reason !== "model review") continue;
    // A subscription agent's "not metered" row is no dollar figure: the stage reads "not metered" unless something else billed.
    if (entry.meter !== "not-metered") metered = true;
    sum = sum === null || entry.actualUsd === null ? null : (sum ?? 0) + toMicroUsd(entry.actualUsd);
  }
  if (sum === undefined) return undefined;
  if (!metered) return { notMetered: true };
  return { costUsd: sum === null ? null : fromMicroUsd(sum) };
}

/** The plan's tickets for the Tickets table; none without a plan. */
function ticketRows(state: TaskState | undefined): ReviewTicketRow[] {
  return (state?.plan?.tickets ?? []).map((ticket) => {
    const run = state?.ticketRuns?.[ticket.id];
    return {
      id: ticket.id,
      difficulty: ticketDifficulty(ticket),
      implementer: run?.provider && run.model ? ranModelText(run.provider, run.model) : "—",
      review: reviewLabel(run),
      cost: run ? costLabel(run) : "—",
    };
  });
}

/** "20261014-120000" from the injected clock. */
function stamp(ctx: WorkflowContext): string {
  return ctx.now().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

/**
 * The ref to diff against. On a branch: the local base branch, else its remote-tracking copy. On the base branch
 * itself, `origin/<base>` when it exists (so local commits it lacks are reviewed too), else the branch (uncommitted
 * changes only).
 */
async function baseRef(ctx: WorkflowContext, base: string, onBase: boolean): Promise<string> {
  const exists = async (ref: string) => (await ctx.git.git(["rev-parse", "--verify", "--quiet", ref])).code === 0;
  if (onBase) return (await exists(`refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
  if (await exists(`refs/heads/${base}`)) return base;
  if (await exists(`refs/remotes/origin/${base}`)) return `origin/${base}`;
  return base;
}

const numbered = (items: ReviewItem[]) => items.map((item, index) => `${index + 1}. ${item.text}`).join("\n");

/**
 * The message that sends findings to a model: the current session's (`tab` false), or a model in its own herdr tab, which
 * gets no "run /review again" (it cannot) and is told to stop when done.
 */
export function fixMessage(items: ReviewItem[], checks: { command: string; args: string[] }[], request?: string, tab = false): string {
  const commands = checks.map((check) => `- \`${[check.command, ...check.args].join(" ")}\``);
  return redact(
    [
      request ? `Fix this from the review: ${request}` : `Fix all ${items.length} finding(s) from the review.`,
      "",
      request ? "All findings, for reference (the numbers match the list):" : "Findings:",
      numbered(items),
      "",
      "Rules:",
      "- Fix them in this working tree and keep the changes scoped to what is listed.",
      ...(commands.length ? ["- Run these checks and make them pass:", ...commands] : ["- No checks are configured; run the project's own tests if it has any."]),
      "- Do not commit, push, or switch branches.",
      "- Finish with one line per finding addressed, and say which ones you left and why.",
      "",
      ...(tab ? ["Then stop."] : ["Run /review again when done."]),
    ].join("\n"),
  );
}

/**
 * `/review`: reviews whatever differs from the base branch (commits ahead of it, uncommitted and untracked edits) with
 * the checks, a static scan, and the advisory model pass. Nothing is committed or pushed. With a UI, the findings open
 * in a dialog that offers to send them to the model in this session. A task is optional.
 */
export function review(ctx: WorkflowContext, args = ""): Promise<CommandResult> {
  return guard(() => runReview(ctx, parseReviewArgs(ctx, args)));
}

async function runReview(ctx: WorkflowContext, override?: TicketModel): Promise<CommandResult> {
  const found = await activeTask(ctx);
  const state = found && found.phase !== "COMPLETE" && found.phase !== "IDLE" ? found : undefined;
  const taskId = state?.taskId ?? SESSION_TASK_ID;
  const base = state?.build?.base ?? (await ctx.git.defaultBranch());
  const branch = await ctx.git.currentBranch();
  const ref = await baseRef(ctx, base, branch === base);
  // Workflow state is not the user's code: it stays out of the review and out of every model packet.
  const rawDiff = await ctx.git.workingDiff(ref, excludedPaths(ctx));
  if (!rawDiff.trim()) return done(`Nothing to review: no changes against ${base}.`);
  await sweepAgentLogs(ctx);
  const exhausted = gateBudget(ctx, taskId);
  if (exhausted) return exhausted;

  const plan = state?.plan;
  const picked = passModel(ctx, override);
  // `--with` asks for the model pass by name, so it runs even when `review.model` is off.
  const modelOn = ctx.config.review.model || override !== undefined;
  await announce(ctx, state?.taskId, "review", picked.route);
  const started = ctx.now().getTime();
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  const checks = reviewChecks(ctx, plan);
  progress(`started · ${branch} against ${ref} · ${ctx.config.setup.length} setup step(s), ${checks.length} check(s) · model ${modelOn ? (picked.route.blocked ? `unavailable (${picked.route.blocked})` : picked.route.label) : "off"}`);
  const report = await reviewDiff({
    diff: rawDiff,
    checks,
    setup: ctx.config.setup,
    now: () => ctx.now().getTime(),
    onProgress: progress,
    cwd: ctx.git.repoRoot,
    runner: ctx.checkRunner,
    planAcceptance: plan?.acceptance ?? [],
  });
  const reviewPlan: PlanDocument = plan ?? { version: 0, createdAt: iso(ctx), summary: `Ad-hoc changes on ${branch}.`, risks: [], acceptance: [], groups: [], overlap: [], securitySensitive: false };
  const mergeBase = await ctx.git.mergeBase(ref).catch(() => ref);
  const modelReview = await modelPass(ctx, taskId, reviewPlan, picked, modelOn, { hasTask: !!state, base: { ref, sha: mergeBase }, exclude: excludedPaths(ctx), stamp: stamp(ctx) });
  report.modelReview = modelReview;
  const carried = carriedFindings(state, modelReview?.findings);
  if (carried.length > 0) report.carried = carried;
  report.elapsedMs = ctx.now().getTime() - started;
  report.at = iso(ctx);
  report.headSha = await ctx.git.head().catch(() => undefined);
  report.stages = {
    ...report.stages,
    ...(modelReview ? { model: { elapsedMs: modelReview.elapsedMs, ...modelCost(ctx, taskId, started) } } : {}),
  };
  const setupConfigured = ctx.config.setup.length > 0;
  const saved = state ? `.shepherd/tasks/${state.taskId}/reports/review.md` : `.shepherd/reports/review-${stamp(ctx)}.md`;
  const markdown = reviewMarkdown(report, { setupConfigured, savedAs: saved, tickets: ticketRows(state) });
  ctx.report?.(markdown);
  if (state) {
    ctx.store.writeText(state.taskId, "reports/review.json", JSON.stringify(report, null, 2));
    ctx.store.writeText(state.taskId, "reports/review.md", markdown);
    await ctx.store.update(state.taskId, "review", (task) => ({ ...task, review: report, updatedAt: iso(ctx) }));
  } else {
    const name = path.join(ctx.store.root, "reports", `review-${stamp(ctx)}`);
    atomicWrite(`${name}.json`, JSON.stringify(report, null, 2));
    atomicWrite(`${name}.md`, markdown);
  }

  // The chat block above holds the detail; the command result stays short.
  const text = ctx.report ? `${report.summary} (${formatDuration(report.elapsedMs)}; details above)` : markdown;
  const items = reviewItems(report);
  const result = (message: string): CommandResult =>
    report.passed ? { ok: true, text: message, data: report } : { ok: false, code: "REVIEW_BLOCKING", text: `${message}\nFix the problems, then /shepherd:review again. Nothing was committed or pushed.`, data: report };
  // Without a chat block the result is the report: a model stage that could not run must stay in it.
  if (items.length === 0 && report.passed && (!!ctx.report || !report.modelReview?.error)) return result(`Review passed: ${report.checks.length} check(s), no findings.`);
  return result(text);
}
