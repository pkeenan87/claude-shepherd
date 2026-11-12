/**
 * "Fix all in a tab": after /review, the findings are fixed by `models.medium` in a herdr tab instead of the main session
 * (an expensive, large-context model). `models.medium` is a Pi model (`pi -ne -e ticket-mode.ts`, ledgered from the
 * child's session files) or `agent:<name>[/<model>]` (metered from the agent's log, else one "not metered" row). Either way
 * every row is ledgered as "review fix" under REVIEWING, tier "medium"; no task is needed (the rows go to the session).
 *
 * Nothing is committed here: HEAD and the branch are recorded first, and a commit made anyway is undone with
 * `git reset --soft` while the checkout is still on the same branch (the changes stay staged); on another branch HEAD is
 * left alone and the result says so. A finished fix closes the tab and answers with what the model reported; a failed one
 * leaves the tab open and answers with the reason. Never throws.
 */
import path from "node:path";
import { modelText, type TicketModel } from "../agents.js";
import { registryProblem } from "../providers/usable.js";
import { redact } from "../redact.js";
import { messageOf, openTab, tabName, type Tab } from "../runner/tab.js";
import { herdrSpace } from "../runner/ticket.js";
import { SESSION_TASK_ID } from "./budget.js";
import type { WorkflowContext } from "./context.js";
import { agentProgram, piProgram, type Program } from "./tab-program.js";

export const FIX_REASON = "review fix";

/** The most of the model's reply that comes back in the result. */
const REPLY_CHARS = 1500;

export interface FixInput {
  prompt: string;
  model: TicketModel;
  /** The task the rows are ledgered under (`SESSION_TASK_ID` without one). */
  taskId: string;
  /** The task's readable name for the tab name; "" without a task. */
  taskName: string;
  /** Replaces the home directory an agent's usage log is read under (tests). */
  home?: string;
}

function fixPiProgram(ctx: WorkflowContext, model: Extract<TicketModel, { kind: "pi" }>, at: number): Program | { refused: string } {
  const problem = ctx.registry ? registryProblem(ctx.registry, model.provider, model.id) : `model ${model.id} cannot be checked: this Pi session has no model registry`;
  if (problem) return { refused: `${model.provider}/${model.id}: ${problem}. Change models.medium or sign in` };
  return piProgram(ctx, model, { sessionDir: path.join(ctx.store.root, "sessions", `review-fix-${at}`), label: "review-fix", job: FIX_REASON, tier: "medium" });
}

function fixAgentProgram(ctx: WorkflowContext, model: Extract<TicketModel, { kind: "agent" }>, input: FixInput): Program {
  return agentProgram(ctx, model, { ...(input.home ? { home: input.home } : {}), job: FIX_REASON, tier: "medium", phase: "REVIEWING", taskId: input.taskId });
}

/** Runs the fix in a herdr tab. Never throws: a failure is `{ ok: false }` with the reason, and the tab is left open. */
export async function runFixInTab(ctx: WorkflowContext, input: FixInput): Promise<{ ok: boolean; text: string }> {
  const { model } = input;
  const label = modelText(model);
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  let tab: Tab | undefined;
  try {
    const where = await herdrSpace(ctx.herdr, ctx.config.build.visibleTabs);
    if ("problem" in where) return { ok: false, text: `Fixing in a tab needs herdr: start Pi inside herdr (${where.problem}).` };
    if (model.kind === "pi" && !ctx.ticketModePath) return { ok: false, text: `Cannot fix on ${label}: this Pi session does not know where the ticket-mode extension is.` };
    const at = ctx.now().getTime();
    const program = model.kind === "agent" ? fixAgentProgram(ctx, model, input) : fixPiProgram(ctx, model, at);
    if ("refused" in program) return { ok: false, text: `Cannot fix on ${program.refused}.` };
    const name = tabName(input.taskName, "fix", 1, at);
    const headBefore = await ctx.git.head().catch(() => undefined);
    const branchBefore = await ctx.git.currentBranch().catch(() => undefined);
    progress(`opening ${label} in a herdr tab to fix the findings`);
    tab = await openTab({
      ...ctx.herdrTimings,
      ...(program.readyTimeoutMs ? { readyTimeoutMs: program.readyTimeoutMs } : {}),
      client: ctx.herdr!,
      ...(where.space ? { space: where.space } : {}),
      cwd: ctx.git.repoRoot,
      argv: program.argv,
      name,
      labels: { "shepherd.review-fix": name },
      progress,
      blockedNotice: `The fix (${label}) is waiting for you in herdr sub-agent ${name} (agents list)`,
    });
    const opened = tab;
    progress(`fixing in herdr tab ${opened.name} (${label})`);
    let failure: string | undefined;
    try {
      await opened.prompt(input.prompt);
    } catch (error) {
      failure = messageOf(error);
    }
    // Whatever the model spent is ledgered even when the turn failed: it happened.
    try {
      program.collect();
    } catch (error) {
      progress(`could not ledger the fix's usage: ${messageOf(error)}`);
    }
    const notes: string[] = [];
    const branchAfter = await ctx.git.currentBranch().catch(() => undefined);
    const headAfter = await ctx.git.head().catch(() => undefined);
    if (branchBefore && branchAfter && branchAfter !== branchBefore) {
      notes.push(`The fix left ${branchBefore} and is on ${branchAfter}; shepherd left HEAD alone.`);
    } else if (headBefore && headAfter && headAfter !== headBefore) {
      await ctx.git.resetSoft(headBefore);
      notes.push(`The fix committed anyway; shepherd moved HEAD back to ${headBefore.slice(0, 7)} (git reset --soft), so its changes are staged, not committed.`);
    }
    const reason = failure ?? program.failed?.();
    if (reason) return { ok: false, text: [`The fix on ${label} did not finish: ${reason} (the herdr tab ${opened.name} is left open to read).`, ...notes].join("\n") };
    const said = redact((await program.reply(opened)).trim()).slice(-REPLY_CHARS);
    await opened.close();
    tab = undefined;
    return { ok: true, text: [`Fixed in tab ${opened.name} (${label}), nothing committed.`, ...(said ? ["", said, ""] : []), ...notes, "Run /review to check."].join("\n") };
  } catch (error) {
    return { ok: false, text: `The fix on ${label} stopped: ${messageOf(error)}${tab ? ` (herdr tab ${tab.name} is left open)` : ""}.` };
  }
}
