/**
 * `shepherd ship`: read-only preflight + PR summary/body generator, plus opt-in confirmation-gated
 * `--push` (never force-pushes) and `--pr` (creates a GitHub PR via `gh pr create` with `execFile`).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromMicroUsd, toMicroUsd } from "../config.js";
import type { CommandResult, TaskState } from "../domain.js";
import { redact } from "../redact.js";
import { dirtyPaths } from "./build.js";
import { budgetState } from "./budget.js";
import { done, fail, guard, type WorkflowContext } from "./context.js";
import { formatUsdShort } from "./format.js";
import { SPEC_FILE } from "./interview.js";
import { activeTask, displayName } from "./tasks.js";

const execFileAsync = promisify(execFile);

export interface ShipOptions {
  push?: boolean;
  pr?: boolean;
  draft?: boolean;
  base?: string;
  remote?: string;
  /** Test seam for running `gh pr create`. */
  execPr?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ShipData {
  branch: string;
  base: string;
  remote: string;
  commits: number;
  dirtyCount: number;
  ticketsDone: number;
  ticketsTotal: number;
  reviewPassed: boolean | null;
  ready: boolean;
  blockers: string[];
  warnings: string[];
  prTitle: string;
  prBody: string;
  pushed: boolean;
  prUrl?: string;
}

function buildPrTitle(task: TaskState | undefined, branch: string, commits: { subject: string }[]): string {
  if (task?.plan?.summary) {
    const first = task.plan.summary.split(/\r?\n/)[0]?.trim() ?? "";
    if (first.length > 0 && first.length <= 72) return first;
  }
  if (task?.name) return task.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (commits.length === 1 && commits[0]?.subject) return commits[0].subject.slice(0, 72);
  return branch.replace(/^[^/]+\//, "").replace(/-/g, " ");
}

function buildPrBody(
  ctx: WorkflowContext,
  task: TaskState | undefined,
  commits: { sha: string; subject: string }[],
  spendLine: string | undefined,
): string {
  const lines: string[] = [];
  const spec = task ? ctx.store.readText(task.taskId, SPEC_FILE) : undefined;
  const summary = task?.plan?.summary || (spec ? spec.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) : undefined);
  lines.push("## Summary");
  lines.push(summary ? redact(summary) : commits.slice(0, 8).map((c) => `- ${c.subject}`).join("\n") || "- Branch changes ready for review.");
  if (task?.plan?.tickets?.length) {
    lines.push("", "## Tickets");
    for (const tk of task.plan.tickets) {
      const run = task.ticketRuns?.[tk.id];
      const mark = run?.status === "done" ? "x" : " ";
      lines.push(`- [${mark}] **${tk.id}** ${tk.title}${run?.commit ? ` (\`${run.commit.slice(0, 7)}\`)` : ""}`);
    }
  }
  if (task?.review) {
    lines.push("", "## Review & Verification");
    const passedChecks = task.review.checks.filter((c) => c.ran && c.exitCode === 0).length;
    lines.push(`- Review: ${task.review.passed ? "passed" : "findings open"} (${passedChecks}/${task.review.checks.length} checks passed)`);
    if (task.review.modelReview?.parts?.length) {
      const reviewers = task.review.modelReview.parts.map((p) => p.reviewedBy).filter(Boolean);
      if (reviewers.length > 0) lines.push(`- Model reviewers: ${reviewers.join(", ")}`);
    }
  }
  if (spendLine) lines.push("", `_${spendLine}_`);
  return lines.join("\n");
}

export function runShip(ctx: WorkflowContext, options: ShipOptions = {}): Promise<CommandResult> {
  return guard(async () => {
    const task = await activeTask(ctx);
    const branch = await ctx.git.currentBranch();
    const base = options.base ?? task?.build?.base ?? (await ctx.git.defaultBranch());
    const remote = options.remote ?? "origin";
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (branch === "HEAD") blockers.push("Checkout is on a detached HEAD; switch to a feature branch first.");
    if (branch === base || branch === "main" || branch === "master") blockers.push(`Cannot ship directly from base branch \`${branch}\`.`);
    const dirty = await dirtyPaths(ctx);
    if (dirty.length > 0) blockers.push(`Working tree has ${dirty.length} uncommitted change(s). Commit or stash them first.`);

    const commits = branch === "HEAD" ? [] : await ctx.git.commitLog(base);
    if (commits.length === 0) blockers.push(`No commits ahead of \`${base}\`.`);

    const open = task && task.phase !== "COMPLETE" && task.phase !== "IDLE" && (!task.build?.branch || task.build.branch === branch) ? task : undefined;
    if (open && (ctx.store.liveBuildClaim(open.taskId) || ctx.store.buildInProgress(open.taskId))) {
      blockers.push(`A build is currently in progress for task \`${displayName(open)}\`. Finish or pause it before shipping.`);
    }
    const tickets = open?.plan?.tickets ?? [];
    const ticketsDone = tickets.filter((t) => open?.ticketRuns?.[t.id]?.status === "done").length;
    if (tickets.length > 0 && ticketsDone < tickets.length) {
      warnings.push(`${tickets.length - ticketsDone} of ${tickets.length} plan ticket(s) are not built yet.`);
    }
    const reviewPassed = open?.review ? open.review.passed : null;
    if (open && reviewPassed === false) {
      blockers.push("The latest `/shepherd:review` did not pass. Fix blocking findings and re-run review first.");
    } else if (open && reviewPassed === null) {
      warnings.push("No `/shepherd:review` has been recorded for this task yet.");
    }

    const budget = open ? budgetState(ctx, open.taskId) : undefined;
    const spendLine = budget
      ? `Shepherd task ${displayName(open!)} spend: ${formatUsdShort(fromMicroUsd(toMicroUsd(budget.task.knownUsd) + toMicroUsd(budget.task.estimatedUnknownUsd)))}`
      : undefined;

    const prTitle = buildPrTitle(open, branch, commits);
    const prBody = buildPrBody(ctx, open, commits, spendLine);
    const ready = blockers.length === 0;
    const data: ShipData = {
      branch,
      base,
      remote,
      commits: commits.length,
      dirtyCount: dirty.length,
      ticketsDone,
      ticketsTotal: tickets.length,
      reviewPassed,
      ready,
      blockers,
      warnings,
      prTitle,
      prBody,
      pushed: false,
    };

    const wantsRemote = Boolean(options.push || options.pr);
    if (wantsRemote && !ready) {
      return fail("SHIP_BLOCKED", `Cannot ship \`${branch}\`:\n${blockers.map((b) => `- ${b}`).join("\n")}`);
    }

    if (wantsRemote) {
      if (!(await ctx.git.hasRemote(remote))) {
        return fail("NO_REMOTE", `Remote \`${remote}\` is not configured in this repository.`);
      }
      const pushed = await ctx.git.pushBranch(branch, remote, true);
      if (pushed.code !== 0) {
        return fail("PUSH_FAILED", `git push -u ${remote} ${branch} failed: ${redact(pushed.stderr.trim() || pushed.stdout.trim())}`);
      }
      data.pushed = true;
      if (options.pr) {
        const prArgs = ["pr", "create", "--base", base, "--head", branch, "--title", prTitle, "--body", prBody, ...(options.draft ? ["--draft"] : [])];
        const runPr =
          options.execPr ??
          (async (args: string[], cwd: string) => {
            try {
              const { stdout, stderr } = await execFileAsync("gh", args, { cwd, encoding: "utf8" });
              return { code: 0, stdout, stderr };
            } catch (error) {
              const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
              return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(error) };
            }
          });
        const prRes = await runPr(prArgs, ctx.git.repoRoot);
        if (prRes.code !== 0) {
          return fail("PR_FAILED", `Pushed \`${branch}\` to \`${remote}\`, but \`gh pr create\` failed: ${redact(prRes.stderr.trim() || prRes.stdout.trim())}`);
        }
        data.prUrl = prRes.stdout.trim().split(/\r?\n/).at(-1)?.trim() || undefined;
      }
    }

    const lines = [
      `## Ship · \`${branch}\` → \`${base}\``,
      "",
      `- Commits ahead of \`${base}\`: ${commits.length}`,
      ...(tickets.length > 0 ? [`- Tickets: ${ticketsDone}/${tickets.length} done`] : []),
      `- Review: ${reviewPassed === true ? "passed ✓" : reviewPassed === false ? "blocked ✗" : "not run"}`,
      ...(spendLine ? [`- ${spendLine}`] : []),
      ...(blockers.length > 0 ? ["", "### Blockers", ...blockers.map((b) => `- ${b}`)] : []),
      ...(warnings.length > 0 ? ["", "### Warnings", ...warnings.map((w) => `- ${w}`)] : []),
      ...(data.pushed ? ["", `Pushed \`${branch}\` to \`${remote}\`.${data.prUrl ? ` PR: ${data.prUrl}` : ""}`] : ["", "### Suggested PR", `**Title:** ${prTitle}`, "", prBody, "", `Run \`shepherd ship --push\` or \`shepherd ship --pr\` when ready.`]),
    ];
    return done(lines.join("\n"), data);
  });
}
