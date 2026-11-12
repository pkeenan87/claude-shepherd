/**
 * What `shepherd review` and `shepherd fix` share: the latest saved review report (a task's `state.review`, else the newest
 * ad-hoc `reports/review-<stamp>.json`), and the fix on its findings, in a herdr sub-agent or as text for this chat.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { modelText, parseTicketModel, type TicketModel } from "../agents.js";
import type { CommandResult, ReviewReport } from "../domain.js";
import { herdrSpace } from "../runner/ticket.js";
import { gateBudget, SESSION_TASK_ID } from "./budget.js";
import { done, fail, type WorkflowContext } from "./context.js";
import { runFixInTab } from "./review-fix.js";
import { reviewChecks, fixMessage } from "./review.js";
import { reviewItems, reviewRows } from "./review-report.js";
import { activeTask, displayName } from "./tasks.js";

export interface LatestReview {
  report: ReviewReport;
  /** The markdown report on disk (its `.json` sits beside it). */
  file: string;
  taskId: string;
  taskName: string;
}

/** The report of the open task, else the newest ad-hoc one; undefined when there is none. */
export async function latestReview(ctx: WorkflowContext): Promise<LatestReview | undefined> {
  const found = await activeTask(ctx);
  const state = found && found.phase !== "COMPLETE" && found.phase !== "IDLE" ? found : undefined;
  if (state) {
    const dir = path.join(ctx.store.taskDir(state.taskId), "reports");
    const json = path.join(dir, "review.json");
    const report = state.review ?? (existsSync(json) ? (JSON.parse(readFileSync(json, "utf8")) as ReviewReport) : undefined);
    return report ? { report, file: path.join(dir, "review.md"), taskId: state.taskId, taskName: displayName(state) } : undefined;
  }
  const dir = path.join(ctx.store.root, "reports");
  const name = existsSync(dir) ? readdirSync(dir).filter((item) => /^review-\d{8}-\d{6}\.json$/.test(item)).sort().pop() : undefined;
  if (!name) return undefined;
  try {
    return { report: JSON.parse(readFileSync(path.join(dir, name), "utf8")) as ReviewReport, file: path.join(dir, name.replace(/\.json$/, ".md")), taskId: SESSION_TASK_ID, taskName: "" };
  } catch {
    return undefined;
  }
}

/** The numbered findings of a report as data: `risk` is the label of the table (`L7×S8=56`, or BLOCKING/SUGGESTION); `line` is not recorded, so null. */
export function findingsData(report: ReviewReport): { n: number; title: string; file: string | null; line: number | null; risk: string }[] {
  return reviewRows(report).map((row) => ({ n: row.n!, title: row.finding, file: row.file ?? null, line: null, risk: row.risk }));
}

/** `models.medium` when it can fix in a tab here (inside herdr; a Pi model also needs the worker extension and `pi`), else why not. */
export async function fixModel(ctx: WorkflowContext): Promise<{ model: TicketModel } | { problem: string }> {
  let model: TicketModel;
  try {
    model = parseTicketModel(ctx.config.models.medium, ctx.config);
  } catch (error) {
    return { problem: `models.medium is not usable: ${(error as Error).message}` };
  }
  const where = await herdrSpace(ctx.herdr, ctx.config.build.visibleTabs);
  if ("problem" in where) return { problem: `fixing in a tab needs herdr (${where.problem})` };
  if (model.kind === "pi" && !ctx.ticketModePath) return { problem: `${modelText(model)} is a Pi model and this install does not know where the ticket-mode extension is` };
  return { model };
}

const nothing = () => fail("NO_REVIEW", "No review to fix yet: run /review first.");

/** `shepherd fix --tab`: the latest report's findings fixed by `models.medium` in a herdr sub-agent. Budget-gated; never commits. */
export async function fixLatestInTab(ctx: WorkflowContext): Promise<CommandResult> {
  const latest = await latestReview(ctx);
  if (!latest) return nothing();
  const items = reviewItems(latest.report);
  if (items.length === 0) return done("The latest review has no findings to fix.");
  const exhausted = gateBudget(ctx, latest.taskId);
  if (exhausted) return exhausted;
  const picked = await fixModel(ctx);
  if ("problem" in picked) return fail("NEEDS_HERDR", `Cannot fix in a tab: ${picked.problem}.`);
  const found = await activeTask(ctx);
  const checks = reviewChecks(ctx, found?.plan);
  const fixed = await runFixInTab(ctx, { prompt: fixMessage(items, checks, undefined, true), model: picked.model, taskId: latest.taskId, taskName: latest.taskName });
  return fixed.ok ? done(fixed.text, { report: latest.file, findings: items.length }) : fail("REVIEW_FIX_FAILED", fixed.text);
}

/** `shepherd fix --list`: the message "Fix all" sends to a model: the numbered findings and the rules. */
export async function fixList(ctx: WorkflowContext): Promise<CommandResult> {
  const latest = await latestReview(ctx);
  if (!latest) return nothing();
  const items = reviewItems(latest.report);
  if (items.length === 0) return done("The latest review has no findings to fix.");
  const found = await activeTask(ctx);
  return done(fixMessage(items, reviewChecks(ctx, found?.plan)), { report: latest.file, findings: findingsData(latest.report) });
}
