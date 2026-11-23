import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgentModels, parseCursorListModels, parseGenericModelList, piModelCatalog } from "../src/agent-models.js";
import { guardHits } from "../src/cli/bash-guard.js";
import { main as shepherdCli } from "../src/cli/shepherd.js";
import { setKey, show } from "../src/cli/shepherd-config.js";
import { layerConfigs, loadConfig, parseConfig, priceFor } from "../src/config.js";
import { summarize } from "../src/cost/ledger.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { createHerdrClient, HerdrError } from "../src/herdr/client.js";
import { cachingRunner } from "../src/orchestrator/exec.js";
import { latestReview } from "../src/orchestrator/review-latest.js";
import { DEFAULT_PRICING } from "../src/pricing-defaults.js";
import { keepBest } from "../src/review/scored-json.js";
import { createAgentMeter } from "../src/runner/agent-usage.js";
import { openTab } from "../src/runner/tab.js";
import { herdrWorktreeDir, worktreePathFor } from "../src/orchestrator/worktree.js";
import { fakeHerdrClient } from "./herdr-fake.js";
import { addTask, contextOf, sampleSpec, sampleTicket, tempRepo, ticketWorkflow, workflow } from "./helpers.js";
// @ts-expect-error JS module
import { filterShepherdTerminals, formatCtxPill, splitThinking, withThinking } from "../herdr/shepherd-config/lib.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

describe("2026 default pricing, subscription billing, and Cursor stop-hook metering", () => {
  it("resolves built-in 2026 models including Dec-1 Argon/Carbon rollover", () => {
    const cfg = parseConfig("");
    const nov = new Date("2026-11-15");
    expect(priceFor(cfg.pricing, "anthropic", "claude-opus-5-5", nov)?.inputPerMillionUsd).toBe(4);
    expect(priceFor(cfg.pricing, "anthropic", "claude-fable-5-2", nov)?.inputPerMillionUsd).toBe(8);
    expect(priceFor(cfg.pricing, "openai", "gpt-6.2-astra", nov)?.inputPerMillionUsd).toBe(8);
    expect(priceFor(cfg.pricing, "google", "gemini-4-argon", nov)?.inputPerMillionUsd).toBe(2);
    expect(priceFor(cfg.pricing, "google", "gemini-4-argon", new Date("2026-12-05"))?.inputPerMillionUsd).toBe(4);
  });

  it("bills subscription agents as $0 while preserving API-equivalent listPriceUsd in summaries", async () => {
    const cwd = await tempRepo();
    const config = parseConfig(`
agents:
  codex: { billing: subscription }
`);
    const app = workflow(cwd, { config });
    const rows = app.recordAgentUsage({
      entries: [
        {
          agent: "codex",
          meter: "agent-log",
          provider: "openai",
          model: "gpt-6.2-astra",
          usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 },
        },
      ],
      reason: "agent codex · ticket 01",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualUsd).toBe(0);
    expect(rows[0]!.listPriceUsd).toBe(8);
    const sum = summarize(rows, { pricing: config.pricing });
    expect(sum.knownUsd).toBe(0);
    expect(sum.apiEquivalentUsd).toBe(8);
  });

  it("meters cursor-agent stop-hook JSONL and applies routingFeePerMillionUsd only to third-party models", async () => {
    const cwd = await tempRepo();
    const usageFile = path.join(cwd, ".shepherd", "cursor-usage.jsonl");
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const meter = createAgentMeter("cursor-agent", { cwd, cursorUsageFile: usageFile })!;
    expect(meter).toBeDefined();
    writeFileSync(
      usageFile,
      [
        JSON.stringify({ generation_id: "g1", model_id: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 }),
        JSON.stringify({ generation_id: "g2", model_id: "composer-2", input_tokens: 1_000_000, output_tokens: 0 }),
      ].join("\n") + "\n",
    );
    const calls = meter.collect();
    expect(calls).toHaveLength(2);
    const thirdParty = calls.find((c) => c.model === "claude-opus-5-5")!;
    const firstParty = calls.find((c) => c.model === "composer-2")!;
    expect(thirdParty.firstPartyCursor).toBeUndefined();
    expect(firstParty.firstPartyCursor).toBe(true);

    const config = parseConfig(`
agents:
  cursor-agent: { billing: api, routingFeePerMillionUsd: 0.25 }
`);
    const app = workflow(cwd, { config });
    const rows = app.recordAgentUsage({
      entries: calls.map((c) => ({ agent: "cursor-agent", meter: "agent-log" as const, ...c })),
      reason: "agent cursor-agent · ticket 01",
    });
    const opusRow = rows.find((r) => r.model === "claude-opus-5-5")!;
    const composerRow = rows.find((r) => r.model === "composer-2")!;
    expect(opusRow.actualUsd).toBeCloseTo(4.25, 6); // $4 base + $0.25 routing fee
    expect(composerRow.actualUsd).toBe(0); // first-party Cursor pool exempt from surcharge

    // Default cursor-agent billing is subscription ($0 billed, full API-equivalent listPriceUsd preserved).
    const defaultApp = workflow(cwd, { config: parseConfig("") });
    const subRows = defaultApp.recordAgentUsage({
      entries: [
        { agent: "cursor-agent", meter: "agent-log", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } },
      ],
      reason: "agent cursor-agent · ticket 02",
    });
    expect(subRows[0]!.actualUsd).toBe(0);
    expect(subRows[0]!.listPriceUsd).toBe(4);
  });
});

describe("unified agent model discovery & Herdr panel helpers", () => {
  it("parses cursor-agent --list-models and generic CLI lists and caches results", async () => {
    const cursorOut = "Available models\nauto - Auto\nauto-smart - Auto Smart\ncomposer-2 - Composer 2\nclaude-opus-5-5 - Claude Opus 5.5\n";
    const parsed = parseCursorListModels(cursorOut);
    expect(parsed.smart).toBe(true);
    expect(parsed.items.map((i) => i.id)).toContain("composer-2");

    const codexOut = "gpt-6.2-astra - Flagship Astra\ngpt-6.1-sol\n";
    expect(parseGenericModelList(codexOut).map((i) => i.id)).toEqual(["gpt-6.2-astra", "gpt-6.1-sol"]);

    const home = mkdtempSync(path.join(tmpdir(), "shep-models-"));
    let runs = 0;
    const cat = await discoverAgentModels({
      agent: "cursor-agent",
      home,
      run: async () => {
        runs++;
        return cursorOut;
      },
    });
    expect(runs).toBe(1);
    expect(cat.agents["cursor-agent"]!.smart).toBe(true);
    expect(cat.agents["cursor-agent"]!.models.map((m) => m.id)).toContain("auto-smart[optimize_for=balanced]");
    expect(cat.agents["cursor-agent"]!.models.map((m) => m.id)).toContain("composer-2");
    // Second call uses cache.
    const cat2 = await discoverAgentModels({ agent: "cursor-agent", home, run: async () => { runs++; return ""; } });
    expect(runs).toBe(1);
    expect(cat2.agents["cursor-agent"]!.source).toBe("cache");
    expect(piModelCatalog(DEFAULT_PRICING).length).toBeGreaterThan(10);
  });

  it("supports shepherd-config set for review.reviewers, budgets.idleAction, and agents.<name>.billing", () => {
    const prior = process.env.HOME;
    const home = mkdtempSync(path.join(tmpdir(), "shep-cfg-home-"));
    const proj = mkdtempSync(path.join(tmpdir(), "shep-cfg-proj-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(proj, ".shepherd"), { recursive: true });
    process.env.HOME = home;
    try {
      const r1 = setKey(proj, "budgets.idleAction", "off") as Record<string, any>;
      expect(r1.ok).toBe(true);
      expect(r1.budgets.idleAction).toBe("off");
      const r2 = setKey(proj, "review.reviewers", JSON.stringify(["agent:codex/gpt-6.2-astra", "agent:agy/gemini-4-argon"])) as Record<string, any>;
      expect(r2.ok).toBe(true);
      expect(r2.reviewReviewers).toHaveLength(2);
      const r3 = setKey(proj, "agents.codex.billing", "subscription") as Record<string, any>;
      expect(r3.ok).toBe(true);
      expect(r3.agentsBilling.codex).toBe("subscription");
      const shown = show(proj) as Record<string, any>;
      expect(shown.reviewReviewers.map((x: any) => x.model)).toEqual(["agent:codex/gpt-6.2-astra", "agent:agy/gemini-4-argon"]);
    } finally {
      if (prior === undefined) delete process.env.HOME;
      else process.env.HOME = prior;
    }
  });

  it("handles Herdr lib.js thinking, context pill, and terminal filter helpers", () => {
    expect(splitThinking("openai/gpt-6.2-astra:high")).toEqual({ base: "openai/gpt-6.2-astra", thinking: "high" });
    expect(withThinking("openai/gpt-6.2-astra:high", "default")).toBe("openai/gpt-6.2-astra");
    expect(withThinking("openai/gpt-6.2-astra", "xhigh")).toBe("openai/gpt-6.2-astra:xhigh");
    expect(formatCtxPill({ contextTokens: 84200, warm: true })).toBe("ctx 84k warm");
    expect(formatCtxPill({ contextTokens: 120000, warm: false })).toBe("ctx 120k cold");
    expect(filterShepherdTerminals([{ address: "t1", labels: { "shepherd.ticket": "01" } }, { address: "t2", labels: { other: "x" } }])).toHaveLength(1);
  });
});

describe("multi-model /review consensus deduplication and parallel execution", () => {
  it("merges similar cross-model findings on the same file and records consensus reviewers", () => {
    const merged = keepBest(
      [
        { likelihood: 6, severity: 8, category: "security", file: "src/auth.ts", message: "JWT verification skips `verifySignature` check on expired tokens", reviewers: ["Astra"] },
        { likelihood: 8, severity: 9, category: "security", file: "./src/auth.ts", message: "Expired token bypasses `verifySignature` during JWT verification", reviewers: ["Argon"] },
        { likelihood: 5, severity: 6, category: "bug", file: "src/other.ts", message: "Null pointer dereference on empty list", reviewers: ["Astra"] },
      ],
      10,
      { fuzzy: true },
    );
    expect(merged.findings).toHaveLength(2);
    expect(merged.findings[0]!.reviewers).toEqual(["Astra", "Argon"]);
    expect(merged.findings[0]!.likelihood * merged.findings[0]!.severity).toBe(72);
  });

  it("runs configured review.reviewers and formats consensus + reviewer breakdown", async () => {
    const cwd = await tempRepo();
    writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
    const fake = fakeHerdrClient({
      onSend: async (_tab, text) => {
        const out = /Write ONLY a JSON array of findings to (\S+\.json)/.exec(text)?.[1];
        if (!out) return;
        const finding = { likelihood: 7, severity: 8, category: "bug", file: "src.ts", message: "Missing bounds check on input payload" };
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify([finding]));
      },
    });
    const config = parseConfig(`
checks:
  - { name: ok, command: node, args: ["-e", "process.exit(0)"] }
review:
  reviewers:
    - { model: "agent:codex/gpt-6.2-astra", name: Astra, focus: "correctness" }
    - { model: "agent:agy/gemini-4-argon", name: Argon, focus: "architecture" }
`);
    const app = workflow(cwd, { config, herdr: fake.client, herdrTimings: { readyTimeoutMs: 500, turnTimeoutMs: 2000 } });
    const res = await app.review("");
    expect(res.ok, res.text).toBe(true);
    expect(res.text).toContain("### Reviewers");
    expect(res.text).toContain("Astra");
    expect(res.text).toContain("Argon");
    expect(res.text).toContain("[2/2 agree: Astra, Argon]");
  });
});

describe("compaction hooks and compact-config", () => {
  it("snapshots state on precompact, restores additionalContext on postcompact, and configures settings.json", async () => {
    const cwd = await tempRepo();
    const home = mkdtempSync(path.join(tmpdir(), "shep-compact-"));
    const shepherd = path.join(home, ".claude", "shepherd");
    const env = { ...process.env, SHEPHERD_HOME: shepherd };
    const runCli = async (argv: string[], stdin?: string) => {
      let out = "";
      let err = "";
      const code = await shepherdCli(argv, { out: (t) => (out += t), err: (t) => (err += t) }, { cwd, home, env, stdin });
      return { code, out, err };
    };
    await addTask(workflow(cwd), "auth-refresh", { branch: "shepherd/auth-refresh", phase: "IMPLEMENTING" });
    const pre = await runCli(["hook", "precompact"], JSON.stringify({ session_id: "s1", cwd }));
    expect(pre.code).toBe(0);
    const post = await runCli(["hook", "postcompact"], JSON.stringify({ session_id: "s1", cwd }));
    expect(post.code).toBe(0);
    const parsed = JSON.parse(post.out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostCompact");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("auth-refresh");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("shepherd/auth-refresh");

    const setPct = await runCli(["compact-config", "--pct", "55", "--json"]);
    expect(setPct.code).toBe(0);
    expect(JSON.parse(setPct.out).data.pct).toBe(55);
    const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("55");

    const bad = await runCli(["compact-config", "--pct", "10", "--json"]);
    expect(bad.code).toBe(1);

    const off = await runCli(["compact-config", "--off", "--json"]);
    expect(off.code).toBe(0);
    const settingsAfter = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settingsAfter.env).toBeUndefined();
  });
});

describe("planning worktrees, build pause, cleanup, and ship", () => {
  let priorHome: string | undefined;
  let home: string;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "shep-wt-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });

  it("resolves Herdr worktree directory from settings.json and builds Herdr-aligned paths", () => {
    const appHome = path.join(home, ".config", "herdr-app");
    mkdirSync(appHome, { recursive: true });
    writeFileSync(path.join(appHome, "settings.json"), JSON.stringify({ worktrees: { directory: "~/my-wts" } }));
    const base = herdrWorktreeDir(home, appHome);
    expect(base).toBe(path.join(home, "my-wts"));
    expect(worktreePathFor("/code/my-app", "shepherd/add-auth", base)).toBe(path.join(home, "my-wts", "my-app", "shepherd-add-auth"));
  });

  it("creates a linked worktree on plan start --worktree, shares .shepherd/, and cleans up merged branches/worktrees", async () => {
    const cwd = await tempRepo();
    const wtDir = path.join(mkdtempSync(path.join(tmpdir(), "shep-wts-")), "feat-wt");
    const app = workflow(cwd, { agentLogHome: home });
    const started = await app.startPlan("Add parallel feature", { worktree: wtDir });
    expect(started.ok, started.text).toBe(true);
    expect(existsSync(wtDir)).toBe(true);
    const taskId = app.activeTaskId()!;
    const state = app.store.load(taskId)!;
    expect(state.worktree?.path).toBe(wtDir);
    expect(await git(wtDir, "branch", "--show-current")).toBe(state.worktree!.branch);

    // Pause build clears marker cleanly.
    app.store.markBuilding(taskId, "2026-10-14T12:00:00.000Z");
    const paused = await app.pauseBuild();
    expect(paused.ok, paused.text).toBe(true);
    expect(app.store.buildInProgress(taskId)).toBe(false);

    // Cleanup KEEPS a freshly created open worktree task (0 commits ahead of main must not delete an open task).
    const kept = await app.cleanup({ dryRun: true });
    expect(kept.ok, kept.text).toBe(true);
    expect(kept.text).toContain("Kept");
    expect(kept.text).toContain("open task");
    expect(existsSync(wtDir)).toBe(true);

    // Once the task is closed, cleanup dry-run previews removing the worktree + branch, and real cleanup removes them.
    const closed = await app.plans(`close ${state.name}`);
    expect(closed.ok, closed.text).toBe(true);

    const dry = await app.cleanup({ dryRun: true });
    expect(dry.ok, dry.text).toBe(true);
    expect(dry.text).toContain("dry run");
    expect(dry.text).toContain(wtDir);
    expect(existsSync(wtDir)).toBe(true);

    const clean = await app.cleanup();
    expect(clean.ok, clean.text).toBe(true);
    expect(existsSync(wtDir)).toBe(false);
    expect(await git(cwd, "branch", "--list", state.worktree!.branch)).toBe("");
  });

  it("runs ship preflight, blocks on base/dirty tree, pushes and creates PR with mocked gh, and gates remote ops in pretool", async () => {
    const cwd = await tempRepo();
    const remoteDir = mkdtempSync(path.join(tmpdir(), "shep-remote-"));
    await exec("git", ["init", "--bare"], { cwd: remoteDir });
    await exec("git", ["remote", "add", "origin", remoteDir], { cwd });

    const { app } = await ticketWorkflow([sampleTicket("01")], {}, { cwd });
    const base = await git(cwd, "branch", "--show-current");
    // On base branch: not ready.
    const onBase = await app.ship();
    expect(onBase.ok).toBe(true);
    expect((onBase.data as { ready: boolean }).ready).toBe(false);

    // Create feature branch with a commit.
    await exec("git", ["switch", "-c", "shepherd/retry-ingest-parser"], { cwd });
    writeFileSync(path.join(cwd, "feature.ts"), "export const ok = true;\n");
    await exec("git", ["add", "feature.ts"], { cwd });
    await exec("git", ["commit", "-m", "01: add feature"], { cwd });

    const preflight = await app.ship({ base });
    expect(preflight.ok).toBe(true);
    expect((preflight.data as { ready: boolean; commits: number; prBody: string }).ready).toBe(true);
    expect((preflight.data as { commits: number }).commits).toBe(1);
    expect((preflight.data as { prBody: string }).prBody).toContain("## Tickets");

    let prCalledWith: string[] | undefined;
    const shipped = await app.ship({
      base,
      pr: true,
      draft: true,
      execPr: async (args) => {
        prCalledWith = args;
        return { code: 0, stdout: "https://github.com/org/repo/pull/42\n", stderr: "" };
      },
    });
    expect(shipped.ok, shipped.text).toBe(true);
    expect((shipped.data as { pushed: boolean; prUrl?: string }).pushed).toBe(true);
    expect((shipped.data as { prUrl?: string }).prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(prCalledWith).toContain("--draft");

    // PreToolUse gates `shepherd ship --push` and `shepherd cleanup --remote` with `ask`.
    const runPretool = async (command: string) => {
      let out = "";
      await shepherdCli(
        ["hook", "pretool"],
        { out: (t) => (out += t), err: () => undefined },
        { cwd, home, stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }) },
      );
      return JSON.parse(out);
    };
    expect((await runPretool("shepherd ship --push")).hookSpecificOutput.permissionDecision).toBe("ask");
    expect((await runPretool("shepherd cleanup --remote")).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("retries hc send when a freshly started agent reports output has not settled", async () => {
    const fake = fakeHerdrClient();
    let attempts = 0;
    const origSend = fake.client.send.bind(fake.client);
    fake.client.send = async (terminal, text, options) => {
      attempts += 1;
      if (attempts <= 2) {
        throw new HerdrError(`hc send ${terminal} (text omitted) failed: ${terminal} is still starting: its output has not settled`, "hc send");
      }
      return origSend(terminal, text, options);
    };
    const tab = await openTab({
      client: fake.client,
      cwd: "/tmp",
      argv: ["codex", "-m", "gpt-6-astra"],
      name: "shep-rev-120000-2-gpt6astra",
      progress: () => undefined,
      blockedNotice: "blocked",
      sleep: async () => undefined,
      pollMs: 1,
    });
    await tab.prompt("review diff");
    expect(attempts).toBe(3);
    expect(fake.tabs[0]?.sends).toEqual(["review diff"]);
    await tab.close();
  });
});

describe("multi-model review audit regression tests", () => {
  it("gives user pricing overrides precedence over 2026 built-ins even with earlier effectiveFrom dates", () => {
    const cfg = parseConfig(`
pricing:
  - { provider: anthropic, model: claude-opus-5-5, effectiveFrom: "2025-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
`);
    const row = priceFor(cfg.pricing, "anthropic", "claude-opus-5-5", new Date("2026-11-23"));
    expect(row?.inputPerMillionUsd).toBe(0);
    expect(row?.outputPerMillionUsd).toBe(0);
  });

  it("never estimates an unknown Cursor model at $0 despite $0 first-party Cursor rows", () => {
    const cfg = parseConfig("");
    const sum = summarize(
      [
        {
          id: "c1",
          at: "2026-11-23T12:00:00.000Z",
          taskId: "t1",
          phase: "IMPLEMENTING",
          provider: "cursor",
          model: "auto",
          tier: "agent",
          requests: 1,
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          actualUsd: null,
          usageKnown: false,
          outcome: "success",
          retries: 0,
          reason: "agent cursor-agent",
        },
      ],
      { pricing: cfg.pricing, unknownCallUsd: 0.05 },
    );
    expect(sum.estimatedUnknownUsd).toBeCloseTo(0.05, 6);
  });

  it("treats worktree as a user-only config section", () => {
    const warnings: string[] = [];
    const merged = layerConfigs({}, { worktree: { default: "always", dir: "/tmp/evil" } }, warnings);
    expect(merged.worktree).toBeUndefined();
    expect(warnings.some((w) => w.includes("worktree"))).toBe(true);
  });

  it("filters Gemini/AGY usage logs by repository so unrelated projects are never billed", async () => {
    const repoA = await tempRepo();
    const repoB = await tempRepo();
    const home = mkdtempSync(path.join(tmpdir(), "shep-gem-home-"));
    const dirA = path.join(home, ".gemini", "tmp", "projA");
    const dirB = path.join(home, ".gemini", "tmp", "projB");
    mkdirSync(path.join(dirA, "chats"), { recursive: true });
    mkdirSync(path.join(dirB, "chats"), { recursive: true });
    writeFileSync(path.join(dirA, ".project_root"), repoA);
    writeFileSync(path.join(dirB, ".project_root"), repoB);

    const meter = createAgentMeter("agy", { cwd: repoA, home })!;
    writeFileSync(
      path.join(dirA, "chats", "s1.jsonl"),
      `${JSON.stringify({ id: "m1", model: "gemini-4-argon", tokens: { input: 1000, output: 500 } })}\n`,
    );
    writeFileSync(
      path.join(dirB, "chats", "s2.jsonl"),
      `${JSON.stringify({ id: "m2", model: "gemini-4-argon", tokens: { input: 9000, output: 9000 } })}\n`,
    );
    const calls = meter.collect();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.usage.input).toBe(1000);
  });

  it("prevents fuzzy dedupe from merging a second distinct finding from a reviewer already in a cluster", () => {
    const merged = keepBest(
      [
        { likelihood: 8, severity: 8, category: "bug", file: "src/a.ts", message: "handle foo validation error on missing header", reviewers: ["Astra"] },
        { likelihood: 7, severity: 8, category: "bug", file: "src/a.ts", message: "foo validation error on missing header check", reviewers: ["Argon"] },
        { likelihood: 6, severity: 7, category: "bug", file: "src/a.ts", message: "foo validation error on missing footer check", reviewers: ["Astra"] },
      ],
      10,
      { fuzzy: true },
    );
    expect(merged.findings).toHaveLength(2);
  });

  it("protects unmerged [gone] local branches and checks origin/<base> only for remoteBranchMerged", async () => {
    const cwd = await tempRepo();
    const remoteDir = mkdtempSync(path.join(tmpdir(), "shep-rem-"));
    await exec("git", ["init", "--bare"], { cwd: remoteDir });
    await exec("git", ["remote", "add", "origin", remoteDir], { cwd });
    const base = await git(cwd, "branch", "--show-current");
    await exec("git", ["push", "-u", "origin", base], { cwd });

    // Create feature branch, push it, then delete it on origin while local branch still has unmerged commit.
    await exec("git", ["switch", "-c", "shepherd/unmerged-gone"], { cwd });
    writeFileSync(path.join(cwd, "u.ts"), "export const u = 1;\n");
    await exec("git", ["add", "u.ts"], { cwd });
    await exec("git", ["commit", "-m", "unmerged work"], { cwd });
    await exec("git", ["push", "-u", "origin", "shepherd/unmerged-gone"], { cwd });
    await exec("git", ["push", "origin", "--delete", "shepherd/unmerged-gone"], { cwd });
    await exec("git", ["fetch", "--prune", "origin"], { cwd });
    await exec("git", ["switch", base], { cwd });

    const app = workflow(cwd);
    const cleaned = await app.cleanup();
    expect(cleaned.ok).toBe(true);
    // Unmerged [gone] branch MUST still exist without --force.
    expect(await git(cwd, "branch", "--list", "shepherd/unmerged-gone")).toContain("shepherd/unmerged-gone");

    // Local-only merge into base (without pushing base to origin) must NOT mark remote branch as merged.
    await exec("git", ["switch", "-c", "shepherd/local-only-merge"], { cwd });
    writeFileSync(path.join(cwd, "m.ts"), "export const m = 1;\n");
    await exec("git", ["add", "m.ts"], { cwd });
    await exec("git", ["commit", "-m", "feature"], { cwd });
    await exec("git", ["push", "-u", "origin", "shepherd/local-only-merge"], { cwd });
    await exec("git", ["switch", base], { cwd });
    await exec("git", ["merge", "--ff-only", "shepherd/local-only-merge"], { cwd });
    const gw = new GitWorkspace(cwd);
    expect(await gw.remoteBranchMerged("shepherd/local-only-merge", base, "origin")).toBe(false);
  });

  it("keeps shepherd status read-only, avoids quote false positives in guardHits, and blocks ship during active build", async () => {
    const cwd = await tempRepo();
    const home = mkdtempSync(path.join(tmpdir(), "shep-ro-"));
    const env = { ...process.env, SHEPHERD_HOME: path.join(home, ".claude", "shepherd") };
    let out = "";
    const code = await shepherdCli(["status", "--statusline"], { out: (t) => (out += t), err: () => undefined }, { cwd, home, env });
    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, ".shepherd"))).toBe(false);

    // Quote-aware guardHits must not treat a commit message mentioning git push as a push.
    expect(guardHits('git commit -m "fix; git push later"')).toEqual([]);
    expect(guardHits("git push origin main")).toContain("git push");

    // PreToolUse denies ship --push while a build marker is set, and names --remote in ask reason when idle.
    const app = workflow(cwd, { agentLogHome: home });
    const added = await addTask(app, "demo", { branch: "main", phase: "IMPLEMENTING" });
    app.store.markBuilding(added.taskId, "2026-11-23T12:00:00.000Z");
    const runPretool = async (command: string) => {
      let s = "";
      await shepherdCli(
        ["hook", "pretool"],
        { out: (t) => (s += t), err: () => undefined },
        { cwd, home, env, stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }) },
      );
      return JSON.parse(s);
    };
    expect((await runPretool("shepherd ship --push")).hookSpecificOutput.permissionDecision).toBe("deny");
    app.store.clearBuilding(added.taskId);
    const ask = await runPretool("shepherd ship --push --remote upstream");
    expect(ask.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(ask.hookSpecificOutput.permissionDecisionReason).toContain("to upstream");
  });

  it("preserves permissions, symlinks, and .bak backup in compact-config", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "shep-set-"));
    const dotfile = path.join(home, "real-settings.json");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(dotfile, JSON.stringify({ theme: "dark" }, null, 2), { mode: 0o600 });
    chmodSync(dotfile, 0o600);
    const link = path.join(home, ".claude", "settings.json");
    symlinkSync(dotfile, link);

    let out = "";
    const code = await shepherdCli(["compact-config", "--pct", "60", "--json"], { out: (t) => (out += t), err: () => undefined }, { home });
    expect(code).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(dotfile).mode & 0o777).toBe(0o600);
    expect(existsSync(`${dotfile}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(dotfile, "utf8")).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("60");
  });

  it("loads common-root project config and shared plans inside linked worktrees and isolates check cache per worktree", async () => {
    const cwd = await tempRepo();
    const priorHome = process.env.HOME;
    const home = mkdtempSync(path.join(tmpdir(), "shep-wt-cfg-"));
    process.env.HOME = home;
    try {
      mkdirSync(path.join(cwd, ".shepherd"), { recursive: true });
      writeFileSync(path.join(cwd, ".shepherd", ".gitignore"), "*\n");
      writeFileSync(path.join(cwd, ".shepherd", "config.yaml"), "budgets:\n  taskUsd: 42\n");
      const wtDir = path.join(mkdtempSync(path.join(tmpdir(), "shep-wt-dir-")), "wt1");
      const app = workflow(cwd, { agentLogHome: home });
      await app.startPlan("Shared worktree plan", { worktree: wtDir });

      // loadConfig with fallbackRoot finds main checkout's .shepherd/config.yaml.
      expect(loadConfig(wtDir, cwd).budgets.taskUsd).toBe(42);
      // Panel show() from inside linked worktree sees both shared plan and project config!
      const panel = show(wtDir) as Record<string, any>;
      expect(panel.ok).toBe(true);
      expect(panel.budgets.taskUsd).toBe(42);
      expect(panel.plans.length).toBe(1);

      // Disk check cache is scoped per checkout dir (worktree never reuses main checkout's pass).
      const cacheFile = path.join(cwd, ".shepherd", "cache", "checks.json");
      let runs = 0;
      const runner = cachingRunner(
        new GitWorkspace(cwd),
        {
          run: async () => {
            runs += 1;
            return { code: 0, stdout: "ok", stderr: "" };
          },
        },
        cacheFile,
        () => 1_700_000_000_000,
      );
      await runner.run("npm", ["test"], cwd);
      await runner.run("npm", ["test"], cwd);
      expect(runs).toBe(1);
      await runner.run("npm", ["test"], wtDir);
      expect(runs).toBe(2);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("matches latestReview branch association to runReview and blocks denied child argv in hc run", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    await addTask(app, "other-branch-task", { branch: "shepherd/other", phase: "IMPLEMENTING" });
    // On main (not shepherd/other), save an ad-hoc review report; latestReview must return it, not undefined/other task.
    const reportsDir = path.join(cwd, ".shepherd", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(path.join(reportsDir, "review-20261123-120000.json"), JSON.stringify({ passed: true, checks: [], findings: [], summary: "ad-hoc" }));
    const found = await latestReview(contextOf(app));
    expect(found?.report.summary).toBe("ad-hoc");

    // hc run rejects denied destructive child argv.
    const hc = createHerdrClient({ exec: async () => ({ code: 0, stdout: JSON.stringify({ address: "t1" }), stderr: "" }) });
    await expect(hc.run({ argv: ["rm", "-rf", "/"] })).rejects.toThrow(/refused by the command rules/);
  });
});
