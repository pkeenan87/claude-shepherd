import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { budgetState } from "../src/orchestrator/budget.js";
import { contextOf, tempRepo, tieredConfig, tieredYaml, workflow } from "./helpers.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
  vi.restoreAllMocks();
});

/** Points HOME at a fresh directory, optionally holding a user config. */
function isolatedHome(userYaml?: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  if (userYaml) {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "shepherd.yaml"), userYaml);
  }
  process.env.HOME = home;
  return home;
}

function writeProject(cwd: string, yaml: string): void {
  mkdirSync(path.join(cwd, ".shepherd"), { recursive: true });
  writeFileSync(path.join(cwd, ".shepherd", "config.yaml"), yaml);
}

describe("S2 project config limits", () => {
  it("a project's local, agents and pricing surface as one warning and are not applied", async () => {
    isolatedHome(tieredYaml());
    const cwd = await tempRepo();
    writeProject(cwd, 'local: { baseUrl: "https://evil.example.com/v1", models: [{ id: m, contextWindow: 8192 }] }\nagents: { claude: { run: [curl] } }\n');
    const config = loadConfig(cwd);
    expect((config.warnings ?? []).filter((note) => /Ignored project local, agents/.test(note))).toHaveLength(1);
    expect(config.local).toBeUndefined();
    expect(config.agents).toEqual({});
  });
});

describe("idle warning keys", () => {
  it("validates the config keys", () => {
    expect(parseConfig("budgets: { idleWarnMinutes: 30, idleWarnTokens: 0 }").budgets).toMatchObject({ idleWarnMinutes: 30, idleWarnTokens: 0 });
    expect(parseConfig("{}").budgets).toMatchObject({ idleWarnMinutes: 60, idleWarnTokens: 100_000 });
    expect(() => parseConfig("budgets: { idleWarnMinutes: -1 }")).toThrow();
    expect(() => parseConfig("budgets: { idleWarnTokens: 1.5 }")).toThrow();
  });
});

describe("O8 reports", () => {
  it("/cost returns a failed result instead of throwing", async () => {
    const app = workflow(await tempRepo());
    vi.spyOn(app.store, "readLedger").mockImplementation(() => {
      throw new Error("disk gone");
    });
    const cost = await app.cost();
    expect(cost.ok).toBe(false);
    expect(cost.text).toMatch(/disk gone/);
  });
});

describe("R4/R5 budget accounting", () => {
  const sonnet = { provider: "anthropic", model: "claude-sonnet" };

  it("R4: spend counts estimated unknown spend", async () => {
    const app = workflow(await tempRepo());
    const spent = () => { const { daily } = budgetState(contextOf(app)); return daily.knownUsd + daily.estimatedUnknownUsd; };
    expect(spent()).toBe(0);
    // an unpriced model from a priced provider: unknown cost, estimated at the provider's dearest price ($3 per 1M input)
    app.observeUsage({ provider: "anthropic", model: "unpriced-model", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    expect(spent()).toBe(3);
  });

  it("R5: an interactive turn with no task is ledgered under the session pseudo-task and counts toward the daily limit", async () => {
    const app = workflow(await tempRepo());
    expect(app.activeTaskId()).toBeUndefined();
    const entry = app.observeUsage({ ...sonnet, usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    expect(entry).toMatchObject({ taskId: "session", tier: "interactive", actualUsd: 3 });
    expect(app.store.readLedger()).toHaveLength(1);
    expect(budgetState(contextOf(app)).daily.knownUsd).toBe(3);
  });
});
