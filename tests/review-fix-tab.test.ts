import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { claudeProjectSlug } from "../src/runner/agent-usage.js";
import { sweepAgentLogs } from "../src/orchestrator/agent-sweep.js";
import { fakeHerdrClient, type FakeHerdrClientOptions, type FakeTab } from "./herdr-fake.js";
import { addTask, contextOf, tempRepo, tieredConfig, workflow } from "./helpers.js";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** A Pi child's session file: one user turn and one assistant reply. */
function child(dir: string, provider: string, model: string, text = "Fixed 1 of 1.") {
  const sm = SessionManager.create("/work", dir);
  sm.appendMessage({ role: "user", content: "t", timestamp: Date.now() } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "x", provider, model, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost }, stopReason: "stop", timestamp: Date.now() } as never);
}

/** A repo with an eval in an uncommitted file (a static finding), a `review` that saves the report, and `fix` that runs `shepherd fix --tab` on it. */
async function fixing(options: { medium?: string; herdr?: boolean; self?: { problem: string }; fake?: FakeHerdrClientOptions; ticketModePath?: string } = {}) {
  // The model pass would open a review tab first; these tests are about the fix tab.
  const config = tieredConfig(`review: { model: false }\n${options.medium ? `models: { medium: '${options.medium}' }\n` : ""}`);
  const progress: string[] = [];
  const fake = fakeHerdrClient({ ...(options.self ? { self: options.self as never } : {}), ...options.fake });
  const cwd = await tempRepo();
  const app = workflow(cwd, { config, herdr: options.herdr === false ? undefined : fake.client, herdrTimings: { sleep: async () => undefined }, ticketModePath: "ticketModePath" in options ? options.ticketModePath : "/shepherd/src/ticket-mode.ts", progress: (line) => void progress.push(line), report: () => undefined });
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "run.ts"), "export const run = (s: string) => eval(s);\n");
  const fix = async () => {
    await app.review();
    return app.fixInTab();
  };
  return { app, cwd, fake, progress, fix };
}

const fixRows = (t: Awaited<ReturnType<typeof fixing>>) => t.app.store.readLedger().filter((row) => row.reason.startsWith("review fix"));

describe("where `shepherd fix --tab` can run", () => {
  it("is available on models.medium only inside herdr", async () => {
    const inside = await fixing();
    expect(await inside.app.fixModel()).toMatchObject({ model: { kind: "pi", provider: "anthropic", id: "claude-sonnet-5-5" } });
    for (const options of [{ herdr: false }, { self: { problem: "not inside herdr" } }]) {
      const outside = await fixing(options);
      expect(await outside.app.fixModel()).toMatchObject({ problem: expect.stringContaining("needs herdr") });
      const result = await outside.fix();
      expect(result).toMatchObject({ ok: false, code: "NEEDS_HERDR" });
    }
  });

  it("is not available for a Pi model when this install does not know the worker extension, but is for an agent", async () => {
    const pi = await fixing({ ticketModePath: undefined });
    expect(await pi.app.fixModel()).toMatchObject({ problem: expect.stringContaining("ticket-mode") });
    const agent = await fixing({ ticketModePath: undefined, medium: "agent:gemini" });
    expect(await agent.app.fixModel()).toMatchObject({ model: { kind: "agent", name: "gemini" } });
  });
});

describe("Fix all in a tab with an agent", () => {
  it("runs the fix in its own tab, ledgers one 'not metered' review fix row, closes the tab and sends nothing to the session", async () => {
    const t = await fixing({ medium: "agent:gemini", fake: { read: () => "Addressed 1. Left none." } });
    const result = await t.fix();
    expect(result.ok, result.text).toBe(true);
    expect(t.fake.tabs).toHaveLength(1);
    const tab = t.fake.tabs[0]!;
    expect(tab.options.argv.slice(2, 3)).toEqual(["gemini"]);
    expect(tab.options.cwd).toBe(t.app.cwd);
    expect(tab.killed).toBe(true);
    const prompt = tab.sends[0]!;
    expect(prompt).toContain("Fix all 1 finding(s)");
    expect(prompt).toContain("Do not commit, push, or switch branches.");
    expect(prompt).toContain("one line per finding addressed");
    expect(prompt).not.toContain("Run /review again");
    expect(result.text).toContain("Addressed 1. Left none.");
    expect(result.text).toContain("Run /review to check.");
    expect(t.progress.join("\n")).toContain(`herdr tab ${tab.options.name}`);
    expect(fixRows(t)).toHaveLength(1);
    expect(fixRows(t)[0]).toMatchObject({ taskId: "session", provider: "agent", model: "gemini", meter: "not-metered", actualUsd: 0, phase: "REVIEWING", tier: "medium", reason: "review fix" });
  });

  it("meters Claude Code from its log and prices it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    const prior = process.env.HOME;
    process.env.HOME = home;
    try {
      const t = await fixing({
        medium: "agent:claude/claude-sonnet-5-5",
        fake: {
          onSend: (tab) => {
            const dir = path.join(home, ".claude", "projects", claudeProjectSlug(tab.options.cwd!));
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "r.jsonl"), `${JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`);
          },
        },
      });
      expect((await t.fix()).ok).toBe(true);
      expect(fixRows(t)).toHaveLength(1);
      expect(fixRows(t)[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", meter: "agent-log", inputTokens: 1000, outputTokens: 100, tier: "medium", phase: "REVIEWING" });
      expect(fixRows(t)[0]!.actualUsd).toBeCloseTo(0.0045, 6);
    } finally {
      process.env.HOME = prior;
    }
  });

  it("soft-resets a commit the agent made anyway and says so", async () => {
    const t = await fixing({
      medium: "agent:gemini",
      fake: {
        onSend: (tab) => {
          writeFileSync(path.join(tab.options.cwd!, "src", "run.ts"), "export const run = (s: string) => s;\n");
          gitIn(tab.options.cwd!, "add", ".");
          gitIn(tab.options.cwd!, "commit", "-m", "agent commit");
        },
      },
    });
    const head = gitIn(t.cwd, "rev-parse", "HEAD");
    const result = await t.fix();
    expect(result.ok, result.text).toBe(true);
    expect(gitIn(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(gitIn(t.cwd, "status", "--porcelain")).toContain("src/run.ts");
    expect(result.text).toContain("committed anyway");
    expect(result.text).toContain("git reset --soft");
  });

  it("undoes nothing when the agent switched branches, and says so", async () => {
    const t = await fixing({
      medium: "agent:gemini",
      fake: {
        onSend: (tab) => {
          gitIn(tab.options.cwd!, "switch", "-c", "elsewhere");
          writeFileSync(path.join(tab.options.cwd!, "other.txt"), "x\n");
          gitIn(tab.options.cwd!, "add", "other.txt");
          gitIn(tab.options.cwd!, "commit", "-m", "elsewhere");
        },
      },
    });
    const before = gitIn(t.cwd, "rev-parse", "--abbrev-ref", "HEAD");
    const result = await t.fix();
    expect(gitIn(t.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
    expect(gitIn(t.cwd, "log", "-1", "--format=%s")).toBe("elsewhere");
    expect(result.text).toContain(`left ${before} and is on elsewhere`);
    expect(result.text).toContain("left HEAD alone");
  });

  it("leaves the tab open and returns the reason when the tab dies; the spend is still ledgered", async () => {
    const t = await fixing({ medium: "agent:gemini", fake: { turn: () => [{ status: "ended", exitCode: 1 }] } });
    const result = await t.fix();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_FIX_FAILED" });
    expect(result.text).toContain("did not finish");
    expect(result.text).toContain("ended");
    expect(result.text).toContain(t.fake.tabs[0]!.options.name);
    expect(t.fake.tabs[0]!.killed).toBe(false);
    expect(fixRows(t)).toHaveLength(1);
  });

  it("reports a tab that could not open without throwing", async () => {
    const t = await fixing({ medium: "agent:gemini", fake: { failRun: () => "no such program" } });
    const result = await t.fix();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_FIX_FAILED" });
    expect(result.text).toContain("no such program");
    expect(t.fake.tabs).toHaveLength(0);
  });
});

describe("Fix all in a tab with a Pi model", () => {
  it("launches the pi child with ticket-mode on models.medium and ledgers its session files as review fix", async () => {
    const t = await fixing({
      fake: { onSend: (tab) => child(tab.sessionDir, "anthropic", "claude-sonnet-5-5") },
    });
    const result = await t.fix();
    expect(result.ok, result.text).toBe(true);
    const tab: FakeTab = t.fake.tabs[0]!;
    expect(tab.options.argv[0]).toBe("env");
    expect(tab.options.argv).toContain("-ne");
    expect(tab.options.argv).toContain("/shepherd/src/ticket-mode.ts");
    expect(tab.model).toBe("anthropic/claude-sonnet-5-5");
    expect(tab.sessionDir.startsWith(path.join(t.app.store.root, "sessions"))).toBe(true);
    expect(tab.killed).toBe(true);
    expect(result.text).toContain("Fixed 1 of 1.");
    expect(fixRows(t)).toHaveLength(1);
    expect(fixRows(t)[0]).toMatchObject({ taskId: "session", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 100, phase: "REVIEWING", tier: "medium", reason: "review fix" });
  });

  it("stops without a tab when `pi` is not on PATH", async () => {
    const t = await fixing({ fake: {} });
    contextOf(t.app).piAvailable = () => false;
    const result = await t.fix();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_FIX_FAILED" });
    expect(result.text).toContain("`pi` is not on PATH");
    expect(t.fake.tabs).toHaveLength(0);
  });
});

describe("Fix all in a tab and the outside-chef sweep", () => {
  it("advances the repo's agent-log watermark, so a following sweep counts nothing more", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    const prior = process.env.HOME;
    process.env.HOME = home;
    try {
      const t = await fixing({
        medium: "agent:claude/claude-sonnet-5-5",
        fake: {
          onSend: (tab) => {
            const dir = path.join(home, ".claude", "projects", claudeProjectSlug(tab.options.cwd!));
            mkdirSync(dir, { recursive: true });
            appendFileSync(path.join(dir, "r.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: "2026-10-14T12:30:00.000Z", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`);
          },
        },
      });
      const task = await addTask(t.app, "fix");
      const ctx = contextOf(t.app);
      mkdirSync(path.join(home, ".claude", "projects", claudeProjectSlug(ctx.git.repoRoot)), { recursive: true });
      await sweepAgentLogs(ctx, { home }); // the first sweep only sets the watermark
      expect(ctx.store.readAgentWatermark()).toBeDefined();
      await t.fix();
      expect(fixRows(t)).toHaveLength(1);
      expect(fixRows(t)[0]).toMatchObject({ taskId: task.taskId, meter: "agent-log", inputTokens: 1000 });
      const before = ctx.store.readLedger().length;
      await sweepAgentLogs(ctx, { home });
      expect(ctx.store.readLedger()).toHaveLength(before);
      expect(ctx.store.readLedger().filter((row) => row.reason === "outside chef")).toHaveLength(0);
    } finally {
      process.env.HOME = prior;
    }
  });
});
