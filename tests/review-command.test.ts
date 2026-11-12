import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ReviewReport } from "../src/domain.js";
import { runBuild } from "../src/orchestrator/build.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { fakeHerdrClient } from "./herdr-fake.js";
import { checkRunner, contextOf, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow, writingDriver } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

/** A repo on branch `base` whose `origin` is a local bare repository that already has `base`. */
async function repoWithOrigin(base = "main") {
  const cwd = await tempRepo();
  await git(cwd, "branch", "-m", base);
  const remote = mkdtempSync(path.join(tmpdir(), "shepherd-remote-"));
  await git(remote, "init", "--bare");
  await git(cwd, "remote", "add", "origin", remote);
  await git(cwd, "push", "-u", "origin", base);
  await git(cwd, "remote", "set-head", "origin", base);
  return { cwd, remote };
}

/** A herdr whose `agent:gemini` reviewer writes `findings` (model-pass findings, as the agent reviewer's JSON list) to the file it is told. */
function reviewer(findings: unknown[]) {
  return fakeHerdrClient({
    onSend: (_tab, text) => {
      const out = /findings to (\S+) \(no prose/.exec(text)?.[1];
      if (out) writeFileSync(out, JSON.stringify(findings));
    },
  });
}

async function setup(options: { base?: string; checks?: { code: number }; findings?: unknown[]; yaml?: string } = {}) {
  const { cwd, remote } = await repoWithOrigin(options.base);
  const progress: string[] = [];
  const reports: string[] = [];
  const code = options.checks?.code ?? 0;
  const fake = reviewer(options.findings ?? []);
  const app = workflow(cwd, {
    config: tieredConfig(`models: { review: 'agent:gemini' }\n${options.yaml ?? ""}`),
    ...(options.findings ? { herdr: fake.client, herdrTimings: { sleep: async () => undefined } } : {}),
    runner: checkRunner(async () => (code === 0 ? { code: 0, stdout: "ok", stderr: "" } : { code, stdout: "", stderr: "FAIL injected" })),
    progress: (line) => void progress.push(line),
    report: (markdown) => void reports.push(markdown),
  });
  return { cwd, remote, progress, reports, app, fake };
}

function write(cwd: string, name: string, body: string) {
  mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  writeFileSync(path.join(cwd, name), body);
}

async function branchWithCommit(cwd: string, branch = "fix/retry", file = "src/retry.ts") {
  await git(cwd, "switch", "-c", branch);
  write(cwd, file, "export const retry = 3;\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "Add retry");
}

function sessionReport(app: Workflow): ReviewReport {
  const dir = path.join(app.store.root, "reports");
  const file = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().at(-1)!;
  return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as ReviewReport;
}

describe("/review with no task", () => {
  it("reviews an ad-hoc branch against the default branch and saves a session report", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    expect(t.app.activeTaskId()).toBeUndefined();
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toBe("Review passed: 1 check(s), no findings.");
    expect(sessionReport(t.app).passed).toBe(true);
    expect(sessionReport(t.app).headSha).toBe((await git(t.cwd, "rev-parse", "HEAD")).trim());
    expect(sessionReport(t.app).at).toBeTruthy();
    expect(t.reports.at(-1)).toContain("## Review passed");
    expect(t.reports.at(-1)).toContain(".shepherd/reports/review-");
    expect(t.progress.some((line) => /^Review: started · fix\/retry against main/.test(line))).toBe(true);
    expect(t.progress.some((line) => /^Review: unit: passed in 0\.0s$/.test(line))).toBe(true);
  });

  it("blocks a branch that adds a secret, and keeps the secret out of the report", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz";
    write(t.cwd, "src/key.ts", `export const key = "${secret}";\n`);
    const result = await t.app.review();
    expect(sessionReport(t.app).passed).toBe(false);
    expect(sessionReport(t.app).findings.some((finding) => finding.category === "secrets")).toBe(true);
    expect(JSON.stringify(sessionReport(t.app))).not.toContain(secret);
    expect(result.text).not.toContain(secret);
  });

  it("puts uncommitted edits and untracked files in the diff, and commits nothing", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    write(t.cwd, "README.md", "base\nedited\n");
    write(t.cwd, "src/new-file.ts", "export const fresh = true;\n");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const diff = sessionReport(t.app).diff!;
    expect(diff).toContain("+edited");
    expect(diff).toContain("src/new-file.ts");
    expect(diff).toContain("+export const fresh = true;");
    expect(diff).toContain("src/retry.ts");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("fix/retry");
    expect(await git(t.cwd, "status", "--porcelain")).toContain("src/new-file.ts");
  });

  it("reviews only the uncommitted changes on the base branch, without creating a branch", async () => {
    const t = await setup();
    write(t.cwd, "src/quick-fix.ts", "export const fix = 1;\n");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("main");
    expect(sessionReport(t.app).diff).toContain("src/quick-fix.ts");
  });

  it("on the base branch also reviews local commits origin does not have", async () => {
    const t = await setup();
    write(t.cwd, "src/oops.ts", "export const oops = 1;\n");
    await git(t.cwd, "add", ".");
    await git(t.cwd, "commit", "-m", "Committed on main");
    write(t.cwd, "src/wip.ts", "export const wip = 1;\n");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const diff = sessionReport(t.app).diff!;
    expect(diff).toContain("src/oops.ts");
    expect(diff).toContain("src/wip.ts");
  });

  it("has nothing to review on a clean base branch or a branch with no changes", async () => {
    const t = await setup();
    expect(await t.app.review()).toMatchObject({ ok: true, text: "Nothing to review: no changes against main." });
    await git(t.cwd, "switch", "-c", "empty-branch");
    expect((await t.app.review()).text).toBe("Nothing to review: no changes against main.");
    expect(t.reports).toEqual([]);
    expect(existsSync(path.join(t.app.store.root, "reports"))).toBe(false);
  });

  it("fails a check with a numbered finding that names the command, and leaves the tree alone", async () => {
    const t = await setup({ checks: { code: 1 } });
    await branchWithCommit(t.cwd);
    write(t.cwd, "src/wip.ts", "export const wip = 1;\n");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(result.text).toContain("/shepherd:review again");
    expect(sessionReport(t.app).passed).toBe(false);
    expect(t.reports.at(-1)).toContain("## Review did not pass");
    expect(t.reports.at(-1)).toContain("| 1 | BLOCKING | npm test | unit failed with exit 1: FAIL injected |");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "status", "--porcelain")).toContain("src/wip.ts");
  });

  it("lists the model review's findings but never lets them change the verdict", async () => {
    const t = await setup({ findings: [{ likelihood: 8, severity: 8, category: "correctness", file: "src/retry.ts", message: "retry never backs off.", evidence: "const retry = 3" }] });
    await branchWithCommit(t.cwd);
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const report = sessionReport(t.app);
    expect(report.passed).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(report.modelReview?.findings).toHaveLength(1);
    expect(t.reports.at(-1)).toMatch(/\| 1 \| L8×S8=64 \| src\/retry\.ts \| retry never backs off\. \|/);
    expect(t.app.store.readLedger().find((entry) => entry.reason === "model review")).toMatchObject({ taskId: "session", phase: "REVIEWING" });
  });
});

describe("/review findings", () => {
  const findings = [{ likelihood: 5, severity: 6, category: "correctness", file: "src/retry.ts", message: "no jitter." }];

  it("numbers every finding in the report: static first, then checks, then the model's", async () => {
    // An eval in the diff (static), a failing check, and a model finding.
    const t = await setup({ checks: { code: 1 }, findings });
    await branchWithCommit(t.cwd);
    write(t.cwd, "src/run.ts", "export const run = (s: string) => eval(s);\n");
    const result = await t.app.review();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    const lines = t.reports.at(-1)!.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\| 1 \| BLOCKING \| security \|/);
    expect(lines[1]).toMatch(/^\| 2 \| BLOCKING \| npm test \|/);
    expect(lines[2]).toMatch(/^\| 3 \| L5×S6=30 \| src\/retry\.ts \| no jitter\./);
  });

  it("opens no menu and sends nothing to a session: the result is the report, and nothing is committed", async () => {
    const t = await setup({ checks: { code: 1 }, findings });
    await branchWithCommit(t.cwd);
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(t.reports.at(-1)).toContain("## Review did not pass");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  it("returns the one-line result when there are no findings and the review passed", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    const result = await t.app.review();
    expect(result.text).toBe("Review passed: 1 check(s), no findings.");
  });
});

/** Gives a built workflow an `agent:gemini` reviewer that writes `findings`. */
function withReviewer(app: Workflow, findings: unknown[]): void {
  const ctx = contextOf(app);
  ctx.herdr = reviewer(findings).client;
  ctx.herdrTimings = { sleep: async () => undefined };
  ctx.config = tieredConfig("models: { review: 'agent:gemini' }\n");
}

describe("/review after /build", () => {
  async function built(options: { base?: string; mutate?: (config: ReturnType<typeof tieredConfig>) => void; tickets?: ReturnType<typeof sampleTicket>[] } = {}) {
    const { cwd } = await repoWithOrigin(options.base ?? "trunk");
    const config = tieredConfig();
    options.mutate?.(config);
    const { app, taskId } = await ticketWorkflow(options.tickets ?? [sampleTicket("01"), sampleTicket("02", { blockedBy: ["01"] })], { config }, { cwd });
    const result = await runBuild(() => app, writingDriver(cwd));
    expect(result.ok, result.text).toBe(true);
    return { cwd, app, taskId };
  }

  it("uses the build's base, stores state.review and the report files, and does not change the phase", async () => {
    const t = await built();
    const before = t.app.store.load(t.taskId)!;
    expect(before.build!.base).toBe("trunk");
    expect(before.phase).toBe("IMPLEMENTING");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const after = t.app.store.load(t.taskId)!;
    expect(after.phase).toBe("IMPLEMENTING");
    expect(after.review?.passed).toBe(true);
    const dir = t.app.store.taskDir(t.taskId);
    expect(existsSync(path.join(dir, "reports", "review.json"))).toBe(true);
    expect(readFileSync(path.join(dir, "reports", "review.md"), "utf8")).toContain("## Review passed");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "branch", "--show-current")).toBe(`shepherd/${t.app.store.load(t.taskId)!.name}`);
  });

  it("lists the findings the tickets' passing reviews carried from build, after the model's, once", async () => {
    const t = await built();
    await t.app.store.update(t.taskId, "carry", (task) => {
      const run = task.ticketRuns!["01"]!;
      const record = { attempt: 1, round: 1, tier: "low" as const, implementer: "xai/grok-4.7", verdict: "pass" as const, rationale: "ok", costUsd: { review: 0 } };
      run.reviews = [{ ...record, findings: [{ likelihood: 3, severity: 5, file: "src/retry.ts", issue: "no test for the empty case" }, { likelihood: 4, severity: 4, file: "src/retry.ts", issue: "retry never backs off." }] }];
      return task;
    });
    withReviewer(t.app, [{ likelihood: 8, severity: 8, category: "correctness", file: "src/retry.ts", message: "Retry never backs off" }]);
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const report = t.app.store.load(t.taskId)!.review!;
    expect(report.carried).toEqual([{ ticket: "01", likelihood: 3, severity: 5, file: "src/retry.ts", issue: "no test for the empty case" }]);
    const md = readFileSync(path.join(t.app.store.taskDir(t.taskId), "reports", "review.md"), "utf8");
    expect(md).toContain("| L8×S8=64 | src/retry.ts | Retry never backs off |");
    expect(md).toContain("| L3×S5=15 | src/retry.ts | no test for the empty case (carried from build, ticket 01) |");
    expect(md.match(/never backs off/gi)).toHaveLength(1);
  });

  it("carries a ticket's build findings into the first /review after its review only, not into every later one", async () => {
    const t = await built();
    const record = { attempt: 1, round: 1, tier: "low" as const, implementer: "xai/grok-4.7", verdict: "pass" as const, rationale: "ok", costUsd: { review: 0 } };
    const finding = (issue: string) => ({ likelihood: 3, severity: 5, file: "src/retry.ts", issue });
    await t.app.store.update(t.taskId, "carry", (task) => {
      task.ticketRuns!["01"]!.reviews = [{ ...record, findings: [finding("no test for the empty case")] }];
      return task;
    });
    withReviewer(t.app, []);
    expect((await t.app.review()).ok).toBe(true);
    expect(t.app.store.load(t.taskId)!.review!.carried).toHaveLength(1);
    // The same findings are not listed again.
    expect((await t.app.review()).ok).toBe(true);
    expect(t.app.store.load(t.taskId)!.review!.carried).toBeUndefined();
    // A ticket reviewed after that report carries into the next one, and only its findings.
    const reportAt = t.app.store.load(t.taskId)!.review!.at!;
    const later = new Date(Date.parse(reportAt) + 60_000).toISOString();
    await t.app.store.update(t.taskId, "carry again", (task) => {
      task.ticketRuns!["02"]!.reviews = [{ ...record, at: later, findings: [finding("second ticket gap")] }];
      return task;
    });
    expect((await t.app.review()).ok).toBe(true);
    expect(t.app.store.load(t.taskId)!.review!.carried).toEqual([{ ticket: "02", ...finding("second ticket gap") }]);
  });

  it("falls back to the tickets' checks when the config has none, and cannot pass with no checks at all", async () => {
    const withChecks = await built({
      mutate: (config) => void (config.checks = []),
      tickets: [sampleTicket("01", { checks: ["npm run typecheck"] }), sampleTicket("02", { blockedBy: ["01"], checks: ["npm run typecheck", "npm test"] })],
    });
    const result = await withChecks.app.review();
    expect(result.ok, result.text).toBe(true);
    const report = withChecks.app.store.load(withChecks.taskId)!.review!;
    expect(report.checks.map((check) => check.name).sort()).toEqual(["npm run typecheck", "npm test"]);
    expect(report.summary).toContain("Review passed with 2 check(s)");

    const bare = await built({ mutate: (config) => void (config.checks = []) });
    const failed = await bare.app.review();
    expect(failed).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(failed.text).toContain("no checks ran");
    expect(bare.app.store.load(bare.taskId)!.phase).toBe("IMPLEMENTING");
  });
});
