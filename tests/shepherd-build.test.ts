import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { main, type CliOptions } from "../src/cli/shepherd.js";
import { ticketModePath } from "../src/cli/build-host.js";
import { fakeHerdrClient, type FakeHerdrClientOptions, type FakeTab } from "./herdr-fake.js";
import { TaskStore } from "../src/storage/store.js";
import { checkRunner, sampleSpec, tempRepo } from "./helpers.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
});

const AGENTS = "models: { low: agent:claude, medium: agent:claude, high: agent:claude, review: agent:claude }\n";
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const ticket = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  slug: `step-${id}`,
  title: `Step ${id}`,
  whatToBuild: `Build part ${id}.`,
  implementation: "Edit src/ingest.ts.",
  acceptanceCriteria: ["retry works"],
  blockedBy: [],
  difficulty: "medium",
  files: [`f${id}.txt`],
  estimatedContextTokens: 30_000,
  checks: ["npm test"],
  ...extra,
});

interface Doc {
  ok: boolean;
  code?: string;
  text: string;
  data?: { ticket?: { id: string; title: string }; outcome: string; done: boolean; stopped?: string; next?: { id: string }; report?: string };
}

/** What a fake tab does with a prompt: a ticket prompt writes the ticket's file; a review prompt writes `review.findings` to the file it names. */
async function setup(options: { config?: string; tickets?: number; fake?: FakeHerdrClientOptions; env?: NodeJS.ProcessEnv; piAvailable?: boolean; check?: () => { code: number; stdout: string; stderr: string } } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "build-home-"));
  process.env.HOME = home;
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "shepherd.yaml"), options.config ?? AGENTS);
  const repo = await tempRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "build-inputs-"));
  const review = { findings: [] as unknown[], summary: "Looks fine." };
  const reviewPrompts: string[] = [];
  const fake = fakeHerdrClient({
    onSend: (tab: FakeTab, text: string) => {
      const out = /Write ONLY a JSON object to (\S+\.json)/.exec(text)?.[1];
      if (out) {
        reviewPrompts.push(text);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({ summary: review.summary, findings: review.findings }));
      } else {
        const id = /^# Ticket (\d+):/m.exec(text)?.[1] ?? "x";
        writeFileSync(path.join(tab.options.cwd!, `f${id}.txt`), `built ${id} (${tab.sends.length})\n`);
      }
      if (tab.sessionDir) {
        const [provider, ...rest] = tab.model.replace(/:.*$/, "").split("/");
        const sm = SessionManager.create("/work", tab.sessionDir);
        sm.appendMessage({ role: "user", content: "t", timestamp: Date.now() } as never);
        sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done.\n- [x] retry works" }], api: "x", provider, model: rest.join("/"), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
      }
    },
    ...options.fake,
  });
  const checks = { calls: 0 };
  const cliOptions = (extra: Partial<CliOptions> = {}): CliOptions => ({
    env: { SHEPHERD_HOME: path.join(home, "shepherd-home"), ...options.env },
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    home,
    cwd: repo,
    herdr: fake.client,
    runner: checkRunner(async () => {
      checks.calls += 1;
      return options.check?.() ?? { code: 0, stdout: "ok", stderr: "" };
    }),
    herdrTimings: { sleep: async () => undefined },
    piAvailable: () => options.piAvailable ?? true,
    ...extra,
  });
  const cli = async (args: string[], stdin = "", extra: Partial<CliOptions> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (text) => out.push(text), err: (text) => err.push(text) }, { stdin, ...cliOptions(extra) });
    const text = out.join("");
    let json: Doc | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { code, out: text, err: err.join(""), json };
  };
  const file = (name: string, value: unknown) => {
    const where = path.join(dir, name);
    writeFileSync(where, JSON.stringify(value));
    return where;
  };
  /** Plans and approves `tickets` tickets (01 .. n) before any build. */
  const approved = async (count = options.tickets ?? 2, extra: Record<string, Record<string, unknown>> = {}) => {
    await cli(["plan", "start", "Add retry to the ingest parser"]);
    await cli(["plan", "spec", file("spec.json", sampleSpec)]);
    const tickets = Array.from({ length: count }, (_, i) => ticket(String(i + 1).padStart(2, "0"), extra[String(i + 1).padStart(2, "0")]));
    const saved = await cli(["plan", "tickets", file("tickets.json", { tickets })]);
    if (saved.code !== 0) throw new Error(saved.err || saved.out);
    if ((await cli(["plan", "approve"])).code !== 0) throw new Error("approve failed");
  };
  const taskDir = () => {
    const root = path.join(repo, ".shepherd", "tasks");
    return path.join(root, readdirSync(root)[0]!);
  };
  return { home, repo, cli, approved, fake, review, reviewPrompts, checks, taskDir };
}

describe("shepherd build --once", () => {
  it("builds exactly one ticket to its end, reports what comes next, and the next run builds the next", async () => {
    const t = await setup();
    await t.approved();
    const first = await t.cli(["build", "--once", "--json"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.json?.ok).toBe(true);
    expect(first.json?.data).toMatchObject({ ticket: { id: "01", title: "Step 01" }, outcome: "committed", done: false, next: { id: "02", title: "Step 02", difficulty: "medium" } });
    expect(first.json?.data?.report).toBeUndefined();
    expect(first.json?.text).toContain("Ticket 01 · medium");
    expect(first.json?.text).toContain("committed");
    expect(first.json?.text).toContain("Next: ticket 02");
    // The progress lines are in the text; stdout is the one JSON document.
    expect(gitIn(t.repo, "log", "--format=%s", "-3")).toContain("01: Step 01");
    expect(gitIn(t.repo, "branch", "--show-current")).toBe("shepherd/retry-ingest-parser");
    // The claim is not held between runs.
    expect(existsSync(path.join(t.taskDir(), "build.claim"))).toBe(false);

    const second = await t.cli(["build", "--once", "--json"]);
    expect(second.json?.data).toMatchObject({ ticket: { id: "02" }, outcome: "committed", done: true });
    expect(second.json?.data?.next).toBeUndefined();
    expect(second.json?.data?.report).toContain("| 02 | Step 02 | medium |");
    expect(second.json?.text).toContain("push and open the PR yourself");

    // Nothing left: the table again, done.
    const third = await t.cli(["build", "--once", "--json"]);
    expect(third.json).toMatchObject({ ok: true, data: { outcome: "done", done: true } });
    expect(third.json?.data?.ticket).toBeUndefined();
    expect(third.json?.data?.report).toContain("| 01 | Step 01 |");
    expect(gitIn(t.repo, "log", "--format=%s", "-3")).toContain("02: Step 02");
  });

  it("reports a ticket that failed and stops, with the reason, the table and a non-zero exit", async () => {
    const t = await setup({ check: () => ({ code: 1, stdout: "", stderr: "AssertionError: expected 1" }) });
    await t.approved(1);
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ ok: false, code: expect.stringMatching(/CHECKS_FAILED|MAX_ESCALATIONS/), data: { ticket: { id: "01" }, outcome: "stopped", done: false } });
    expect(run.json?.data?.stopped).toContain("Ticket 01");
    expect(run.json?.data?.report).toContain("failed");
    // The failed ticket's claim is released too.
    expect(existsSync(path.join(t.taskDir(), "build.claim"))).toBe(false);
  });
});

describe("shepherd build", () => {
  it("without --once builds every ticket, streaming progress lines to stdout, then the table", async () => {
    const t = await setup();
    await t.approved();
    const run = await t.cli(["build"]);
    expect(run.code).toBe(0);
    const lines = run.out.split("\n");
    expect(lines.findIndex((line) => line.includes("Ticket 01 · medium"))).toBeLessThan(lines.findIndex((line) => line.includes("Ticket 02 · medium")));
    expect(run.out).toContain("### Build · shepherd/retry-ingest-parser");
    expect(run.out).toContain("Built 2 ticket(s). Run /shepherd:review");
  });

  it("with --json prints one document whose text holds the progress lines", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    const run = await t.cli(["build", "--json"]);
    expect(run.json).toMatchObject({ ok: true, data: { done: true } });
    expect(run.json?.text).toContain("Ticket 01 · medium");
  });

  it("fails NEEDS_HERDR without a herdr terminal, before any branch is made", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"], "", { herdr: undefined, env: { SHEPHERD_HOME: path.join(t.home, "shepherd-home"), PATH: process.env.PATH } });
    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ ok: false, code: "NEEDS_HERDR", data: { outcome: "stopped", done: false } });
    expect(run.json?.text).toContain("HC_TERMINAL_ID");
    expect(run.json?.text).not.toContain("start Pi inside herdr");
    expect(gitIn(t.repo, "branch", "--show-current")).not.toContain("shepherd/");
    expect(gitIn(t.repo, "branch", "--list", "shepherd/*")).toBe("");
  });

  it("is refused without an approved plan, with the CLI's words", async () => {
    const t = await setup();
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json?.ok).toBe(false);
    expect(run.json?.data).toMatchObject({ outcome: "stopped", done: false });
  });

  it("releases the claim when the build throws out of a tab, and kills the tab a signal interrupts", async () => {
    const exits: number[] = [];
    let release: () => void = () => undefined;
    const t = await setup({
      tickets: 1,
      fake: {
        onSend: async (tab, text) => {
          // The first tab never answers: a signal arrives while the ticket is running.
          if (tab.address === "t1") await new Promise<void>((resolve) => (release = resolve));
          else if (/Write ONLY a JSON object to (\S+\.json)/.test(text)) return;
        },
      },
    });
    await t.approved();
    const running = t.cli(["build", "--once", "--json"], "", { exit: (code) => void exits.push(code) });
    for (let i = 0; i < 200 && t.fake.tabs.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < 200 && t.fake.tabs[0]?.sends.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(path.join(t.taskDir(), "build.claim"))).toBe(true);
    process.emit("SIGINT");
    for (let i = 0; i < 200 && exits.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exits).toEqual([130]);
    expect(t.fake.tabs[0]!.killed).toBe(true);
    expect(existsSync(path.join(t.taskDir(), "build.claim"))).toBe(false);
    release();
    await running;
  });
});

describe("the build-in-progress marker", () => {
  const pretool = (t: Awaited<ReturnType<typeof setup>>, command: string) => t.cli(["hook", "pretool"], JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command } }));
  const blocked = (result: { json?: unknown }) => (result.json as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision === "deny";

  it("is set when a build starts, kept between `build --once` runs (so the guard holds with no claim), and cleared when the last ticket is built", async () => {
    const t = await setup();
    await t.approved();
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(false);
    expect(blocked(await pretool(t, "git push"))).toBe(false);
    const first = await t.cli(["build", "--once", "--json"]);
    expect(first.json?.data).toMatchObject({ outcome: "committed", done: false });
    // Between tickets: no claim is held, but the build is in progress.
    expect(existsSync(path.join(t.taskDir(), "build.claim"))).toBe(false);
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(true);
    expect(blocked(await pretool(t, "git push origin main"))).toBe(true);
    expect(blocked(await pretool(t, "git checkout main"))).toBe(true);
    expect(blocked(await pretool(t, "git worktree add ../x"))).toBe(true);
    expect(blocked(await pretool(t, "git status"))).toBe(false);
    const second = await t.cli(["build", "--once", "--json"]);
    expect(second.json?.data).toMatchObject({ outcome: "committed", done: true });
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(false);
    expect(blocked(await pretool(t, "git push"))).toBe(false);
  });

  it("is cleared when a ticket stops the build, and when a full `shepherd build` ends", async () => {
    const stopped = await setup({ check: () => ({ code: 1, stdout: "", stderr: "AssertionError: expected 1" }) });
    await stopped.approved(1);
    expect((await stopped.cli(["build", "--once", "--json"])).json?.ok).toBe(false);
    expect(existsSync(path.join(stopped.taskDir(), "build.active"))).toBe(false);

    const all = await setup();
    await all.approved(2);
    expect((await all.cli(["build", "--json"])).json?.ok).toBe(true);
    expect(existsSync(path.join(all.taskDir(), "build.active"))).toBe(false);
  });

  it("is left alone by a run that never started (a spent budget, no herdr), and cleared with the task", async () => {
    const t = await setup({ config: `${AGENTS}budgets: { taskUsd: 5 }\n` });
    await t.approved();
    await t.cli(["build", "--once", "--json"]);
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(true);
    // No herdr terminal: NEEDS_HERDR before startBuild. The earlier run's marker stays.
    const noHerdr = await t.cli(["build", "--once", "--json"], "", { herdr: undefined, env: { SHEPHERD_HOME: path.join(t.home, "shepherd-home"), PATH: process.env.PATH } });
    expect(noHerdr.json).toMatchObject({ ok: false, code: "NEEDS_HERDR" });
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(true);
    // A start refused for a spent budget is not an end of the build either: the guard keeps holding until it is closed or finished.
    const taskId = path.basename(t.taskDir());
    new TaskStore(path.join(t.repo, ".shepherd")).appendLedger({ id: "big", at: "2026-10-14T12:00:00.000Z", taskId, phase: "IMPLEMENTING", provider: "anthropic", model: "claude-opus-5-5", tier: "interactive", requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd: 50, usageKnown: true, outcome: "success", retries: 0, reason: "observed assistant usage" });
    const broke = await t.cli(["build", "--once", "--json"]);
    expect(broke.json).toMatchObject({ ok: false, code: "BUDGET" });
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(true);
    const closed = await t.cli(["task", "close", "--force"]);
    expect(closed.code, closed.err).toBe(0);
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(false);
  });

  it("is cleared by a signal, with the claim", async () => {
    let release: () => void = () => undefined;
    const exits: number[] = [];
    const t = await setup({
      tickets: 1,
      fake: {
        onSend: async (tab) => {
          if (tab.address === "t1") await new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
    await t.approved();
    const running = t.cli(["build", "--once", "--json"], "", { exit: (code) => void exits.push(code) });
    for (let i = 0; i < 200 && t.fake.tabs[0]?.sends.length !== 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(true);
    process.emit("SIGTERM");
    for (let i = 0; i < 200 && exits.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exits).toEqual([130]);
    expect(existsSync(path.join(t.taskDir(), "build.active"))).toBe(false);
    release();
    await running;
  });
});

describe("the per-ticket review in a herdr sub-agent", () => {
  it("runs models.review in its own tab, reads its findings file, ledgers it as a ticket review, and closes the tab", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    t.review.findings = [{ likelihood: 4, severity: 3, issue: "low risk, dropped" }, { likelihood: 4, severity: 4, issue: "kept but below the gate", file: "f01.txt" }];
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.json?.ok, run.json?.text).toBe(true);
    const tabs = t.fake.tabs;
    expect(tabs).toHaveLength(2); // the ticket, then its review
    expect(tabs[1]!.options.labels).toEqual({ "shepherd.ticket-review": "01" });
    expect(tabs[1]!.options.name).toMatch(/^shep-.*-r01-1-[a-z0-9]{4}$/);
    expect(tabs[1]!.killed).toBe(true);
    expect(t.reviewPrompts[0]).toContain("git diff HEAD");
    expect(t.reviewPrompts[0]).toContain("# Ticket 01: Step 01");
    expect(run.json?.text).toContain("Ticket 01 review: pass");
    const rows = (await import("node:fs")).readFileSync(path.join(t.repo, ".shepherd", "cost", "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.reason === "ticket review · ticket 01")).toHaveLength(1);
    expect(rows.find((row) => row.reason === "ticket review · ticket 01")).toMatchObject({ tier: "review", provider: "agent", meter: "not-metered" });
  });

  it("fails the ticket on a high-risk finding: it gets the findings once, then stops REVIEW_FAILED, with nothing committed", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    t.review.findings = [{ likelihood: 9, severity: 8, issue: "retry loops forever", file: "f01.txt" }];
    const before = gitIn(t.repo, "rev-parse", "HEAD");
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json?.code).toBe("REVIEW_FAILED");
    expect(run.json?.data).toMatchObject({ outcome: "stopped", ticket: { id: "01" }, done: false });
    const [implementer, ...reviews] = t.fake.tabs;
    expect(implementer!.sends).toHaveLength(2);
    expect(implementer!.sends[1]).toContain("retry loops forever");
    expect(reviews).toHaveLength(2);
    expect(gitIn(t.repo, "log", "--format=%s", "-1")).not.toContain("01: Step 01");
    expect(gitIn(t.repo, "log", "--format=%s", `${before}..HEAD`)).toBe("");
  });

  it("commits with a warning when the review cannot run (a tab that never wrote its findings)", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    t.fake.tabs.length = 0;
    const run = await t.cli(["build", "--once", "--json"], "", {
      herdr: fakeHerdrClient({
        onSend: (tab, text) => {
          if (/Write ONLY a JSON object to/.test(text)) return; // the reviewer says "done" without a file
          writeFileSync(path.join(tab.options.cwd!, "f01.txt"), "x\n");
        },
      }).client,
    });
    expect(run.json?.ok, run.json?.text).toBe(true);
    expect(run.json?.text).toContain("committed without its review");
    expect(run.json?.text).toContain("did not write the findings file");
  });

  it("does not trust a review that edited the working tree: no verdict, the ticket is committed with a warning, the tab is left open", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    t.review.findings = [{ likelihood: 9, severity: 9, issue: "would fail the ticket" }];
    const run = await t.cli(["build", "--once", "--json"], "", {
      herdr: fakeHerdrClient({
        onSend: (tab, text) => {
          const out = /Write ONLY a JSON object to (\S+\.json)/.exec(text)?.[1];
          if (!out) return void writeFileSync(path.join(tab.options.cwd!, "f01.txt"), "x\n");
          mkdirSync(path.dirname(out), { recursive: true });
          writeFileSync(out, JSON.stringify({ findings: [] }));
          writeFileSync(path.join(tab.options.cwd!, "f01.txt"), "edited by the reviewer\n");
        },
      }).client,
    });
    expect(run.json?.text).toContain("changed the working tree during the review");
    expect(run.json?.text).toContain("committed without its review");
  });

  it("is skipped with review.tickets: false", async () => {
    const t = await setup({ tickets: 1, config: `${AGENTS}review: { tickets: false }\n` });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.json?.ok).toBe(true);
    expect(t.fake.tabs).toHaveLength(1);
  });

  it("runs a Pi model review as a Pi child with ticket-mode.ts, its session ledgered as a ticket review", async () => {
    const t = await setup({ tickets: 1, config: "models: { low: agent:claude, medium: agent:claude, high: agent:claude, review: openai/gpt-6.1-terra }\n" });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"], "", { ticketModePath: "/shepherd/src/ticket-mode.ts" });
    expect(run.json?.ok, run.json?.text).toBe(true);
    const review = t.fake.tabs[1]!;
    expect(review.options.argv).toContain("/shepherd/src/ticket-mode.ts");
    expect(review.model).toBe("openai/gpt-6.1-terra");
    expect(review.sessionDir).toContain(path.join(".shepherd", "tasks"));
    expect(path.basename(review.sessionDir)).toMatch(/^review-01-\d+$/);
    const rows = (await import("node:fs")).readFileSync(path.join(t.repo, ".shepherd", "cost", "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.find((row) => row.model === "gpt-6.1-terra")).toMatchObject({ tier: "review", reason: "ticket review · ticket 01" });
  });
});

describe("sub-agents and labels", () => {
  it("passes no herdr.space or herdr.tab label by default, so the child is a paneless sub-agent of this terminal", async () => {
    const t = await setup({ tickets: 1 });
    await t.approved();
    await t.cli(["build", "--once"]);
    for (const tab of t.fake.tabs) {
      expect(Object.keys(tab.options.labels ?? {}).filter((key) => key.startsWith("herdr."))).toEqual([]);
    }
    expect(t.fake.tabs[0]!.options.labels).toEqual({ "shepherd.ticket": "01" });
  });

  it("needs no herdr.space label on this terminal by default", async () => {
    const t = await setup({ tickets: 1, fake: { self: { terminal: "t0" } } });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.json?.ok, run.json?.text).toBe(true);
  });

  it("build.visibleTabs: true restores the labelled tabs (tickets and reviews)", async () => {
    const t = await setup({ tickets: 1, config: `${AGENTS}build: { visibleTabs: true }\n` });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.json?.ok, run.json?.text).toBe(true);
    expect(t.fake.tabs[0]!.options.labels).toMatchObject({ "herdr.space": "sp1", "herdr.tab": t.fake.tabs[0]!.options.name, "shepherd.ticket": "01" });
    expect(t.fake.tabs[1]!.options.labels).toMatchObject({ "herdr.space": "sp1", "shepherd.ticket-review": "01" });
  });

  it("build.visibleTabs needs the terminal's space label, and says so as NEEDS_HERDR", async () => {
    const t = await setup({ tickets: 1, config: `${AGENTS}build: { visibleTabs: true }\n`, fake: { self: { terminal: "t0" } } });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.json?.code).toBe("NEEDS_HERDR");
    expect(run.json?.text).toContain("herdr.space");
  });
});

describe("Pi tickets from the CLI", () => {
  const PI = "models: { low: local/qwen, medium: local/qwen, high: local/qwen, review: agent:claude }\n";

  it("runs a provider/id ticket as `pi -ne -e <ticket-mode.ts>` in the tab", async () => {
    const t = await setup({ tickets: 1, config: PI });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"], "", { ticketModePath: "/plugin/src/ticket-mode.ts" });
    expect(run.json?.ok, run.json?.text).toBe(true);
    const tab = t.fake.tabs[0]!;
    expect(tab.options.argv).toEqual(expect.arrayContaining(["pi", "-ne", "-e", "/plugin/src/ticket-mode.ts", "--model", "local/qwen"]));
    expect(tab.model).toBe("local/qwen");
  });

  it("fails NEEDS_PI before any branch is made when the first ticket needs Pi and `pi` is not installed", async () => {
    const t = await setup({ tickets: 1, config: PI, piAvailable: false });
    await t.approved();
    const run = await t.cli(["build", "--once", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ ok: false, code: "NEEDS_PI" });
    expect(run.json?.text).toContain("`pi` is not on PATH");
    expect(gitIn(t.repo, "branch", "--list", "shepherd/*")).toBe("");
    expect(t.fake.tabs).toHaveLength(0);
  });

  it("stops before the next ticket, NEEDS_PI, when that ticket's model is a Pi model and `pi` is gone", async () => {
    const t = await setup({ tickets: 2, config: "models: { low: agent:claude, medium: agent:claude, high: local/qwen, review: agent:claude }\n", piAvailable: false });
    await t.approved(2, { "02": { difficulty: "high" } });
    expect((await t.cli(["build", "--once", "--json"])).json?.ok).toBe(true);
    const second = await t.cli(["build", "--once", "--json"]);
    expect(second.json).toMatchObject({ ok: false, code: "NEEDS_PI", data: { outcome: "stopped" } });
    expect(second.json?.text).toContain("Ticket 02 starts on local/qwen");
    expect(t.fake.tabs.every((tab) => !tab.options.argv.includes("local/qwen"))).toBe(true);
  });
});

describe("ticketModePath", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const root = path.resolve(here, "..");

  it("finds src/ticket-mode.ts from the bundle (dist/shepherd.mjs), the compiled build and the source", () => {
    const expected = path.join(root, "src", "ticket-mode.ts");
    // A source checkout has no dist/ticket-mode.mjs here (see the next test); this is the fallback.
    const bundled = path.join(root, "dist", "ticket-mode.mjs");
    const want = existsSync(bundled) ? bundled : expected;
    expect(ticketModePath(path.join(root, "dist", "shepherd.mjs"))).toBe(want);
    expect(ticketModePath(new URL(`file://${path.join(root, "dist", "shepherd.mjs")}`))).toBe(want);
    expect(ticketModePath(path.join(root, "build", "cli", "build-host.js"))).toBe(want);
    expect(ticketModePath(path.join(root, "src", "cli", "build-host.ts"))).toBe(want);
    expect(ticketModePath()).toBe(want);
    expect(existsSync(expected)).toBe(true);
  });

  it("works in a plugin install laid out as <plugin>/dist/shepherd.mjs and <plugin>/src/ticket-mode.ts", () => {
    const plugin = mkdtempSync(path.join(tmpdir(), "plugin-"));
    mkdirSync(path.join(plugin, "src"));
    mkdirSync(path.join(plugin, "dist"));
    writeFileSync(path.join(plugin, "src", "ticket-mode.ts"), "export default () => {};\n");
    expect(ticketModePath(path.join(plugin, "dist", "shepherd.mjs"))).toBe(path.join(plugin, "src", "ticket-mode.ts"));
  });
});

describe("ticketModePath prefers the Pi worker bundle", () => {
  it("returns <plugin>/dist/ticket-mode.mjs when it exists, from the bundle or the compiled build, else src/ticket-mode.ts", () => {
    const plugin = mkdtempSync(path.join(tmpdir(), "plugin-bundle-"));
    mkdirSync(path.join(plugin, "src"));
    mkdirSync(path.join(plugin, "dist"));
    mkdirSync(path.join(plugin, "build", "cli"), { recursive: true });
    writeFileSync(path.join(plugin, "src", "ticket-mode.ts"), "export default () => {};\n");
    writeFileSync(path.join(plugin, "dist", "ticket-mode.mjs"), "export default () => {};\n");
    const bundle = path.join(plugin, "dist", "ticket-mode.mjs");
    expect(ticketModePath(path.join(plugin, "dist", "shepherd.mjs"))).toBe(bundle);
    expect(ticketModePath(path.join(plugin, "build", "cli", "build-host.js"))).toBe(bundle);
  });
});
