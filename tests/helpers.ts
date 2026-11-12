import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig, type WorkflowConfig } from "../src/config.js";
import type { TaskState, Ticket, TokenUsage } from "../src/domain.js";
import { GitWorkspace } from "../src/git/workspace.js";
import type { WorkflowContext } from "../src/orchestrator/context.js";
import { runBuild, type BuildDriver } from "../src/orchestrator/build.js";
import { Workflow, type WorkflowOptions } from "../src/orchestrator/service.js";
import type { CheckRunner } from "../src/review/review.js";

export function checkRunner(run: CheckRunner["run"]): CheckRunner {
  return { run };
}

const exec = promisify(execFile);

export async function tempRepo(): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), "shepherd-"));
  writeFileSync(path.join(cwd, ".gitignore"), ".shepherd/tasks/\n.shepherd/cost/\n.shepherd/metrics/\n.shepherd/reports/\n.shepherd/active-task.json\n.shepherd/agent-logs.json\n.shepherd/agent-logs.lock\n.shepherd/active/\n.shepherd/notifications.jsonl\n");
  writeFileSync(path.join(cwd, "README.md"), "base\n");
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd });
  await exec("git", ["config", "user.name", "test"], { cwd });
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "base"], { cwd });
  return cwd;
}

export function testConfig(): WorkflowConfig {
  return parseConfig(`
models: { low: anthropic/claude-sonnet, medium: anthropic/claude-sonnet, high: openai/gpt-5.4, review: openai/gpt-5.4 }
routing: { maxEscalations: 2 }
budgets: { taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8 }
checks:
  - name: unit
    command: npm
    args: ["test"]
pricing:
  - { provider: anthropic, model: claude-sonnet, effectiveFrom: "2026-01-01", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  - { provider: openai, model: gpt-5.4, effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 }
`);
}

export function workflow(cwd: string, extras: Partial<WorkflowOptions> = {}): Workflow {
  return new Workflow({
    cwd,
    config: testConfig(),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    confirm: async () => true,
    runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })),
    ...extras,
  });
}

/** A build driver whose "session" writes `src/ingest.ts` into the checkout, like a model finishing a ticket. */
export function writingDriver(cwd: string, files: Record<string, string> = { "src/ingest.ts": "export const ingest = 1;\n" }): BuildDriver {
  return {
    async fresh(_model, run) {
      await run({
        async send() {
          for (const [name, body] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
            writeFileSync(path.join(cwd, name), body);
          }
          return { lastText: "Done.\n- [x] retry works\nFiles changed: src/ingest.ts", aborted: false };
        },
      });
    },
  };
}

/** Drives a one-ticket task through plan, approve, and build: IMPLEMENTING with every ticket done. */
export async function builtWorkflow(extras: Partial<WorkflowOptions> = {}) {
  const cwd = await tempRepo();
  const { app } = await ticketWorkflow([sampleTicket("01")], { config: testConfig(), ...extras }, { cwd });
  const built = await runBuild(() => app, writingDriver(cwd));
  if (!built.ok) throw new Error(`build failed in fixture: ${built.text}`);
  return { cwd, app };
}

/** The default `models` (xai low, sonnet medium, sol high, opus review) with test prices. */
export function tieredYaml(extraYaml = ""): string {
  return `
checks:
  - { name: unit, command: npm, args: ["test"] }
pricing:
  - { provider: anthropic, model: claude-sonnet-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  - { provider: xai, model: grok-4.7, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: anthropic, model: claude-opus-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 15, outputPerMillionUsd: 75 }
  - { provider: openai, model: "gpt-6.1-sol", effectiveFrom: "2026-01-01", inputPerMillionUsd: 10, outputPerMillionUsd: 50 }
${extraYaml}`;
}

export function tieredConfig(extraYaml = ""): WorkflowConfig {
  return parseConfig(tieredYaml(extraYaml));
}

export function sampleTicket(id: string, extra: Partial<Ticket> = {}): Ticket {
  return { id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: `Build part ${id}.`, acceptanceCriteria: ["retry works"], blockedBy: [], estimatedContextTokens: 40_000, ...extra };
}

export const sampleSpec = { summary: "Retry failed ingests.", context: "src/ingest.ts parses and drops failures.", approach: "Wrap parse() in retryParse() with a fixed backoff.", changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }], reuse: ["sleep() in src/util.ts"], verification: ["npm test"], decisions: [{ question: "Backoff?", answer: "Fixed", rationale: "simple" }], assumptions: [], outOfScope: [], risks: [] };

/** A workflow in a fresh repo with a ticket plan saved through the /plan tools and, unless `approve` is false, approved. */
export async function ticketWorkflow(tickets: Ticket[], extras: Partial<WorkflowOptions> = {}, options: { approve?: boolean; cwd?: string; request?: string } = {}) {
  const cwd = options.cwd ?? (await tempRepo());
  const app = workflow(cwd, { config: tieredConfig(), ...extras });
  if (!(await app.startPlan(options.request ?? "Add retry to the ingest parser")).ok) throw new Error("startPlan failed in fixture");
  await app.savePlanSpec(sampleSpec);
  await app.commitTickets(tickets);
  if (options.approve !== false && !(await app.approveDraft()).ok) throw new Error("approveDraft failed in fixture");
  return { cwd, app, taskId: app.activeTaskId()! };
}

/** The context a Workflow holds, for tests of the modules that take one. */
export function contextOf(app: Workflow): WorkflowContext {
  return (app as unknown as { ctx: WorkflowContext }).ctx;
}

/** A GitWorkspace that records the argv of every git call, for tests that must show a command made none. */
export class SpyGit extends GitWorkspace {
  readonly calls: string[][] = [];
  override async git(args: string[], cwd?: string) {
    this.calls.push(args);
    return super.git(args, cwd);
  }
}

/** Writes a task straight into the store (it becomes the active one, as `store.create` makes it). `branch` gives it a build branch. */
export async function addTask(app: Workflow, name: string, options: { branch?: string; phase?: TaskState["phase"]; at?: string; request?: string; named?: boolean } = {}): Promise<TaskState> {
  const at = options.at ?? "2026-10-14T12:00:00.000Z";
  const base: TaskState = {
    taskId: `task-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${name}`,
    ...(options.named === false ? {} : { name }),
    phase: options.phase ?? "PLANNING",
    createdAt: at,
    updatedAt: at,
    phaseEnteredAt: at,
    request: options.request ?? `Request for ${name}`,
    ...(options.branch ? { build: { branch: options.branch, base: "main", baseSha: "0".repeat(40) } } : {}),
  };
  return contextOf(app).store.create(base);
}
