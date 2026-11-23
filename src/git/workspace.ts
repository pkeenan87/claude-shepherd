import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowError } from "../domain.js";

const exec = promisify(execFile);

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  prunable?: boolean;
  locked?: boolean;
}

export interface BranchInfo {
  name: string;
  head: string;
  upstream?: string;
  gone: boolean;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Name and email to fall back to when the repo has no identity of its own (the user's identity is used otherwise). */
const FALLBACK_NAME = "shepherd";
const FALLBACK_EMAIL = "shepherd@localhost";

interface Identity {
  name: boolean;
  email: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat" };
}

/** Whether a name and an email are configured (global, system, local, includeIf) or set through the environment. */
async function resolveIdentity(cwd: string): Promise<Identity> {
  const env = gitEnv();
  // Probe with no fallback injected, or `config --get` would find the fallback.
  const probe = { name: true, email: true };
  const configured = async (key: string, vars: string[]) => {
    // Only skip git config lookup when BOTH author and committer env vars are set; otherwise git still needs user.* for the other half.
    if (vars.every((name) => env[name]?.trim())) return true;
    const result = await runGit(cwd, ["config", "--get", key], probe);
    return result.code === 0 && result.stdout.trim() !== "";
  };
  return {
    name: await configured("user.name", ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]),
    email: await configured("user.email", ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]),
  };
}

async function runGit(cwd: string, args: string[], identity: Identity): Promise<GitResult> {
  // Commits are authored by the user; the shepherd identity is only a fallback for the parts git has no value for.
  // commit.gpgsign=false always: a signing prompt would hang a non-interactive commit.
  const config = [
    ...(identity.name ? [] : ["-c", `user.name=${FALLBACK_NAME}`]),
    ...(identity.email ? [] : ["-c", `user.email=${FALLBACK_EMAIL}`]),
    "-c",
    "commit.gpgsign=false",
  ];
  try {
    const { stdout, stderr } = await exec("git", [...config, ...args], {
      cwd,
      encoding: "utf8",
      // A large branch diff (or untracked file) must not fail /review with an empty "git diff failed".
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? String(error) };
  }
}

const NO_HOOKS = "/dev/null";

/** Where coding agents keep their own settings and state; a file there that git does not track yet is the agent's, not the ticket's. */
const AGENT_DIRS = [".claude", ".codex", ".cursor", ".gemini", ".opencode", ".grok"];

/**
 * The diff format the review and the static scan parse (`+++ b/<file>`, no colour), whatever the user's git config says
 * (`diff.mnemonicPrefix`, `diff.noprefix`, `color.ui=always`, `diff.external`): command-line options beat config.
 */
const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

export class GitWorkspace {
  private identity?: Promise<Identity>;

  constructor(readonly repoRoot: string) {}

  async git(args: string[], cwd = this.repoRoot): Promise<GitResult> {
    this.identity ??= resolveIdentity(this.repoRoot);
    return runGit(cwd, args, await this.identity);
  }

  async head(cwd = this.repoRoot): Promise<string> {
    const result = await this.git(["rev-parse", "HEAD"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git rev-parse failed");
    return result.stdout.trim();
  }

  /** Why /build and /review cannot run here (not a repository, or no commit yet), or undefined when they can. */
  async preflight(): Promise<string | undefined> {
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return `${this.repoRoot} is not a git repository. Run \`git init\` and make a first commit, then /build again.`;
    }
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code !== 0) {
      return `The repository at ${this.repoRoot} has no commits yet, so there is nothing to branch from. Make a first commit (for example \`git commit --allow-empty -m "Initial commit"\`), then /build again.`;
    }
    return undefined;
  }

  /**
   * Commits everything in `cwd` except the `exclude` paths (relative to `cwd`) and the files an agent left that are new
   * under its own directory (`.claude/`, `.codex/` ...; tracked files there commit as usual). The tree may hold hooks or config a model wrote (hooks live in the .git directory), so no hook runs and no fsmonitor command is started: `core.hooksPath=/dev/null`, `--no-verify`.
   */
  async commitAll(cwd: string, message: string, exclude: string[] = []): Promise<string> {
    const safe = ["-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.fsmonitor=false"];
    const skip = [...exclude, ...(await this.agentArtefacts(cwd))];
    // Everything is added, then the skipped paths are unstaged. An exclude pathspec on `add` would fail ("paths are
    // ignored... use -f") when a skipped path, such as `.shepherd`, is in the repo's .gitignore.
    const add = await this.git([...safe, "add", "-A", "--", "."], cwd);
    if (add.code !== 0) throw new WorkflowError("GIT", add.stderr);
    if (skip.length > 0) {
      // Unstaging also drops anything an agent staged there itself.
      const unstage = await this.git([...safe, "reset", "-q", "--", ...skip.map((path) => `:(literal)${path}`)], cwd);
      if (unstage.code !== 0) throw new WorkflowError("GIT", unstage.stderr);
    }
    const commit = await this.git([...safe, "commit", "--no-verify", "-m", message], cwd);
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new WorkflowError("GIT", commit.stderr || commit.stdout);
    }
    return this.head(cwd);
  }

  /** Files under the agent directories that HEAD does not have: untracked ones, and ones staged as new. Neither is a ticket's work. */
  async agentArtefacts(cwd = this.repoRoot): Promise<string[]> {
    const safe = ["-c", "core.fsmonitor=false"];
    const untracked = await this.git([...safe, "ls-files", "--others", "--exclude-standard", "-z", "--", ...AGENT_DIRS], cwd);
    const staged = await this.git([...safe, "diff", "--cached", "--name-only", "--diff-filter=A", "-z", "--", ...AGENT_DIRS], cwd);
    return [...untracked.stdout.split("\0"), ...staged.stdout.split("\0")].filter(Boolean);
  }

  /** `git reset --soft <sha>`: moves HEAD (and the branch) back to `sha`, keeping the index and the working tree. */
  async resetSoft(sha: string, cwd = this.repoRoot): Promise<void> {
    const result = await this.git(["reset", "--soft", "--end-of-options", sha], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git reset --soft failed");
  }

  /** The checked-out branch name, or "HEAD" when detached. */
  async currentBranch(cwd = this.repoRoot): Promise<string> {
    const result = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git rev-parse failed");
    return result.stdout.trim();
  }

  /** `origin/HEAD` when set, else a local `main` or `master`, else the current branch. */
  async defaultBranch(cwd = this.repoRoot): Promise<string> {
    const remote = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    const named = remote.stdout.trim().replace(/^origin\//, "");
    if (remote.code === 0 && named) return named;
    for (const name of ["main", "master"]) {
      if ((await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd)).code === 0) return name;
    }
    return this.currentBranch(cwd);
  }

  /**
   * Creates and switches to a new branch at `startPoint` (a commit sha; HEAD when left out); uncommitted changes come
   * along when they do not conflict. The name is validated first (`switch -c` takes no `--`).
   */
  async switchCreate(branch: string, startPoint?: string): Promise<void> {
    await this.assertBranchName(branch);
    if (startPoint !== undefined) this.assertSha(startPoint);
    const result = await this.git(["switch", "-c", branch, ...(startPoint ? [startPoint] : [])]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not create ${branch}`);
  }

  /** The commit /build branches from for `base`: the local branch, else `origin/<base>`, else HEAD. */
  async startPoint(base: string): Promise<string> {
    for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      const result = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return this.head();
  }

  private async assertBranchName(branch: string): Promise<void> {
    if (branch.startsWith("-") || (await this.git(["check-ref-format", "--branch", branch])).code !== 0) {
      throw new WorkflowError("GIT", `Not a valid branch name: ${branch}`);
    }
  }

  private assertSha(sha: string): void {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new WorkflowError("GIT", `Not a commit id: ${sha}`);
  }

  /** True when a local branch of this name exists. */
  async branchExists(branch: string): Promise<boolean> {
    return (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  /** Switches to an existing local branch. Fails (git refuses) rather than carrying conflicting changes along. */
  async switchTo(branch: string): Promise<void> {
    await this.assertBranchName(branch);
    const result = await this.git(["switch", "--", branch]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not switch to ${branch}`);
  }

  /** The commit where HEAD left `base` (falls back to `refs/remotes/origin/<base>` when no local ref exists). */
  async mergeBase(base: string, cwd = this.repoRoot): Promise<string> {
    const result = await this.git(["merge-base", "HEAD", base], cwd);
    if (result.code === 0) return result.stdout.trim();
    if (!base.startsWith("refs/") && !base.startsWith("origin/")) {
      const remote = await this.git(["merge-base", "HEAD", `refs/remotes/origin/${base}`], cwd);
      if (remote.code === 0) return remote.stdout.trim();
    }
    throw new WorkflowError("GIT", result.stderr || `No merge base with ${base}`);
  }

  /** `git status --porcelain`: empty when the tree is clean. */
  async statusPorcelain(cwd = this.repoRoot): Promise<string> {
    const result = await this.git(["status", "--porcelain"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git status failed");
    return result.stdout;
  }

  /** Paths with changes (`git status --porcelain -z`): a rename reports its new path, and names are never quoted. */
  async changedPaths(cwd = this.repoRoot): Promise<string[]> {
    const result = await this.git(["status", "--porcelain", "-z", "--untracked-files=all"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git status failed");
    const fields = result.stdout.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]!;
      if (entry.length < 4) continue;
      paths.push(entry.slice(3));
      // A rename or copy is followed by its source path as its own field.
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    return paths;
  }

  /** The newest commit in `since..HEAD` whose subject is exactly `subject`, or undefined (also on any git error). */
  async commitWithSubject(since: string, subject: string, cwd = this.repoRoot): Promise<string | undefined> {
    const result = await this.git(["log", "--format=%H%x00%s", `${since}..HEAD`, "--"], cwd);
    if (result.code !== 0) return undefined;
    for (const line of result.stdout.split("\n")) {
      const [sha, text] = line.split("\0");
      if (sha && text?.trim() === subject.trim()) return sha;
    }
    return undefined;
  }

  /** How many commits HEAD has that `base` does not. */
  async aheadOf(base: string, cwd = this.repoRoot): Promise<number> {
    const result = await this.git(["rev-list", "--count", `${base}..HEAD`, "--"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not compare with ${base}`);
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  /**
   * The working tree against the merge base with `base`: commits on the branch, staged and unstaged edits, and
   * untracked files. Untracked files are diffed against /dev/null, so the index is never touched. `exclude` paths
   * (repo-relative, such as the workspace dir) and untracked/newly-staged agent artefacts are left out.
   */
  async workingDiff(base: string, exclude: string[] = [], cwd = this.repoRoot): Promise<string> {
    const point = await this.mergeBase(base, cwd);
    const skip = [...new Set([...exclude, ...(await this.agentArtefacts(cwd))])];
    const paths = ["--", ".", ...skip.map((dir) => `:(exclude,literal)${dir}`)];
    const tracked = await this.git(["diff", ...PLAIN_DIFF, point, ...paths], cwd);
    if (tracked.code !== 0) throw new WorkflowError("GIT", tracked.stderr || "git diff failed");
    const listed = await this.git(["ls-files", "--others", "--exclude-standard", "-z", ...paths], cwd);
    if (listed.code !== 0) throw new WorkflowError("GIT", listed.stderr || "git ls-files failed");
    const parts = [tracked.stdout];
    for (const file of listed.stdout.split("\0").filter(Boolean)) {
      // Exit code 1 is how --no-index says "the files differ".
      const added = await this.git(["diff", "--no-index", ...PLAIN_DIFF, "--", "/dev/null", file], cwd);
      if (added.code > 1) throw new WorkflowError("GIT", added.stderr || `git diff failed for ${file}`);
      parts.push(added.stdout);
    }
    return parts.join("");
  }

  /** The repository's common root (the main checkout even when invoked inside a linked worktree). */
  async commonRoot(cwd = this.repoRoot): Promise<string> {
    const res = await this.git(["rev-parse", "--git-common-dir"], cwd);
    if (res.code !== 0 || !res.stdout.trim()) return this.repoRoot;
    const common = path.resolve(cwd, res.stdout.trim());
    return path.basename(common) === ".git" ? path.dirname(common) : this.repoRoot;
  }

  /** The git directory for `cwd` (`.git` in the main checkout, or `<common>/.git/worktrees/<name>` in a linked worktree). */
  async gitDir(cwd = this.repoRoot): Promise<string> {
    const res = await this.git(["rev-parse", "--git-dir"], cwd);
    if (res.code !== 0 || !res.stdout.trim()) return path.join(cwd, ".git");
    return path.resolve(cwd, res.stdout.trim());
  }

  /** True when `cwd` is a linked git worktree rather than the main checkout. */
  async isLinkedWorktree(cwd = this.repoRoot): Promise<boolean> {
    const [dir, common] = await Promise.all([this.gitDir(cwd), this.commonRoot(cwd)]);
    return path.resolve(dir) !== path.resolve(path.join(common, ".git"));
  }

  /** Parses `git worktree list --porcelain`. */
  async worktreeList(): Promise<WorktreeEntry[]> {
    const res = await this.git(["worktree", "list", "--porcelain"]);
    if (res.code !== 0) return [];
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        if (current) entries.push(current);
        current = undefined;
        continue;
      }
      if (line.startsWith("worktree ")) {
        if (current) entries.push(current);
        current = { path: line.slice("worktree ".length).trim(), head: "" };
      } else if (current) {
        if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length).trim();
        else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim();
        else if (line === "bare") current.bare = true;
        else if (line === "detached") current.detached = true;
        else if (line.startsWith("prunable")) current.prunable = true;
        else if (line.startsWith("locked")) current.locked = true;
      }
    }
    if (current) entries.push(current);
    return entries;
  }

  /** Creates a linked worktree at `targetPath` on `branch` (creating `branch` at `startPoint` unless it exists). */
  async worktreeAdd(targetPath: string, branch: string, startPoint?: string): Promise<void> {
    await this.assertBranchName(branch);
    if (startPoint !== undefined) this.assertSha(startPoint);
    const exists = await this.branchExists(branch);
    const args = exists
      ? ["worktree", "add", "--", targetPath, branch]
      : ["worktree", "add", "-b", branch, "--", targetPath, ...(startPoint ? [startPoint] : [])];
    const res = await this.git(args);
    if (res.code !== 0) throw new WorkflowError("GIT", res.stderr || `Could not create worktree at ${targetPath}`);
  }

  /** Removes a linked worktree. Refuses dirty worktrees unless `force` is true. */
  async worktreeRemove(targetPath: string, force = false): Promise<void> {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), "--", targetPath];
    const res = await this.git(args);
    if (res.code !== 0) throw new WorkflowError("GIT", res.stderr || `Could not remove worktree ${targetPath}`);
  }

  /** Prunes stale worktree administrative files (`git worktree prune`). */
  async worktreePrune(): Promise<void> {
    await this.git(["worktree", "prune"]);
  }

  /** Local branches, optionally filtered to `<prefix>/*`. */
  async listBranches(prefix?: string): Promise<BranchInfo[]> {
    const res = await this.git(["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)", "refs/heads"]);
    if (res.code !== 0) return [];
    const out: BranchInfo[] = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [name, head, upstream, track] = line.split("\0");
      if (!name || !head) continue;
      if (prefix && !name.startsWith(`${prefix}/`)) continue;
      out.push({ name, head, ...(upstream ? { upstream } : {}), gone: /\[gone\]/.test(track ?? "") });
    }
    return out;
  }

  /** Whether local `branch` is merged into `base` (regular ancestor or squash-merged via `git cherry`). */
  async isMerged(branch: string, base: string): Promise<"ancestor" | "squash" | false> {
    const anc = await this.git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, base]);
    if (anc.code === 0) return "ancestor";
    const cherry = await this.git(["cherry", base, `refs/heads/${branch}`]);
    if (cherry.code === 0) {
      const lines = cherry.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 0 && lines.every((l) => l.startsWith("- "))) return "squash";
    }
    return false;
  }

  /** Remote-tracking branch names under `<remote>/`, optionally filtered to `<prefix>/*`. */
  async listRemoteBranches(remote = "origin", prefix?: string): Promise<string[]> {
    const res = await this.git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`]);
    if (res.code !== 0) return [];
    const strip = `${remote}/`;
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(strip) && line !== `${strip}HEAD`)
      .map((line) => line.slice(strip.length))
      .filter((name) => !prefix || name.startsWith(`${prefix}/`));
  }

  /** Whether `<remote>/<branch>` is an ancestor of `<remote>/<base>` (requires remote merge evidence, never local-only). */
  async remoteBranchMerged(branch: string, base: string, remote = "origin"): Promise<boolean> {
    const res = await this.git(["merge-base", "--is-ancestor", `refs/remotes/${remote}/${branch}`, `refs/remotes/${remote}/${base}`]);
    return res.code === 0;
  }

  /** Runs `git fetch --prune <remote>`. */
  async fetchPrune(remote = "origin"): Promise<GitResult> {
    return this.git(["fetch", "--prune", remote]);
  }

  /** Deletes a local branch (never `main` or `master`). */
  async deleteBranch(branch: string, force = false): Promise<void> {
    if (branch === "main" || branch === "master") throw new WorkflowError("GIT", `Refusing to delete protected branch ${branch}`);
    await this.assertBranchName(branch);
    const res = await this.git(["branch", force ? "-D" : "-d", "--", branch]);
    if (res.code !== 0) throw new WorkflowError("GIT", res.stderr || `Could not delete branch ${branch}`);
  }

  /** Deletes a remote branch on `<remote>` (never `main` or `master`). */
  async deleteRemoteBranch(branch: string, remote = "origin"): Promise<void> {
    if (branch === "main" || branch === "master") throw new WorkflowError("GIT", `Refusing to delete protected remote branch ${remote}/${branch}`);
    await this.assertBranchName(branch);
    const res = await this.git(["push", remote, "--delete", "--", branch]);
    if (res.code !== 0) throw new WorkflowError("GIT", res.stderr || `Could not delete ${remote}/${branch}`);
  }

  /** Pushes a branch to `<remote>` (never force-pushes). */
  async pushBranch(branch: string, remote = "origin", setUpstream = true, cwd = this.repoRoot): Promise<GitResult> {
    await this.assertBranchName(branch);
    return this.git(["push", ...(setUpstream ? ["-u"] : []), remote, "--", branch], cwd);
  }

  /** True when `<remote>` is configured on this repo. */
  async hasRemote(remote = "origin"): Promise<boolean> {
    return (await this.git(["remote", "get-url", remote])).code === 0;
  }

  /** Commits on HEAD not in `base`, newest first. */
  async commitLog(base: string, cwd = this.repoRoot): Promise<{ sha: string; subject: string }[]> {
    const res = await this.git(["log", "--format=%H%x00%s", `${base}..HEAD`, "--"], cwd);
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\0");
        return { sha: sha ?? "", subject: subject ?? "" };
      })
      .filter((row) => !!row.sha);
  }
}
