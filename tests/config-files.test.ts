import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPaths, loadConfig } from "../src/config.js";

describe("config file names", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(project, ".shepherd"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });
  const user = (name: string, yaml: string) => writeFileSync(path.join(home, ".claude", name), yaml);
  const proj = (name: string, yaml: string) => writeFileSync(path.join(project, ".shepherd", name), yaml);

  it("picks up shepherd.yml", () => {
    user("shepherd.yml", "branchPrefix: fromyml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("fromyml");
    expect(configPaths(project).userPath).toBe(path.join(home, ".claude", "shepherd.yml"));
  });

  it("prefers shepherd.yaml over shepherd.yml and warns which file is ignored", () => {
    user("shepherd.yaml", "branchPrefix: fromyaml\n");
    user("shepherd.yml", "branchPrefix: fromyml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("fromyaml");
    expect(config.warnings?.join("\n")).toContain("~/.claude/shepherd.yml is ignored because ~/.claude/shepherd.yaml exists");
  });

  it("picks up the project config.yml, and prefers config.yaml with a warning", () => {
    proj("config.yml", "branchPrefix: projyml\n");
    expect(loadConfig(project).branchPrefix).toBe("projyml");
    proj("config.yaml", "branchPrefix: projyaml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("projyaml");
    expect(config.warnings?.join("\n")).toMatch(/config\.yml is ignored because .*config\.yaml exists/);
  });

  it("no longer reads the legacy cost-workflow.yaml", () => {
    user("cost-workflow.yml", "branchPrefix: legacyyml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("shepherd");
    expect(config.warnings ?? []).toEqual([]);
  });

  it("watches every candidate file so the cache follows whichever one is used", () => {
    const { watch } = configPaths(project);
    for (const name of ["shepherd.yaml", "shepherd.yml", "config.yaml", "config.yml"]) {
      expect(watch.some((file) => path.basename(file) === name)).toBe(true);
    }
    expect(watch.some((file) => path.basename(file).startsWith("cost-workflow"))).toBe(false);
  });
});
