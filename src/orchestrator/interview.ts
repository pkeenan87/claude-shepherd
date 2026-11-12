import { isDifficulty, WorkflowError, type AcceptedClassification, type CommandResult, type Complexity, type TaskState } from "../domain.js";
import { redact, redactUnknown } from "../redact.js";
import { defaultClassification, isSecuritySensitive, plannerClassification, type PlannerRating } from "./classification.js";
import { initAgentWatermark } from "./agent-sweep.js";
import { budgetState } from "./budget.js";
import { active, done, fail, guard, iso, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";
import { announceParked, newTask, retireCurrent } from "./planning.js";
import { activeTask, displayName } from "./tasks.js";

/** `interview.json` in the task folder: the request a /plan was started with. Older files also hold `rounds` of answered questions, which nothing reads now. */
export interface InterviewFile {
  version: 1;
  request: string;
}

/** A technical implementation plan, in the shape of an engineer's plan mode: what changes where, and how it is verified. */
export interface PlanSpec {
  summary: string;
  /** What the code does today in the area that changes, with the files and functions read. */
  context: string;
  /** The technical design: components, data flow, types and signatures, error handling. */
  approach: string;
  /** One entry per file to create, modify, or delete, with the concrete change. */
  changes: { path: string; change: string }[];
  /** Existing functions, types, and utilities to reuse, with their paths. */
  reuse: string[];
  decisions: { question: string; answer: string; rationale: string }[];
  assumptions: string[];
  outOfScope: string[];
  risks: string[];
  /** How to prove it works end to end: tests to add and commands to run. */
  verification: string[];
}

export const INTERVIEW_FILE = "interview.json";
export const SPEC_FILE = "spec.md";

export function readInterview(ctx: WorkflowContext, taskId: string): InterviewFile | undefined {
  const text = ctx.store.readText(taskId, INTERVIEW_FILE);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as InterviewFile;
    return parsed && typeof parsed.request === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeInterview(ctx: WorkflowContext, taskId: string, file: InterviewFile): void {
  ctx.store.writeText(taskId, INTERVIEW_FILE, `${JSON.stringify(redactUnknown(file), null, 2)}\n`);
}

/** The task whose /plan (spec or ticket stage) is being drafted now, with its interview file. */
export function activePlanning(ctx: WorkflowContext): { task: TaskState; interview: InterviewFile } | undefined {
  const task = active(ctx);
  if (!task?.planning || task.phase !== "PLANNING") return undefined;
  const interview = readInterview(ctx, task.taskId);
  return interview ? { task, interview } : undefined;
}

export function planningStatusText(ctx: WorkflowContext): string | undefined {
  const found = activePlanning(ctx);
  if (!found) return undefined;
  const { task } = found;
  if (task.planning!.stage === "tickets") return "plan · writing tickets";
  return task.planning!.revision ? "plan · revising" : "plan · writing spec";
}

/** Steps a task back to PLANNING from wherever it is, one legal edge at a time. */
function toPlanning(task: TaskState, at: string): TaskState {
  if (task.phase === "PLANNING") return task;
  const direct = ["PAUSED", "AWAITING_PLAN_APPROVAL", "FAILED", "BLOCKED", "COMPLETE", "IDLE"];
  return move(direct.includes(task.phase) ? task : move(task, "AWAITING_PLAN_APPROVAL", at), "PLANNING", at);
}

/** `shepherd plan start`: starts (or resumes) the plan. Claude Code drafts the spec and tickets; nothing here runs a model. */
export function startPlan(ctx: WorkflowContext, request: string): Promise<CommandResult> {
  return guard(async () => {
    const current = await activeTask(ctx);
    const text = request.trim();
    if (!text && !current?.planning) return fail("USAGE", "Usage: shepherd plan start \"<request>\"");
    const safe = redact(text);
    const at = iso(ctx);
    // Resume: no request, or the same request again, and a plan already being drafted. A different request is a new task.
    if (current?.planning && (!text || current.request === safe)) {
      if (readInterview(ctx, current.taskId)) {
        await ctx.store.update(current.taskId, "plan resumed", (task) => toPlanning(task, at));
        return done(`Resuming the plan for ${displayName(current)}. ${planningStatusText(ctx) ?? ""}`.trim(), { taskId: current.taskId, resumed: true });
      }
    }
    if (budgetState(ctx).status === "hard") {
      return fail("BUDGET", "Task or daily budget is exhausted. /plan was not run. Run /cost for details.");
    }
    // A request always starts a new task. A finished task is closed; any other is parked untouched (/plans switches back).
    const parked = await retireCurrent(ctx, current);
    // Until `plan spec` saves the planner's rating, the task has the default classification.
    const classification: AcceptedClassification = defaultClassification();
    const state = await ctx.store.create({ ...newTask(ctx, safe, at), classification, planning: { stage: "interview" } });
    announceParked(ctx, parked);
    await initAgentWatermark(ctx);
    writeInterview(ctx, state.taskId, { version: 1, request: safe });
    return done(`Planning ${displayName(state)}. ${planningStatusText(ctx)}`, { taskId: state.taskId });
  });
}

function planningOrThrow(ctx: WorkflowContext, stage: "interview" | "tickets"): { task: TaskState; interview: InterviewFile } {
  const found = activePlanning(ctx);
  if (!found) throw new WorkflowError("NO_INTERVIEW", "No /plan is running. Start one with /plan <request>.");
  if (found.task.planning!.stage !== stage) {
    throw new WorkflowError("WRONG_STAGE", stage === "interview" ? "The spec is saved. Call plan_tickets." : "Write the spec first with plan_spec, then call plan_tickets.");
  }
  return found;
}

export function renderSpec(spec: PlanSpec): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`) : ["- (none)"]);
  return [
    "# Spec",
    "",
    spec.summary,
    "",
    "## Context",
    "",
    spec.context || "(not recorded)",
    "",
    "## Approach",
    "",
    spec.approach,
    "",
    "## Files to change",
    "",
    ...(spec.changes.length ? spec.changes.map((item) => `- \`${item.path}\`: ${item.change}`) : ["- (none)"]),
    "",
    "## Reuse",
    ...list(spec.reuse),
    "",
    "## Decisions",
    ...(spec.decisions.length ? spec.decisions.flatMap((item) => ["", `### ${item.question}`, `Answer: ${item.answer}`, `Why: ${item.rationale}`]) : ["", "- (none)"]),
    "",
    "## Assumptions",
    ...list(spec.assumptions),
    "",
    "## Out of scope",
    ...list(spec.outOfScope),
    "",
    "## Risks",
    ...list(spec.risks),
    "",
    "## Verification",
    ...list(spec.verification),
    "",
  ].join("\n");
}

function texts(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be an array of strings.`);
    return [];
  }
  return value.map((item: string) => item.trim()).filter(Boolean);
}

/** Saves `spec.md` and moves planning on to the ticket stage. */
export async function savePlanSpec(ctx: WorkflowContext, input: unknown): Promise<{ file: string; classification: AcceptedClassification }> {
  // Also allowed at the ticket stage, so a change the person asks for during ticket review can reach the spec.
  const found = activePlanning(ctx);
  const { task } = found?.task.planning?.stage === "tickets" ? found : planningOrThrow(ctx, "interview");
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) errors.push("summary is required.");
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.map((item) => {
        const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return { question: String(entry.question ?? "").trim(), answer: String(entry.answer ?? "").trim(), rationale: String(entry.rationale ?? "").trim() };
      })
    : [];
  if (raw.decisions !== undefined && !Array.isArray(raw.decisions)) errors.push("decisions must be an array.");
  if (decisions.some((item) => !item.question || !item.answer)) errors.push("Every decision needs a question and an answer.");
  const context = typeof raw.context === "string" ? raw.context.trim() : "";
  const approach = typeof raw.approach === "string" ? raw.approach.trim() : "";
  if (!approach) errors.push("approach is required: the technical design (components, data flow, types and signatures).");
  const changes = Array.isArray(raw.changes)
    ? raw.changes.map((item) => {
        const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return { path: String(entry.path ?? "").trim(), change: String(entry.change ?? "").trim() };
      })
    : [];
  if (raw.changes !== undefined && !Array.isArray(raw.changes)) errors.push("changes must be an array.");
  else if (changes.length === 0) errors.push("changes needs at least one file: { path, change } naming what is added or modified there.");
  if (changes.some((item) => !item.path || !item.change)) errors.push("Every change needs a path and a description of the change.");
  const verification = texts(raw.verification, "verification", errors);
  if (verification.length === 0 && (raw.verification === undefined || Array.isArray(raw.verification))) errors.push("verification needs at least one step (a test to add or a command to run).");
  const spec: PlanSpec = {
    summary,
    context,
    approach,
    changes,
    reuse: texts(raw.reuse, "reuse", errors),
    decisions,
    assumptions: texts(raw.assumptions, "assumptions", errors),
    outOfScope: texts(raw.outOfScope, "outOfScope", errors),
    risks: texts(raw.risks, "risks", errors),
    verification,
  };
  const rating = plannerRating(raw, task.classification, errors);
  if (errors.length) throw new WorkflowError("SPEC_INVALID", errors.join("\n"));
  const file = ctx.store.writeText(task.taskId, SPEC_FILE, redact(renderSpec(spec)));
  // The planner's rating replaces the default classification. A rating left out keeps the one the task has.
  const classification = rating ? plannerClassification(rating) : task.classification ?? defaultClassification();
  await ctx.store.update(task.taskId, "spec saved", (current) => ({
    ...current,
    classification,
    planning: { stage: "tickets", ...(current.planning?.revision ? { revision: current.planning.revision } : {}) },
    updatedAt: iso(ctx),
  }));
  return { file, classification };
}

/**
 * The planner's rating from plan_spec's fields. Undefined when it gave none of them. A missing field falls back to the
 * task's current classification (and to not security-sensitive); a malformed one is an error.
 */
function plannerRating(raw: Record<string, unknown>, current: AcceptedClassification | undefined, errors: string[]): PlannerRating | undefined {
  const given = ["complexity", "risk", "securitySensitive", "classificationReason"].some((key) => raw[key] !== undefined);
  if (!given) return undefined;
  const level = (key: "complexity" | "risk"): Complexity => {
    const value = raw[key];
    if (value === undefined) return current?.[key] ?? "medium";
    if (typeof value === "string" && isDifficulty(value)) return value;
    errors.push(`${key} must be one of low, medium, high.`);
    return "medium";
  };
  const complexity = level("complexity");
  const risk = level("risk");
  if (raw.securitySensitive !== undefined && typeof raw.securitySensitive !== "boolean") errors.push("securitySensitive must be true or false.");
  if (raw.classificationReason !== undefined && typeof raw.classificationReason !== "string") errors.push("classificationReason must be a string.");
  return {
    complexity,
    risk,
    securitySensitive: raw.securitySensitive === undefined ? !!current && isSecuritySensitive(current) : raw.securitySensitive === true,
    reason: typeof raw.classificationReason === "string" ? raw.classificationReason : undefined,
  };
}

/**
 * Sends a drafted plan back to planning with the person's requested changes. The caller rewrites the spec and
 * tickets, and the plan returns for approval. Plan approval stays required.
 */
export async function requestPlanChanges(ctx: WorkflowContext, task: TaskState, feedback: string): Promise<CommandResult> {
  const text = redact(feedback.trim());
  if (!text) return fail("USAGE", "Describe the changes you want.");
  if (!readInterview(ctx, task.taskId)) return fail("NO_INTERVIEW", "This plan was not drafted by the /plan interview. Run /plan again with the changes in the request.");
  const at = iso(ctx);
  await ctx.store.update(task.taskId, "plan changes requested", (current) => ({
    ...toPlanning(current, at),
    approvedVersion: undefined,
    planning: { stage: "interview", revision: text },
  }));
  return done("Sent the plan back for changes. The revised plan will be shown for review again.", { taskId: task.taskId });
}
