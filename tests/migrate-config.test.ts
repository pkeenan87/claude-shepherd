import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/shepherd.js";
import { loadConfig } from "../src/config.js";

const OLD = `# my pi-chef config
models:
  low: xai/grok-4.7   # cheap
  medium: agent:claude
review:
  tickets: true
  maxDiffChars: 50000
  maxChunks: 3
  timeoutMs: 60000
budgets: { taskUsd: 5, dailyUsd: 10 }
tiers: { cheap: [] }
quota: {}
branchPrefix: mine
`;

describe("shepherd migrate-config", () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "migrate-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  });
  const oldFile = (name = "chef.yaml") => path.join(home, ".pi", "agent", name);
  const newFile = () => path.join(home, ".claude", "shepherd.yaml");
  const writeOld = (text = OLD, name = "chef.yaml") => {
    mkdirSync(path.dirname(oldFile(name)), { recursive: true });
    writeFileSync(oldFile(name), text);
  };
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["migrate-config", ...args], { out: (t) => out.push(t), err: (t) => err.push(t) }, { home, cwd: home });
    return { code, out: out.join(""), err: err.join("") };
  };

  it("copies the pi-chef config to ~/.claude/shepherd.yaml, drops what shepherd does not read, keeps comments, and reports it", async () => {
    writeOld();
    const result = await run();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("Wrote ~/.claude/shepherd.yaml from ~/.pi/agent/chef.yaml");
    expect(result.out).toContain("Dropped 4 setting(s) shepherd does not read: review.maxDiffChars, review.maxChunks, tiers, quota");
    const text = readFileSync(newFile(), "utf8");
    expect(text).toContain("# my pi-chef config");
    expect(text).toContain("low: xai/grok-4.7 # cheap");
    expect(text).not.toMatch(/maxDiffChars|maxChunks|tiers|quota/);
    // The result is valid for the loader, with the old settings that are still read.
    const config = loadConfig(home);
    // Nothing ignored; the only note is that these models have no pricing row.
    expect((config.warnings ?? []).filter((item) => item.startsWith("Ignored"))).toEqual([]);
    expect(config.models).toMatchObject({ low: "xai/grok-4.7", medium: "agent:claude" });
    expect(config.review).toEqual({ model: true, tickets: true, timeoutMs: 60000 });
    expect(config.budgets).toMatchObject({ taskUsd: 5, dailyUsd: 10 });
    expect(config.branchPrefix).toBe("mine");
    // The pi-chef file is left where it is.
    expect(readFileSync(oldFile(), "utf8")).toBe(OLD);
  });

  it("reads chef.yml when there is no chef.yaml, and says nothing was dropped when every key is read", async () => {
    writeOld("models: { low: xai/grok-4.7 }\n", "chef.yml");
    const result = await run();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("from ~/.pi/agent/chef.yml");
    expect(result.out).toContain("Every setting is one shepherd reads; none were dropped.");
  });

  it("never overwrites an existing shepherd.yaml", async () => {
    writeOld();
    mkdirSync(path.dirname(newFile()), { recursive: true });
    writeFileSync(newFile(), "budgets: { taskUsd: 99 }\n");
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("already exists, so nothing was changed");
    expect(result.err).toContain("--force");
    expect(readFileSync(newFile(), "utf8")).toBe("budgets: { taskUsd: 99 }\n");
    expect(readdirSync(path.dirname(newFile())).filter((name) => name.includes(".bak"))).toEqual([]);
  });

  it("--force writes a .bak of the existing file first, and a second --force keeps both backups", async () => {
    writeOld();
    mkdirSync(path.dirname(newFile()), { recursive: true });
    writeFileSync(newFile(), "budgets: { taskUsd: 99 }\n");
    const first = await run("--force");
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain("Backed up ~/.claude/shepherd.yaml to ~/.claude/shepherd.yaml.bak.");
    expect(readFileSync(`${newFile()}.bak`, "utf8")).toBe("budgets: { taskUsd: 99 }\n");
    expect(readFileSync(newFile(), "utf8")).toContain("# my pi-chef config");
    const second = await run("--force");
    expect(second.code, second.err).toBe(0);
    expect(second.out).toContain("shepherd.yaml.bak.2");
    expect(readFileSync(`${newFile()}.bak`, "utf8")).toBe("budgets: { taskUsd: 99 }\n");
    expect(readFileSync(`${newFile()}.bak.2`, "utf8")).toContain("# my pi-chef config");
  });

  it("writes nothing when the old file does not make a valid config (a secret, a bad value, bad YAML)", async () => {
    for (const text of ["branchPrefix: sk-abcdefghijklmnopqrstuvwxyz0123456789\n", "models: { low: 'not a ref' }\n", "models: [unclosed\n"]) {
      writeOld(text);
      const result = await run();
      expect(result.code, text).toBe(1);
      expect(result.err, text).toMatch(/nothing was written|Nothing was written/);
      expect(result.err).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(existsSync(newFile())).toBe(false);
    }
  });

  it("drops a Pi-only key that holds a secret rather than copying it", async () => {
    writeOld("models: { low: xai/grok-4.7 }\napiKey: sk-abcdefghijklmnopqrstuvwxyz0123456789\n");
    const result = await run();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("Dropped 1 setting(s) shepherd does not read: apiKey.");
    expect(readFileSync(newFile(), "utf8")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("says where to look when there is no pi-chef config, and prints JSON with --json", async () => {
    const none = await run();
    expect(none.code).toBe(1);
    expect(none.err).toContain("No pi-chef config found");
    writeOld();
    const json = await run("--json");
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.out);
    expect(doc).toMatchObject({ ok: true, data: { dropped: ["review.maxDiffChars", "review.maxChunks", "tiers", "quota"], backedUp: false } });
    expect((await run("--bogus")).code).toBe(1);
  });

  it("notes a pi-chef workspaceDir that shepherd's default replaces", async () => {
    writeOld("workspaceDir: .pi-workflows\nmodels: { low: xai/grok-4.7 }\n");
    const result = await run();
    expect(result.out).toContain("workspaceDir is .pi-workflows");
    expect(readFileSync(newFile(), "utf8")).toContain("workspaceDir: .pi-workflows");
  });

  it("carries an older pi-chef file's tiers and local server over to models and local, on shepherd's template", async () => {
    writeOld(`# old pi-chef comments
localMode:
  difficulties: [low, medium]
providers:
  local:
    baseUrl: http://127.0.0.1:8081/v1
  anthropic:
    apiKeyFallback: true
tiers:
  local:
    - { provider: local, model: "Qwen3.8-27B", contextWindow: 131072 }
  ticketLow:
    - { provider: xai, model: "grok-4.7" }
  premium:
    - { provider: anthropic, model: claude-opus-5-5 }
`);
    const result = await run();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("Carried over from pi-chef's tiers: models.low: xai/grok-4.7, models.review: anthropic/claude-opus-5-5, local (from providers.local and tiers.local).");
    expect(result.out).toContain("shepherd has no local mode: to build them there always, set models.low: local/Qwen3.8-27B and models.medium: local/Qwen3.8-27B.");
    expect(result.out).toContain("commented template with those settings added at the end");
    const text = readFileSync(newFile(), "utf8");
    expect(text).not.toContain("old pi-chef comments");
    expect(text).not.toMatch(/^\{\}/m);
    expect(text).toContain("# budgets:");
    const config = loadConfig(home);
    expect(config.models).toMatchObject({ low: "xai/grok-4.7", review: "anthropic/claude-opus-5-5" });
    expect(config.local).toEqual({ baseUrl: "http://127.0.0.1:8081/v1", models: [{ id: "Qwen3.8-27B", contextWindow: 131072 }] });
  });

  it("keeps models the file already names over its tiers, and writes the template when nothing applies", async () => {
    writeOld("models: { medium: agent:claude }\ntiers:\n  ticketMedium: [{ provider: anthropic, model: claude-sonnet-5-5 }]\n  ticketHigh: [{ provider: openai, model: gpt-6.1-sol }]\n");
    const kept = await run();
    expect(kept.code, kept.err).toBe(0);
    expect(loadConfig(home).models).toMatchObject({ medium: "agent:claude", high: "openai/gpt-6.1-sol" });
    writeOld("tiers: { cheap: [] }\nreview: { maxChunks: 3 }\n");
    const empty = await run("--force");
    expect(empty.code, empty.err).toBe(0);
    expect(empty.out).toContain("Nothing in it applied to shepherd");
    expect(readFileSync(newFile(), "utf8")).toContain("# models:");
  });
});
