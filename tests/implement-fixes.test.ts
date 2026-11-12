import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarize, unpricedModels } from "../src/cost/ledger.js";
import { type CostRecord, type PlanDocument, type ReviewReport, type TaskState, type Ticket } from "../src/domain.js";
import { forNewPlan, sameTicket } from "../src/orchestrator/plan.js";
import { ticketPrompt } from "../src/orchestrator/prompts.js";
import { parseModelFindings } from "../src/review/model-review.js";
import { formatDuration } from "../src/orchestrator/format.js";
import { blank } from "../src/orchestrator/planning.js";
import { TICKET_RULES } from "../src/orchestrator/prompts.js";
import { validateTickets } from "../src/orchestrator/tickets.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { checkRunner, tempRepo, tieredConfig, workflow } from "./helpers.js";

/** An uncommitted new file in the checkout: what /review finds with no task and no commits. */
async function adHocChange(cwd: string, body = "export const ingest = 1;\n", more: Record<string, string> = {}): Promise<void> {
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "ingest.ts"), body);
  for (const [name, text] of Object.entries(more)) writeFileSync(path.join(cwd, name), text);
}

function reportDir(app: Workflow): string {
  return path.join(app.store.root, "reports");
}

/** The markdown of the newest session /review report. */
function reportText(app: Workflow): string {
  const file = readdirSync(reportDir(app)).filter((name) => name.endsWith(".md")).sort().at(-1)!;
  return readFileSync(path.join(reportDir(app), file), "utf8");
}

function savedReport(app: Workflow): ReviewReport {
  const file = readdirSync(reportDir(app)).filter((name) => name.endsWith(".json")).sort().at(-1)!;
  return JSON.parse(readFileSync(path.join(reportDir(app), file), "utf8")) as ReviewReport;
}

const ticket = (id: string, slug: string, extra: Partial<Ticket> = {}): Ticket => ({ id, slug, title: `T${id}`, whatToBuild: "x", acceptanceCriteria: ["works"], blockedBy: [], estimatedContextTokens: 30_000, ...extra });

describe("ticket checks at plan time", () => {
  const options = { target: 150_000, fileSize: () => undefined };

  it("rejects a destructive check and says what to do instead", () => {
    const result = validateTickets([ticket("01", "a", { checks: ["rm -rf /"] })], options);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Ticket 01: check "rm -rf /" cannot run');
    expect(result.errors[0]).toContain("implementation instead");
  });

  it("accepts any non-destructive command", () => {
    expect(validateTickets([ticket("01", "a", { checks: ["npm test", "make test", "npm ci"] })], options).errors).toEqual([]);
  });

  it("rejects shell syntax, since checks run without a shell", () => {
    for (const check of ["npm test && npm run typecheck", "npm test | tee x", 'npx vitest run -t "parses dates"', "echo $HOME", "ls *.ts", "npm test > out"]) {
      const result = validateTickets([ticket("01", "a", { checks: [check] })], options);
      expect(result.errors.join("\n"), check).toContain("checks run without a shell");
    }
  });

  it("rejects prose whose first word is not a command on PATH", () => {
    const result = validateTickets([ticket("01", "a", { checks: ["Run the smoke test by hand."] })], options);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"Run" is not a command on PATH; describe manual steps in implementation, not checks');
  });

  it("accepts paths, and uses the injected lookup", () => {
    expect(validateTickets([ticket("01", "a", { checks: ["./scripts/check.sh"] })], options).errors).toEqual([]);
    const only = { ...options, commandExists: (command: string) => command === "mytool" };
    expect(validateTickets([ticket("01", "a", { checks: ["mytool --x"] })], only).errors).toEqual([]);
    expect(validateTickets([ticket("01", "a", { checks: ["npm test"] })], only).errors).toHaveLength(1);
  });

  it("tells the planner what checks are", () => {
    const rules = TICKET_RULES(150_000);
    expect(rules).toContain("There is no shell");
    expect(rules).toContain("Destructive commands are refused");
    expect(rules).not.toContain("allowlist");
  });

  it("rejects destructive checks through the workflow", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig() });
    const check = app.checkTickets([ticket("01", "a", { checks: ["git push --force"] })]);
    expect(check.errors[0]).toContain("cannot run");
    expect(app.checkTickets([ticket("01", "a", { checks: ["npm test"] })]).errors).toEqual([]);
  });
});

describe("state carried into a new plan version", () => {
  const draft = (tickets: Ticket[]): PlanDocument => ({
    version: 2,
    createdAt: "2026-10-15T00:00:00.000Z",
    summary: "s",
    risks: [],
    acceptance: [],
    groups: tickets.map((item) => ({ id: `${item.id}-${item.slug}`, summary: item.title, files: [], dependsOn: [] })),
    overlap: [],
    securitySensitive: false,
    tickets,
  });
  it("drops the runs of tickets the new plan no longer has and keeps the rest", () => {
    const task: TaskState = {
      ...blank("t", "req", "2026-10-15T00:00:00.000Z"),
      plan: draft([ticket("01", "old-slug"), ticket("02", "same")]),
      ticketRuns: { "01": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false }, "02": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false } },
    };
    const next = forNewPlan(task, draft([ticket("01", "new-slug"), ticket("02", "same")]));
    // The stale "done" for ticket 01 is gone, so the new 01 runs; 02 stays done.
    expect(Object.keys(next.ticketRuns ?? {})).toEqual(["02"]);
  });

  it("drops the run of a ticket whose text changed, so it runs again", () => {
    const before = ticket("01", "a", { whatToBuild: "old" });
    const task: TaskState = { ...blank("t", "req", "2026-10-15T00:00:00.000Z"), plan: draft([before]), ticketRuns: { "01": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false } } };
    expect(forNewPlan(task, draft([ticket("01", "a", { whatToBuild: "old" })])).ticketRuns).toBeDefined();
    const next = forNewPlan(task, draft([ticket("01", "a", { whatToBuild: "new" })]));
    expect(next.ticketRuns).toBeUndefined();
    expect(sameTicket(before, ticket("01", "a", { whatToBuild: "old", checks: ["npm test"] }))).toBe(false);
  });

  it("tells the model about earlier work on the branch", () => {
    const prompt = ticketPrompt({ ticket: { id: "01", title: "T", whatToBuild: "x", acceptanceCriteria: ["a"] }, blockers: [], priorWork: true });
    expect(prompt).toContain("## Earlier work on this branch");
    expect(ticketPrompt({ ticket: { id: "01", title: "T", whatToBuild: "x", acceptanceCriteria: ["a"] }, blockers: [], priorWork: true, previousFailure: "boom" })).not.toContain("Earlier work");
  });
});

describe("phantom spend", () => {
  const pricing = [
    { provider: "anthropic", model: "cheap", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    { provider: "anthropic", model: "dear", effectiveFrom: "2026-01-01", inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  ];
  const unknown: CostRecord = { id: "1", at: "2026-10-15T10:00:00.000Z", taskId: "t", phase: "IDLE", provider: "anthropic", model: "other", tier: "interactive", requests: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd: null, usageKnown: false, outcome: "unknown", retries: 0, reason: "observed assistant usage" };

  it("estimates an unpriced model at the provider's dearest row", () => {
    expect(summarize([unknown], { pricing }).estimatedUnknownUsd).toBe(10);
    expect(summarize([unknown], { pricing: [pricing[0]!] }).estimatedUnknownUsd).toBe(0);
  });

  it("names the models in the ledger that have no pricing row", () => {
    const priced: CostRecord = { ...unknown, id: "2", model: "cheap" };
    expect(unpricedModels([priced, unknown, unknown], pricing)).toEqual(["anthropic/other"]);
  });
});

describe("model review", () => {
  it("skips the model pass when review.model is off", async () => {
    const quietCwd = await tempRepo();
    const quiet = workflow(quietCwd, { config: tieredConfig("review: { model: false }") });
    await adHocChange(quietCwd);
    const silent = await quiet.review();
    expect(silent.ok).toBe(true);
    expect(reportText(quiet)).toContain("| Model review | did not run | — | — |");
    expect(quiet.store.readLedger().filter((item) => item.reason === "model review")).toHaveLength(0);
  });

  const plan: PlanDocument = { version: 1, createdAt: "2026-10-15T00:00:00.000Z", summary: "Add retry.", risks: [], acceptance: ["retry works"], groups: [], overlap: [], securitySensitive: false, tickets: [ticket("01", "retry", { acceptanceCriteria: ["retry works"] })] };

  it("parses a JSON list out of chatty output, fills defaults, reads the scores and leaves a missing one out", () => {
    const text = 'Here you go:\n[{"likelihood":"3","severity":2.6,"category":"tests","message":"No test for the empty case.","file":"src/a.ts"},{"likelihood":9,"severity":11,"message":"retry() loops forever when attempts is 0.","evidence":"while (true)"},{"severity":9,"message":"no likelihood"},{"message":""},"junk"]';
    const findings = parseModelFindings(text)!;
    expect(findings.map((item) => [item.likelihood, item.severity])).toEqual([[3, 3], [9, 10], [undefined, 9]]);
    expect(findings[1]).toMatchObject({ category: "general", evidence: "while (true)" });
    expect(parseModelFindings("I found nothing.")).toBeUndefined();
    expect(parseModelFindings("[]")).toEqual([]);
  });

  it("runs setup commands in the repo root before the checks, and hints at setup when tooling is missing", async () => {
    const ran: string[] = [];
    const cwd = await tempRepo();
    const app = workflow(cwd, {
      config: tieredConfig("setup:\n  - { name: install, command: npm, args: [ci] }"),
      runner: checkRunner(async (command, args, where) => (ran.push(`${[command, ...args].join(" ")} @ ${where === app.git.repoRoot ? "root" : where}`), { code: 0, stdout: "ok", stderr: "" })),
    });
    await adHocChange(cwd);
    const review = await app.review();
    expect(review.ok, review.text).toBe(true);
    expect(ran).toEqual(["npm ci @ root", "npm test @ root"]);
    expect(savedReport(app).checks.map((check) => check.name)).toEqual(["setup: install", "unit"]);

    const brokenCwd = await tempRepo();
    const brokenInstall = workflow(brokenCwd, {
      config: tieredConfig("setup:\n  - { name: install, command: npm, args: [ci] }"),
      runner: checkRunner(async (_command, args) => (args[0] === "ci" ? { code: 1, stdout: "", stderr: "ERESOLVE" } : { code: 0, stdout: "ok", stderr: "" })),
    });
    await adHocChange(brokenCwd);
    const noInstall = await brokenInstall.review();
    expect(noInstall.ok).toBe(false);
    expect(noInstall.text).toContain("setup: install failed.");
    expect(savedReport(brokenInstall).checks.map((check) => [check.name, check.ran])).toEqual([["setup: install", true], ["unit", false]]);

    const bareCwd = await tempRepo();
    const bare = workflow(bareCwd, {
      config: tieredConfig(),
      runner: checkRunner(async () => ({ code: 127, stdout: "", stderr: "sh: tsc: command not found" })),
    });
    await adHocChange(bareCwd);
    const failed = await bare.review();
    expect(failed.ok).toBe(false);
    expect(reportText(bare)).toContain("a tool or package is missing");
    expect(reportText(bare)).toContain("`setup:`");
  });
});

describe("verbose output", () => {
  it("formats durations", () => {
    expect([formatDuration(800), formatDuration(12_340), formatDuration(261_000), formatDuration(3_720_000)]).toEqual(["0.8s", "12.3s", "4m21s", "1h02m"]);
    expect([formatDuration(59_970), formatDuration(119_600), formatDuration(3_599_700)]).toEqual(["1m00s", "2m00s", "1h00m"]);
  });
});
