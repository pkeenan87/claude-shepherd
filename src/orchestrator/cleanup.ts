/**
 * `shepherd cleanup`: audits and cleans stale local worktrees, merged `<branchPrefix>/*` branches,
 * closed `_plans/*.md` mirrors & ephemeral session/review JSON files, dead build claims, global
 * `$SHEPHERD_HOME` hygiene, and (only with `--remote`, gated by PreToolUse `ask`) merged remote branches.
 */
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommandResult } from "../domain.js";
import { pruneMissingRepos, pruneOldSessions, registeredRepos } from "../shepherd-home.js";
import { done, guard, type WorkflowContext } from "./context.js";
import { displayName, isClosed, listTasks } from "./tasks.js";

export interface CleanupOptions {
  dryRun?: boolean;
  worktrees?: boolean;
  branches?: boolean;
  plans?: boolean;
  sessions?: boolean;
  remote?: boolean;
  force?: boolean;
  shepherdHome?: string;
}

export interface CleanupAction {
  kind: "worktree" | "branch" | "remote-branch" | "plan-file" | "task-ephemeral" | "claim" | "shepherd-home";
  target: string;
  reason: string;
}

export interface CleanupReport {
  dryRun: boolean;
  base: string;
  actions: CleanupAction[];
  skipped: { target: string; reason: string }[];
  errors: string[];
}

export function runCleanup(ctx: WorkflowContext, options: CleanupOptions = {}): Promise<CommandResult> {
  return guard(async () => {
    const dryRun = options.dryRun === true;
    const explicit = Boolean(options.worktrees || options.branches || options.plans || options.sessions || options.remote);
    const doWorktrees = explicit ? !!options.worktrees : true;
    const doBranches = explicit ? !!options.branches : true;
    const doPlans = explicit ? !!options.plans : true;
    const doSessions = explicit ? !!options.sessions : true;
    const doRemote = !!options.remote;

    const base = await ctx.git.defaultBranch().catch(() => "main");
    const currentBranch = await ctx.git.currentBranch().catch(() => "");
    const tasks = listTasks(ctx);
    const openByBranch = new Map(
      tasks
        .filter((t) => !isClosed(t) && (t.build?.branch || t.worktree?.branch))
        .map((t) => [(t.build?.branch ?? t.worktree?.branch)!, t]),
    );
    const closedByBranch = new Map(
      tasks
        .filter((t) => isClosed(t) && (t.build?.branch || t.worktree?.branch))
        .map((t) => [(t.build?.branch ?? t.worktree?.branch)!, t]),
    );

    const actions: CleanupAction[] = [];
    const skipped: { target: string; reason: string }[] = [];
    const errors: string[] = [];

    const worktrees = await ctx.git.worktreeList();
    const removedWorktreePaths = new Set<string>();
    const commonRoot = path.resolve(await ctx.git.commonRoot().catch(() => ctx.git.repoRoot));
    const currentRoot = path.resolve(ctx.git.repoRoot);

    const taskFullyBuilt = (task: (typeof tasks)[number]): boolean => {
      const tickets = task.plan?.tickets ?? [];
      if (tickets.length === 0) return false;
      return tickets.every((t) => task.ticketRuns?.[t.id]?.status === "done");
    };

    // 1. Stale linked worktrees
    if (doWorktrees) {
      if (!dryRun) await ctx.git.worktreePrune().catch(() => undefined);
      for (const wt of worktrees) {
        const wtPath = path.resolve(wt.path);
        if (wt.bare || wtPath === commonRoot || wtPath === currentRoot) continue;
        if (wt.prunable) {
          actions.push({ kind: "worktree", target: wtPath, reason: "prunable (directory missing)" });
          removedWorktreePaths.add(wtPath);
          continue;
        }
        const branch = wt.branch;
        const openTask = branch ? openByBranch.get(branch) : undefined;
        if (openTask && (ctx.store.liveBuildClaim(openTask.taskId) || ctx.store.buildInProgress(openTask.taskId))) {
          skipped.push({ target: wtPath, reason: `active build running (${displayName(openTask)})` });
          continue;
        }
        const closedTask = branch ? closedByBranch.get(branch) : undefined;
        const merged = branch && branch !== base ? await ctx.git.isMerged(branch, base).catch(() => false as const) : false;
        const prefix = `${ctx.config.branchPrefix}/`;
        const isShepherdBranch = !!branch && branch.startsWith(prefix);
        if (openTask && !options.force && !(merged && taskFullyBuilt(openTask))) {
          skipped.push({ target: wtPath, reason: `open task ${displayName(openTask)} (close task first or use --force)` });
          continue;
        }
        if (!closedTask && !(isShepherdBranch && merged)) {
          if (isShepherdBranch) skipped.push({ target: wtPath, reason: `branch ${branch} is not merged into ${base}` });
          continue;
        }
        if (wt.locked && !options.force) {
          skipped.push({ target: wtPath, reason: "worktree is locked (use --force)" });
          continue;
        }
        const dirty = existsSync(wtPath) ? await ctx.git.changedPaths(wtPath).catch(() => []) : [];
        if (dirty.length > 0 && !options.force) {
          skipped.push({ target: wtPath, reason: `has ${dirty.length} uncommitted change(s) (use --force)` });
          continue;
        }
        const reason = `${closedTask ? `closed task ${displayName(closedTask)}` : `merged into ${base} (${merged})`} (removes checkout incl. ignored files)`;
        if (!dryRun) {
          try {
            await ctx.git.worktreeRemove(wtPath, !!options.force);
            actions.push({ kind: "worktree", target: wtPath, reason });
            removedWorktreePaths.add(wtPath);
          } catch (error) {
            errors.push(`worktree ${wtPath}: ${(error as Error).message}`);
          }
        } else {
          actions.push({ kind: "worktree", target: wtPath, reason });
          removedWorktreePaths.add(wtPath);
        }
      }
    }

    // 2. Merged local <branchPrefix>/* branches
    if (doBranches) {
      const checkedOutBranches = new Set(
        worktrees
          .filter((wt) => !removedWorktreePaths.has(path.resolve(wt.path)) && wt.branch)
          .map((wt) => wt.branch!),
      );
      if (currentBranch) checkedOutBranches.add(currentBranch);
      const branches = await ctx.git.listBranches(ctx.config.branchPrefix);
      for (const br of branches) {
        if (br.name === base || br.name === "main" || br.name === "master") continue;
        if (checkedOutBranches.has(br.name)) {
          skipped.push({ target: br.name, reason: "currently checked out in a worktree" });
          continue;
        }
        const openTask = openByBranch.get(br.name);
        const merged = await ctx.git.isMerged(br.name, base).catch(() => false as const);
        if (openTask && !options.force && !(merged && taskFullyBuilt(openTask))) {
          skipped.push({ target: br.name, reason: `open task ${displayName(openTask)} (close task first or use --force)` });
          continue;
        }
        if (!merged) {
          if (br.gone && options.force && !openTask) {
            // Only force-delete unmerged [gone] branches when explicitly forced and not owned by an open task.
          } else {
            const why = br.gone
              ? `upstream gone, but local commits are not merged into ${base} (use --force to delete)`
              : openTask
                ? `open task ${displayName(openTask)}, not merged into ${base}`
                : `not merged into ${base}`;
            skipped.push({ target: br.name, reason: why });
            continue;
          }
        }
        const reason = merged ? `merged into ${base} (${merged})` : "upstream gone (--force)";
        const needsForceDelete = merged === "squash" || !!options.force;
        if (!dryRun) {
          try {
            await ctx.git.deleteBranch(br.name, needsForceDelete);
            actions.push({ kind: "branch", target: br.name, reason });
          } catch (error) {
            errors.push(`branch ${br.name}: ${(error as Error).message}`);
          }
        } else {
          actions.push({ kind: "branch", target: br.name, reason });
        }
      }
    }

    // 3. Remote stale tracking refs & merged remote <branchPrefix>/* branches (opt-in --remote)
    if (doRemote) {
      const hasOrigin = await ctx.git.hasRemote("origin");
      if (!hasOrigin) {
        skipped.push({ target: "origin", reason: "no origin remote configured" });
      } else {
        let fetchOk = true;
        if (!dryRun) {
          const fetched = await ctx.git.fetchPrune("origin");
          if (fetched.code !== 0) {
            fetchOk = false;
            errors.push(`git fetch --prune origin failed (${fetched.stderr.trim() || "error"}); aborted remote branch deletion to avoid acting on stale refs`);
          }
        }
        if (fetchOk) {
          const remotes = await ctx.git.listRemoteBranches("origin", ctx.config.branchPrefix);
          for (const name of remotes) {
            if (name === base || name === "main" || name === "master") continue;
            const openTask = openByBranch.get(name);
            const merged = await ctx.git.remoteBranchMerged(name, base, "origin").catch(() => false);
            if (openTask && !options.force && !(merged && taskFullyBuilt(openTask))) {
              skipped.push({ target: `origin/${name}`, reason: `open task ${displayName(openTask)} (close task first or use --force)` });
              continue;
            }
            if (!merged) {
              skipped.push({ target: `origin/${name}`, reason: `not merged into origin/${base}` });
              continue;
            }
            if (!dryRun) {
              try {
                const expectedSha = await ctx.git.remoteBranchSha(name, "origin");
                await ctx.git.deleteRemoteBranch(name, "origin", expectedSha);
                actions.push({ kind: "remote-branch", target: `origin/${name}`, reason: `merged into origin/${base}` });
              } catch (error) {
                errors.push(`origin/${name}: ${(error as Error).message}`);
              }
            } else {
              actions.push({ kind: "remote-branch", target: `origin/${name}`, reason: `merged into origin/${base}` });
            }
          }
        }
      }
    }

    // 4. Closed task plan mirrors, ephemeral sessions/raw review JSON, and dead claims
    if (doPlans) {
      for (const task of tasks) {
        const claimFile = path.join(ctx.store.taskDir(task.taskId), "build.claim");
        if (existsSync(claimFile) && !ctx.store.liveBuildClaim(task.taskId)) {
          if (!dryRun) {
            // Atomically move aside and re-verify the moved file is not a freshly written live claim before deleting.
            const tomb = `${claimFile}.cleanup.${randomUUID()}`;
            try {
              renameSync(claimFile, tomb);
              let live = false;
              try {
                const parsed = JSON.parse(readFileSync(tomb, "utf8")) as { pid?: unknown };
                if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
                  try {
                    process.kill(parsed.pid, 0);
                    live = true;
                  } catch (e) {
                    live = (e as NodeJS.ErrnoException).code === "EPERM";
                  }
                }
              } catch {
                /* corrupt */
              }
              if (live) {
                try { linkSync(tomb, claimFile); } catch { /* already replaced */ }
                rmSync(tomb, { force: true });
                continue;
              }
              rmSync(tomb, { force: true });
            } catch {
              continue;
            }
          }
          actions.push({ kind: "claim", target: `${displayName(task)}/build.claim`, reason: "stale claim (process no longer running)" });
        }
        if (!isClosed(task)) continue;
        if (ctx.store.buildInProgress(task.taskId)) {
          if (!dryRun) ctx.store.clearBuilding(task.taskId);
          actions.push({ kind: "claim", target: `${displayName(task)}/build.active`, reason: "stale marker on closed task" });
        }
        const slug = displayName(task).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || task.taskId;
        const planMirror = path.join(commonRoot, "_plans", `${slug}.md`);
        if (existsSync(planMirror)) {
          if (!dryRun) rmSync(planMirror, { force: true });
          actions.push({ kind: "plan-file", target: `_plans/${slug}.md`, reason: `closed task ${displayName(task)}` });
        }
        const sessionsDir = path.join(ctx.store.taskDir(task.taskId), "sessions");
        if (existsSync(sessionsDir)) {
          if (!dryRun) rmSync(sessionsDir, { recursive: true, force: true });
          actions.push({ kind: "task-ephemeral", target: `${task.taskId}/sessions/`, reason: `closed task ${displayName(task)}` });
        }
        const reportsDir = path.join(ctx.store.taskDir(task.taskId), "reports");
        if (existsSync(reportsDir)) {
          for (const file of readdirSync(reportsDir)) {
            if (/^(?:agent-review-|ticket-review-).+\.json$/.test(file)) {
              const full = path.join(reportsDir, file);
              if (!dryRun) rmSync(full, { force: true });
              actions.push({ kind: "task-ephemeral", target: `${task.taskId}/reports/${file}`, reason: "raw review JSON on closed task" });
            }
          }
        }
      }
    }

    // 5. Global $SHEPHERD_HOME hygiene
    if (doSessions && options.shepherdHome) {
      if (dryRun) {
        const missingRepos = registeredRepos(options.shepherdHome).filter((dir) => !existsSync(dir)).length;
        if (missingRepos > 0) actions.push({ kind: "shepherd-home", target: "repos.json", reason: `${missingRepos} missing repo(s)` });
      } else {
        const removedRepos = await pruneMissingRepos(options.shepherdHome);
        if (removedRepos.length > 0) actions.push({ kind: "shepherd-home", target: "repos.json", reason: `pruned ${removedRepos.length} missing repo(s)` });
        const removedSessions = pruneOldSessions(options.shepherdHome, ctx.now());
        if (removedSessions > 0) actions.push({ kind: "shepherd-home", target: "sessions/", reason: `pruned ${removedSessions} expired session note(s)` });
      }
    }

    const report: CleanupReport = { dryRun, base, actions, skipped, errors };
    const verb = dryRun ? "Would clean" : "Cleaned";
    const lines = [
      `## Cleanup${dryRun ? " (dry run)" : ""} · ${actions.length} item(s)`,
      "",
      ...(actions.length > 0
        ? actions.map((a) => `- [${a.kind}] \`${a.target}\` — ${a.reason}`)
        : [`Nothing to clean (base \`${base}\`).`]),
      ...(skipped.length > 0 ? ["", "### Kept", ...skipped.map((s) => `- \`${s.target}\` — ${s.reason}`)] : []),
      ...(errors.length > 0 ? ["", "### Errors", ...errors.map((e) => `- ${e}`)] : []),
      ...(dryRun && actions.length > 0 ? ["", "Re-run without `--dry-run` to apply."] : []),
    ];
    return done(actions.length > 0 || skipped.length > 0 || errors.length > 0 ? lines.join("\n") : `${verb} 0 items; repo is tidy.`, report);
  });
}
