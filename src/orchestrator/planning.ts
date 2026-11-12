import path from "node:path";
import type { CommandResult, TaskState } from "../domain.js";
import { done, fail, guard, iso, type WorkflowContext } from "./context.js";
import { assertGraph, PLAN_FILE, renderPlanReview } from "./plan.js";
import { SPEC_FILE } from "./interview.js";
import { closeTask, displayName, isFinished, nameForNewTask, requireActiveTask, stateText } from "./tasks.js";

export function blank(taskId: string, request: string, at: string, name?: string): TaskState {
  return {
    taskId,
    ...(name ? { name } : {}),
    phase: "PLANNING",
    createdAt: at,
    updatedAt: at,
    phaseEnteredAt: at,
    request,
  };
}

/** A new task for a request: a fresh id (the directory name) and a readable name that no other task uses. */
export function newTask(ctx: WorkflowContext, request: string, at: string): TaskState {
  const taskId = `task-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${ctx.id()}`;
  return blank(taskId, request, at, nameForNewTask(ctx, request));
}

/**
 * What the active task becomes when a new /plan starts. A finished task (all tickets built and the review passed,
 * or an older published one) is closed. Any other unfinished task is left exactly as it is and is returned: it is parked, and the caller says so
 * once the new task exists. /plan never revises another task's plan.
 */
export async function retireCurrent(ctx: WorkflowContext, task: TaskState | undefined): Promise<TaskState | undefined> {
  if (!task || task.phase === "COMPLETE" || task.phase === "IDLE") return undefined;
  if (isFinished(task)) {
    await closeTask(ctx, task.taskId, "closed by a new plan");
    ctx.progress?.(`Closed ${displayName(task)}.`);
    return undefined;
  }
  return task;
}

/** The chat line for a task that a new /plan parked. */
export function announceParked(ctx: WorkflowContext, parked: TaskState | undefined): void {
  if (!parked) return;
  const name = displayName(parked);
  ctx.progress?.(`Parked ${name} (${stateText(parked)}). /plans ${name} switches back.`);
}

/** The plan document for a task as it is shown for review: `plan.md`, or rendered from the stored plan. */
export function planMarkdown(ctx: WorkflowContext, task: TaskState): string {
  return ctx.store.readText(task.taskId, PLAN_FILE) ?? renderPlanReview(task.plan!, ctx.store.readText(task.taskId, SPEC_FILE), ctx.config);
}

/** Freezes the draft as plan.v{N}.approved.json and records the approved version. No dialog and no session reset. */
export async function freezeApproval(ctx: WorkflowContext, state: TaskState): Promise<TaskState> {
  const plan = state.plan!;
  const body = `${JSON.stringify(plan, null, 2)}\n`;
  ctx.store.writeOnceText(state.taskId, `plan.v${plan.version}.approved.json`, body);
  const at = iso(ctx);
  return ctx.store.update(state.taskId, "plan approved", (task) => ({ ...task, approvedVersion: task.plan?.version, approvedAt: at, updatedAt: at }));
}

/** Approves the active draft (the choice was already made on a review screen). */
export function approveDraft(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const current = await requireActiveTask(ctx);
    if (current.phase !== "AWAITING_PLAN_APPROVAL" || !current.plan) {
      return fail("APPROVAL_REQUIRED", "There is no draft waiting for approval.");
    }
    const version = current.plan.version;
    if (current.approvedVersion === version) return done(`Plan v${version} is already approved.`);
    assertGraph(current.plan.groups);
    const state = await freezeApproval(ctx, current);
    return done(`Approved plan v${version}. Run /build.`, state);
  });
}

/** The active task's plan as markdown. */
export function showPlan(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => showTaskPlan(ctx, await requireActiveTask(ctx)));
}

/** One task's plan as markdown, under a header that names the task and its state. Shared by `plan show` and `/plans <name>`. */
export async function showTaskPlan(ctx: WorkflowContext, current: TaskState): Promise<CommandResult> {
  if (!current.plan) return fail("NO_PLAN", `${displayName(current)} has no plan yet. Run /plan <request>.`);
  const header = `**Task ${displayName(current)}** · ${stateText(current)}`;
  const markdown = `${header}\n\n${planMarkdown(ctx, current)}`;
  const where = path.join(ctx.store.taskDir(current.taskId), PLAN_FILE);
  return done(markdown, { taskId: current.taskId, file: where });
}
