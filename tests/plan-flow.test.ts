import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { isSecuritySensitive } from "../src/orchestrator/classification.js";
import { readInterview } from "../src/orchestrator/interview.js";
import { LOCAL_SIZE_RULES, TICKET_RULES } from "../src/orchestrator/prompts.js";
import { CLOUD_TICKET_TOKENS, localLimits } from "../src/orchestrator/routing.js";
import { tempRepo, workflow } from "./helpers.js";

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return { id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: "Users can retry a failed ingest end to end.", acceptanceCriteria: ["retry works"], blockedBy: [] as string[], estimatedContextTokens: 40000, ...extra };
}

const specParams = { summary: "Retry failed ingests.", context: "src/ingest.ts parses and drops failures.", approach: "Wrap parse() in retryParse() with a fixed backoff.", changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }], reuse: ["sleep() in src/util.ts"], verification: ["npm test"], decisions: [{ question: "Backoff?", answer: "Fixed", rationale: "simple" }], assumptions: ["Node 20"], outOfScope: ["Metrics"], risks: ["Duplicate events"] };

/** `plan start`: a PLANNING task whose spec and tickets Claude Code drafts and the workflow validates. */
async function planning(extras: { request?: string } = {}) {
  const cwd = await tempRepo();
  const app = workflow(cwd);
  const started = await app.startPlan(extras.request ?? "Add retry to the ingest parser");
  expect(started.ok, started.text).toBe(true);
  return { cwd, app };
}

/** Saves tickets the way `plan tickets` does: validate, then commit. */
async function save(app: Awaited<ReturnType<typeof planning>>["app"], tickets: unknown[]) {
  app.requireTicketStage();
  const check = app.checkTickets(tickets);
  if (check.errors.length) throw new Error(check.errors.join("\n"));
  return app.commitTickets(check.tickets);
}

describe("plan start", () => {
  it("creates a PLANNING task and persists interview.json with the request, routing nothing and running no model", async () => {
    const { app } = await planning();
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("PLANNING");
    expect(task.planning).toEqual({ stage: "interview" });
    expect(readInterview((app as never as { ctx: never })["ctx"], task.taskId)).toEqual({ version: 1, request: "Add retry to the ingest parser" });
    const events = readFileSync(path.join(app.store.taskDir(task.taskId), "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"route"');
    expect(app.planningStage()).toBe("interview");
  });

  it("needs a request, and resumes the same request instead of starting another task", async () => {
    const empty = workflow(await tempRepo());
    expect((await empty.startPlan("  ")).code).toBe("USAGE");
    expect(empty.activeTaskId()).toBeUndefined();
    const { app, cwd } = await planning();
    const id = app.activeTaskId();
    await app.savePlanSpec(specParams);
    const again = workflow(cwd);
    const resumed = await again.startPlan("Add retry to the ingest parser");
    expect(resumed.ok).toBe(true);
    expect(resumed.text).toContain("Resuming");
    expect(again.activeTaskId()).toBe(id);
    expect(again.planningStage()).toBe("tickets");
  });
});

describe("the spec", () => {
  it("requires the spec first, and writes spec.md", async () => {
    const { app } = await planning();
    expect(() => app.requireTicketStage()).toThrow(/plan_spec/);
    await app.savePlanSpec(specParams);
    const spec = readFileSync(path.join(app.store.taskDir(app.activeTaskId()!), "spec.md"), "utf8");
    expect(spec).toContain("Retry failed ingests.");
    expect(spec).toContain("### Backoff?");
    expect(spec).toContain("- Metrics");
    expect(app.planningStage()).toBe("tickets");
  });

  it("rejects a spec without the required fields, naming each", async () => {
    const { app } = await planning();
    await expect(app.savePlanSpec({ summary: "x" })).rejects.toThrow(/approach is required[\s\S]*changes needs at least one file[\s\S]*verification needs at least one step/);
  });

  describe("the planner's rating", () => {
    const rating = { complexity: "low", risk: "low", securitySensitive: false, classificationReason: "one parser wrapper" };

    it("starts with the default classification and replaces it with the planner's rating", async () => {
      const { app } = await planning();
      const before = app.store.load(app.activeTaskId()!)!.classification!;
      expect(before).toMatchObject({ source: "default", complexity: "medium", task_type: "general" });
      const saved = await app.savePlanSpec({ ...specParams, ...rating });
      expect(saved.classification).toMatchObject({ complexity: "low", risk: "low" });
      const after = app.store.load(app.activeTaskId()!)!;
      expect(after.classification).toMatchObject({ source: "planner", complexity: "low", risk: "low", task_type: "general", required_capabilities: [] });
      expect(after.classification!.reason_codes).toContain("reason: one parser wrapper");
    });

    it("raises risk and the flag when the planner says security-sensitive", async () => {
      const { app } = await planning();
      await app.savePlanSpec({ ...specParams, ...rating, securitySensitive: true, risk: "medium" });
      const task = app.store.load(app.activeTaskId()!)!;
      expect(task.classification).toMatchObject({ task_type: "security", risk: "high", source: "planner" });
      expect(task.classification!.required_capabilities).toContain("security-sensitive");
      expect(isSecuritySensitive(task.classification!)).toBe(true);
    });

    it("scans nothing for keywords: a request or spec that mentions authentication stays as the planner rated it", async () => {
      const { app } = await planning({ request: "Rotate the oauth credentials the ingest job uses" });
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ task_type: "general", risk: "medium", source: "default" });
      await app.savePlanSpec({ ...specParams, ...rating, changes: [{ path: "src/auth.ts", change: "check the password hash before parsing" }] });
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ task_type: "general", risk: "low", complexity: "low", source: "planner" });
    });

    it("keeps the classification it has when the spec carries no rating, and rejects a malformed one", async () => {
      const { app } = await planning();
      await app.savePlanSpec(specParams);
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ source: "default" });
      await expect(app.savePlanSpec({ ...specParams, complexity: "huge" })).rejects.toThrow(/complexity must be one of low, medium, high/);
      await expect(app.savePlanSpec({ ...specParams, securitySensitive: "yes" })).rejects.toThrow(/securitySensitive must be true or false/);
    });

    it("keeps an earlier security flag when a revised spec leaves the field out", async () => {
      const { app } = await planning();
      await app.savePlanSpec({ ...specParams, ...rating, securitySensitive: true });
      await app.savePlanSpec({ ...specParams, complexity: "medium" });
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ task_type: "security", complexity: "medium", risk: "high" });
    });
  });
});

describe("the tickets", () => {
  async function atTicketStage() {
    const base = await planning();
    await base.app.savePlanSpec(specParams);
    return base;
  }
  const errorsOf = (app: Awaited<ReturnType<typeof planning>>["app"], tickets: unknown[]) => app.checkTickets(tickets).errors.join("\n");

  it("rejects cycles, missing blockers, duplicates, and tickets with no criterion", async () => {
    const { app } = await atTicketStage();
    expect(errorsOf(app, [ticket("01", { blockedBy: ["02"] }), ticket("02", { blockedBy: ["01"] })])).toMatch(/cycle/i);
    expect(errorsOf(app, [ticket("01", { blockedBy: ["09"] })])).toMatch(/blockedBy 09 does not exist/);
    expect(errorsOf(app, [ticket("01"), ticket("01", { slug: "other" })])).toMatch(/duplicate id/);
    expect(errorsOf(app, [ticket("01", { acceptanceCriteria: [] })])).toMatch(/acceptance criterion/);
  });

  it("asks for a split when the model estimate exceeds the target", async () => {
    const { app } = await atTicketStage();
    expect(errorsOf(app, [ticket("01", { estimatedContextTokens: 150001 })])).toMatch(/Split it/);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
  });

  it("adds the sizes of listed files to the code-side estimate", async () => {
    const { app, cwd } = await atTicketStage();
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "big.ts"), "x".repeat(600_000)); // 150K tokens alone
    writeFileSync(path.join(cwd, "src", "small.ts"), "export {};\n");
    expect(errorsOf(app, [ticket("01", { estimatedContextTokens: 1000, files: ["src/big.ts", "src/gone.ts"] })])).toMatch(/170\d\d\d tokens \(model 1000, code-side 170\d\d\d\)/);
    const ok = await save(app, [ticket("01", { estimatedContextTokens: 1000, files: ["src/small.ts", "src/missing.ts"] })]);
    expect(ok.files).toHaveLength(1);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
  });

  it("sizes tickets to the model of their difficulty: half a local model's window, else 150000", async () => {
    const cwd = await tempRepo();
    const config = parseConfig(`models: { low: local/Qwen3.8-27B }\nlocal:\n  baseUrl: "http://127.0.0.1:8081/v1"\n  models: [{ id: Qwen3.8-27B, contextWindow: 40000 }]\n`);
    const app = workflow(cwd, { config });
    await app.startPlan("Add retry to ingest");
    await app.savePlanSpec(specParams);
    // A low ticket is built by the local model: it must fit 20000 tokens. A medium one may use the cloud target.
    expect(errorsOf(app, [ticket("01", { difficulty: "low", estimatedContextTokens: 30000 })])).toMatch(/above the 20000 target/);
    await save(app, [ticket("01", { difficulty: "medium", estimatedContextTokens: 30000 })]);
  });

  it("names the size limit of a local model for the planner, and only then", () => {
    const local = parseConfig(`models: { low: local/Qwen3.8-27B }\nlocal:\n  baseUrl: "http://127.0.0.1:8081/v1"\n  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]\n`);
    const rules = LOCAL_SIZE_RULES(localLimits(local));
    expect(rules).toContain("[LOCAL MODEL LIMITS]");
    expect(rules).toContain("low tickets are built by local/Qwen3.8-27B, a local model with a 131072-token context window. Each must fit in about 65536 tokens");
    expect(localLimits(parseConfig(""))).toEqual([]);
    expect(TICKET_RULES(CLOUD_TICKET_TOKENS)).not.toContain("[LOCAL MODEL LIMITS]");
  });

  it("defaults the cloud target to 150000 tokens, and the ticket rules do not mention a review screen", () => {
    expect(CLOUD_TICKET_TOKENS).toBe(150000);
    expect(TICKET_RULES(CLOUD_TICKET_TOKENS)).not.toMatch(/review screen/);
  });

  it("writes ticket files in the to-tickets format, stores tickets in the plan, and maps them to groups", async () => {
    const { app } = await atTicketStage();
    const input = [
      ticket("01", { difficulty: "low", files: ["src/ingest.ts"] }),
      ticket("02", { blockedBy: ["01"], title: "Second", acceptanceCriteria: ["a", "b"], checks: ["npm test"] }),
    ];
    await save(app, input);
    const dir = path.join(app.store.taskDir(app.activeTaskId()!), "tickets");
    expect(readdirSync(dir).sort()).toEqual(["01-t01.md", "02-t02.md"]);
    const first = readFileSync(path.join(dir, "01-t01.md"), "utf8");
    expect(first).toMatch(/^---\nid: 01\nslug: t01\ndifficulty: low\nestimatedContextTokens: 40000\nfiles: \["src\/ingest.ts"\]\n---/);
    expect(first).toContain("# 01: Ticket 01");
    expect(first).toContain("## What to build\n\nUsers can retry a failed ingest end to end.");
    expect(first).toContain("## Acceptance criteria\n\n- [ ] retry works");
    expect(first).toContain("## Blocked by\n\nNone");
    expect(first).toContain("## Status: ready-for-agent");
    const second = readFileSync(path.join(dir, "02-t02.md"), "utf8");
    expect(second).toContain("## Blocked by\n\n- 01");
    expect(second).toContain("- [ ] a\n- [ ] b");
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(state.planning).toBeUndefined();
    expect(state.plan!.tickets!.map((item) => item.id)).toEqual(["01", "02"]);
    expect(state.plan!.groups).toMatchObject([
      { id: "01-t01", dependsOn: [], files: ["src/ingest.ts"], edits: [] },
      { id: "02-t02", dependsOn: ["01-t01"], files: [], edits: [] },
    ]);
    expect(state.plan!.groups[1]!.summary).toContain("Second");
    expect(state.plan!.groups[1]!.summary).toContain("- b");
    expect(state.plan!.summary).toBe("Retry failed ingests.");
  });

  it("still requires plan approval before /build", async () => {
    const { app } = await atTicketStage();
    await save(app, [ticket("01")]);
    const early = await app.startBuild();
    expect(early).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect((await app.approveDraft()).ok).toBe(true);
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.approvedVersion).toBe(1);
    expect(existsSync(path.join(app.store.taskDir(task.taskId), "plan.v1.approved.json"))).toBe(true);
  });

  it("sends a draft back for changes, then takes a revised spec and tickets", async () => {
    const { app } = await atTicketStage();
    await save(app, [ticket("01"), ticket("02", { blockedBy: ["01"] })]);
    expect((await app.reviseDraft("  ")).code).toBe("USAGE");
    const revised = await app.reviseDraft("Merge 01 and 02");
    expect(revised.ok, revised.text).toBe(true);
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("PLANNING");
    expect(task.planning).toEqual({ stage: "interview", revision: "Merge 01 and 02" });
    await app.savePlanSpec(specParams);
    await save(app, [ticket("01")]);
    expect(app.store.load(app.activeTaskId()!)!.plan!.tickets).toHaveLength(1);
  });
});
