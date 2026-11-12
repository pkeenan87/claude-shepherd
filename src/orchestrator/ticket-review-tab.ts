/**
 * The per-ticket review run in a herdr tab (outside Pi, where there is no model call to make): `models.review` is an
 * external agent (`agent:<name>`) or a Pi model (`provider/id`, a `pi -ne -e ticket-mode.ts` child), like /review's model pass
 * and "Fix all in a tab". The reviewer reads the checkout itself (`git diff HEAD`), writes its scored findings as JSON to a file
 * under the task's reports dir, and shepherd reads that file with the same parser, risk filter and verdict rule as the
 * one-shot review, so the ticket gate is the same. Its spend is ledgered as "ticket review · ticket <id>", tier "review".
 *
 * The review runs before the commit, which takes the whole tree: the reviewer is told not to edit anything, HEAD and the
 * branch are recorded first (a commit it makes anyway is undone with `git reset --soft`), and the diff is fingerprinted
 * before and after, so a review that changed the tree is reported rather than trusted. The tab is closed once the
 * findings were read; a failed review leaves it open to read. Never throws: any failure is an `error`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { modelText, type TicketModel } from "../agents.js";
import { fromMicroUsd, toMicroUsd } from "../config.js";
import type { Ticket, TaskState } from "../domain.js";
import { redact } from "../redact.js";
import { messageOf, openTab, tabName, type Tab } from "../runner/tab.js";
import { herdrSpace } from "../runner/ticket.js";
import { budgetState } from "./budget.js";
import { excludedPaths, type WorkflowContext } from "./context.js";
import { displayName } from "./tasks.js";
import { agentProgram, piProgram, type Program } from "./tab-program.js";

/** A review is one pass over a diff, not a ticket: its own wall-clock limit, never shorter than the configured per-call time. */
const MIN_REVIEW_MS = 15 * 60_000;

export interface TabAsked<T> {
  parsed?: T;
  /** Cost of the tab's spend; null when any of it is unknown. */
  costUsd: number | null;
  by?: string;
  error?: string;
}

export interface TabReviewInput<T> {
  state: TaskState;
  ticket: Ticket;
  model: TicketModel;
  /** The review rounds so far on this rung plus one, for the tab name. */
  round: number;
  /** The prompt, given the absolute path the findings file is to be written to. */
  prompt(outFile: string): string;
  parse(text: string): T | undefined;
  progress(line: string): void;
}

const fingerprint = (diff: string) => createHash("sha256").update(diff).digest("hex");

export async function askInTab<T>(ctx: WorkflowContext, input: TabReviewInput<T>): Promise<TabAsked<T>> {
  const { state, ticket, model, progress } = input;
  const label = modelText(model);
  let cost: number | null = 0;
  let tab: Tab | undefined;
  const failed = (error: string): TabAsked<T> => ({ costUsd: cost, error });
  try {
    if (budgetState(ctx, state.taskId).status === "hard") return failed("the task or daily budget is exhausted");
    const where = await herdrSpace(ctx.herdr, ctx.config.build.visibleTabs);
    if ("problem" in where) return failed(`${label} reviews in a herdr sub-agent; run from a terminal inside herdr (${where.problem})`);
    if (model.kind === "pi" && !ctx.ticketModePath) return failed(`${label} is a Pi model and this install does not know where the ticket-mode extension is`);
    const at = ctx.now().getTime();
    const taskDir = ctx.store.taskDir(state.taskId);
    const reports = path.join(taskDir, "reports");
    mkdirSync(reports, { recursive: true });
    const outFile = path.resolve(reports, `ticket-review-${ticket.id}-${at}.json`);
    if (existsSync(outFile)) unlinkSync(outFile);
    const ledger = { job: "ticket review", tier: "review", phase: state.phase, taskId: state.taskId, ticketId: ticket.id };
    // The agent's log is snapshotted when its program is made, before the tab opens.
    const program: Program =
      model.kind === "agent" ? agentProgram(ctx, model, ledger) : piProgram(ctx, model, { ...ledger, sessionDir: path.join(taskDir, "sessions", `review-${ticket.id}-${at}`), label: `review-${ticket.id}` });
    const exclude = excludedPaths(ctx);
    const headBefore = await ctx.git.head().catch(() => undefined);
    const branchBefore = await ctx.git.currentBranch().catch(() => undefined);
    const before = fingerprint(await ctx.git.workingDiff("HEAD", exclude));
    const name = tabName(displayName(state), `r${ticket.id}`, input.round, at);
    progress(`opening ${label} in a herdr sub-agent`);
    tab = await openTab({
      ...ctx.herdrTimings,
      ...(program.readyTimeoutMs ? { readyTimeoutMs: program.readyTimeoutMs } : {}),
      turnTimeoutMs: ctx.herdrTimings?.turnTimeoutMs ?? Math.max(ctx.config.review.timeoutMs, MIN_REVIEW_MS),
      client: ctx.herdr!,
      ...(where.space ? { space: where.space } : {}),
      cwd: ctx.git.repoRoot,
      argv: program.argv,
      ...(program.trust ? { trust: program.trust } : {}),
      name,
      labels: { "shepherd.ticket-review": ticket.id },
      progress,
      blockedNotice: `The review of ticket ${ticket.id} (${label}) is waiting for you in herdr sub-agent ${name} (agents list)`,
    });
    const opened = tab;
    let failure: string | undefined;
    try {
      await opened.prompt(input.prompt(outFile));
    } catch (error) {
      failure = messageOf(error);
    }
    // What the reviewer spent is ledgered even when the turn failed: it happened.
    try {
      let micro: number | null = 0;
      for (const row of program.collect()) micro = micro === null || row.actualUsd === null ? null : micro + toMicroUsd(row.actualUsd);
      cost = micro === null ? null : fromMicroUsd(micro);
    } catch (error) {
      cost = null;
      progress(`could not ledger the review's usage: ${messageOf(error)}`);
    }
    const left = (why: string) => `${why} (the herdr sub-agent ${opened.name} is left open to read)`;
    const branchAfter = await ctx.git.currentBranch().catch(() => undefined);
    const headAfter = await ctx.git.head().catch(() => undefined);
    if (branchBefore && branchAfter && branchAfter !== branchBefore) return failed(left(`${label} left ${branchBefore} and is on ${branchAfter}; shepherd left HEAD alone`));
    let note = "";
    if (headBefore && headAfter && headAfter !== headBefore) {
      await ctx.git.resetSoft(headBefore);
      note = ` (it committed anyway; shepherd moved HEAD back to ${headBefore.slice(0, 7)})`;
    }
    const reason = failure ?? program.failed?.();
    if (reason) return failed(left(`${label} did not finish: ${reason}${note}`));
    if (!existsSync(outFile)) return failed(left(`${label} did not write the findings file ${outFile}${note}`));
    const parsed = input.parse(readFileSync(outFile, "utf8"));
    if (parsed === undefined) return failed(left(`the findings file ${outFile} from ${label} is not the JSON asked for${note}`));
    if (fingerprint(await ctx.git.workingDiff("HEAD", exclude)) !== before) {
      return failed(left(`${label} changed the working tree during the review (it was told not to edit files), so the diff it judged is not the one that would be committed${note}`));
    }
    await opened.close();
    tab = undefined;
    return { parsed, costUsd: cost, by: label, };
  } catch (error) {
    return failed(`${label} could not review: ${redact(messageOf(error))}${tab ? ` (the herdr sub-agent ${tab.name} is left open)` : ""}`);
  }
}
