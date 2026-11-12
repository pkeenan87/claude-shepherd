import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigFileError, loadConfig } from "../src/config.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
});

const LOCAL = `local:
  baseUrl: "http://127.0.0.1:8081/v1"
  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]
`;

function home(yaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "shepherd.yaml"), yaml);
  process.env.HOME = dir;
  return dir;
}

const project = () => mkdtempSync(path.join(tmpdir(), "pi-proj-"));

describe("config errors are shown", () => {
  it("names the file a model error came from: the project's when it sets models, else the user's", () => {
    const fileOf = (user: string, projectYaml: string | undefined): string | undefined => {
      home(user);
      const dir = project();
      if (projectYaml !== undefined) {
        mkdirSync(path.join(dir, ".shepherd"), { recursive: true });
        writeFileSync(path.join(dir, ".shepherd", "config.yaml"), projectYaml);
      }
      try {
        loadConfig(dir);
      } catch (error) {
        return (error as { file?: string }).file;
      }
      return undefined;
    };
    // The project's models replace the user's whole section: an agent the user file does not define is the project file's problem.
    expect(fileOf("budgets: { taskUsd: 5 }\n", "models: { high: 'agent:nope' }\n")).toMatch(/\.shepherd\/config\.yaml$/);
    // A project file with no models section leaves the user's models in force: the error is the user file's.
    expect(fileOf("models: { high: 'agent:nope' }\n", "budgets: { taskUsd: 5 }\n")).toMatch(/\.claude\/shepherd\.yaml$/);
    expect(fileOf("models: { high: 'agent:nope' }\n", undefined)).toMatch(/\.claude\/shepherd\.yaml$/);
  });

  it("an invalid model rejects the file with an error that names the file and the key", () => {
    home("models: { high: 'not a ref' }\n");
    const error = (() => {
      try {
        loadConfig(project());
      } catch (caught) {
        return caught as ConfigFileError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigFileError);
    expect(error!.file).toMatch(/\.claude\/shepherd\.yaml$/);
    expect(error!.reason).toMatch(/models\.high is not valid/);
  });

  it("an unknown agent in models is a config error", () => {
    home("models: { high: 'agent:nope' }\n");
    expect(() => loadConfig(project())).toThrow(/unknown agent/);
  });

  it("a bad local section rejects the file", () => {
    home("local: { baseUrl: 'http://example.com/v1', models: [{ id: m, contextWindow: 8192 }] }\n");
    expect(() => loadConfig(project())).toThrow(/local\.baseUrl must be an https URL, or http only for localhost/);
    home("local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: m }] }\n");
    expect(() => loadConfig(project())).toThrow(/local\.models\[0\]\.contextWindow/);
  });

  it("a YAML error rejects the file and says why", () => {
    home("models: [unclosed\n");
    expect(() => loadConfig(project())).toThrow(/YAML could not be read/);
  });

  it("a secret rejects the whole file and is never shown", () => {
    home(`${LOCAL}apiKey: sk-abcdefghijklmnopqrstuvwxyz0123456789\n`);
    let message = "";
    try {
      loadConfig(project());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/contains a secret/);
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("accepts a Cursor model with a bracket suffix", () => {
    home("models: { medium: 'agent:cursor-agent/auto-smart[optimize_for=balanced]', review: 'agent:cursor-agent/auto' }\n");
    const config = loadConfig(project());
    expect(config.models.medium).toBe("agent:cursor-agent/auto-smart[optimize_for=balanced]");
    expect(config.models.review).toBe("agent:cursor-agent/auto");
  });
});

describe("old settings", () => {
  it("one warning lists every ignored key and points at the docs; the rest of the file still loads", () => {
    home("tiers: { cheap: [] }\nproviders: { foundry: {} }\nlocalMode: { default: true }\nquota: {}\napprovals: { merge: manual }\nrouting: { selection: adaptive, maxEscalations: 1 }\nbranchPrefix: kept\n");
    const config = loadConfig(project());
    expect(config.branchPrefix).toBe("kept");
    expect(config.routing.maxEscalations).toBe(1);
    const ignored = (config.warnings ?? []).filter((item) => item.startsWith("Ignored settings"));
    expect(ignored).toHaveLength(1);
    for (const key of ["tiers", "providers", "localMode", "quota", "approvals", "routing.selection"]) expect(ignored[0]).toContain(key);
    expect(ignored[0]).toContain("docs/configuration.md");
  });

  it("lists a key once even when both files carry it", () => {
    home("tiers: {}\n");
    const cwd = project();
    mkdirSync(path.join(cwd, ".shepherd"));
    writeFileSync(path.join(cwd, ".shepherd", "config.yaml"), "tiers: {}\nworkers: {}\n");
    const warning = (loadConfig(cwd).warnings ?? []).find((item) => item.startsWith("Ignored settings"))!;
    expect(warning).toBe("Ignored settings that are no longer used: tiers, workers. See docs/configuration.md for the current settings.");
  });

  it("review.maxDiffChars and review.maxChunks (the Pi extension's chat pass) are ignored with the others", () => {
    home("review: { tickets: false, maxDiffChars: 50000, maxChunks: 3, timeoutMs: 60000 }\n");
    const config = loadConfig(project());
    expect(config.review).toEqual({ model: true, tickets: false, timeoutMs: 60000 });
    const warning = (config.warnings ?? []).find((item) => item.startsWith("Ignored settings"))!;
    expect(warning).toContain("review.maxDiffChars, review.maxChunks");
  });

  it("an old cost-workflow.yaml is not read", () => {
    const dir = home("");
    writeFileSync(path.join(dir, ".claude", "cost-workflow.yaml"), "branchPrefix: old\n");
    expect(loadConfig(project()).branchPrefix).toBe("shepherd");
  });
});
