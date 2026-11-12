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
});
