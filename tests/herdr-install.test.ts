import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/shepherd.js";
import { herdrInstall } from "../src/cli/herdr-install.js";

const repo = path.resolve(__dirname, "..");

/** Runs `shepherd herdr-install` against a throwaway herdr app home; the real ~/.config/herdr-app is never touched. */
async function install(appHome: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const prior = process.env.HERDR_APP_HOME;
  process.env.HERDR_APP_HOME = appHome;
  try {
    const code = await main(["herdr-install", ...args], { out: (t) => (out += t), err: (t) => (err += t) });
    return { code, out, err };
  } finally {
    if (prior === undefined) delete process.env.HERDR_APP_HOME;
    else process.env.HERDR_APP_HOME = prior;
  }
}

describe("shepherd herdr-install", () => {
  let appHome: string;
  beforeEach(() => {
    appHome = mkdtempSync(path.join(tmpdir(), "herdr-app-"));
  });
  afterEach(() => {
    delete process.env.HERDR_APP_HOME;
  });

  it("copies the mod and the bundled CLI into mods/shepherd-config, points install.json inside it, and is idempotent", async () => {
    const mod = path.join(appHome, "mods", "shepherd-config");
    const { code, out } = await install(appHome, "--no-dock");
    expect(code).toBe(0);
    expect(out).toContain(`shepherd-config mod installed in ${mod}`);
    expect(readdirSync(mod).sort()).toEqual(["install.json", "lib.js", "link.js", "main.js", "mod.json", "shepherd-config.mjs"]);
    expect(JSON.parse(readFileSync(path.join(mod, "mod.json"), "utf8"))).toMatchObject({ place: "right", size: 360, focusable: true });
    expect(existsSync(path.join(appHome, "mods", "shepherd-viewer", "main.js"))).toBe(true);
    const installed = JSON.parse(readFileSync(path.join(mod, "install.json"), "utf8")) as { cli: string[]; path?: string };
    const cli = installed.cli;
    expect(cli).toEqual([process.execPath, path.join(mod, "shepherd-config.mjs")]);
    if (process.env.PATH) expect(installed.path).toBe(process.env.PATH);
    expect(readFileSync(cli[1]!, "utf8")).toBe(readFileSync(path.join(repo, "dist", "shepherd-config.mjs"), "utf8"));
    expect(existsSync(path.join(appHome, "layouts"))).toBe(false);
    const before = readFileSync(path.join(mod, "main.js"), "utf8");
    // A file left from an older install is replaced, not kept.
    writeFileSync(path.join(mod, "gpui-kit.d.ts"), "old\n");
    expect((await install(appHome, "--no-dock")).code).toBe(0);
    expect(readFileSync(path.join(mod, "main.js"), "utf8")).toBe(before);
    expect(existsSync(path.join(mod, "gpui-kit.d.ts"))).toBe(false);
    expect(existsSync(path.join(appHome, "mods", "chef-config"))).toBe(false);
  });

  it("docks the panel in a layout of its own unless --no-dock", async () => {
    mkdirSync(path.join(appHome, "layouts"), { recursive: true });
    writeFileSync(path.join(appHome, "layouts", "main.json"), JSON.stringify({ id: "root", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }] }));
    const { code, out } = await install(appHome);
    expect(code).toBe(0);
    expect(out).toContain("shepherd layout");
    const layout = JSON.parse(readFileSync(path.join(appHome, "layouts", "shepherd.json"), "utf8"));
    expect(layout.children.at(-1).content).toEqual({ mod: "shepherd-config" });
    expect(readFileSync(path.join(appHome, "layouts", "main.json"), "utf8")).not.toContain("shepherd-config");
  });

  it("refuses a bad --layout name", async () => {
    const { code, err } = await install(appHome, "--layout", "../x");
    expect(code).toBe(2);
    expect(err).toMatch(/--layout needs a layout name/);
  });
});

describe("shepherd herdr-install --remote", () => {
  let shepherd: string;
  beforeEach(() => {
    shepherd = mkdtempSync(path.join(tmpdir(), "shepherd-remote-"));
  });

  function run(args: string[], opts: { root?: string; shepherdHome?: string } = {}): { code: number; out: string; err: string } {
    let out = "";
    let err = "";
    const code = herdrInstall(args, (t) => (out += t), (t) => (err += t), { root: repo, shepherdHome: shepherd, ...opts });
    return { code, out, err };
  }

  it("copies the CLI into the shepherd home and writes panel-cli.json, with no app home", () => {
    const { code, out } = run(["--remote"]);
    expect(code).toBe(0);
    expect(out).toContain("panel-cli.json");
    expect(existsSync(path.join(shepherd, "panel", "shepherd-config.mjs"))).toBe(true);
    const descriptor = JSON.parse(readFileSync(path.join(shepherd, "panel-cli.json"), "utf8")) as {
      version: number;
      plugin?: string;
      cli: string[];
      path?: string;
    };
    const pluginJson = JSON.parse(readFileSync(path.join(repo, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(descriptor.version).toBe(1);
    expect(descriptor.plugin).toBe(pluginJson.version);
    expect(descriptor.cli).toHaveLength(2);
    for (const entry of descriptor.cli) expect(path.isAbsolute(entry)).toBe(true);
    expect(descriptor.cli[1]).toBe(path.join(shepherd, "panel", "shepherd-config.mjs"));
    if (process.env.PATH) expect(descriptor.path).toBe(process.env.PATH);
    // The copied bundle runs on its own and prints JSON.
    const cwd = mkdtempSync(path.join(tmpdir(), "shepherd-remote-cwd-"));
    const json = execFileSync(process.execPath, [descriptor.cli[1]!, "show", "--cwd", cwd], { cwd, encoding: "utf8", timeout: 20000 });
    expect(() => JSON.parse(json)).not.toThrow();
    // Idempotent: a second run over the same home is fine.
    expect(run(["--remote"]).code).toBe(0);
    // No app home is touched.
    expect(existsSync(path.join(shepherd, "mods"))).toBe(false);
    expect(existsSync(path.join(shepherd, "layouts"))).toBe(false);
  });

  it("fails with exit 1 when the dist bundle is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "shepherd-remote-root-"));
    const { code, err } = run(["--remote"], { root });
    expect(code).toBe(1);
    expect(err).toMatch(/dist[\\/]shepherd-config\.mjs is missing/);
  });
});

describe("normal herdr-install", () => {
  it("records the plugin version in install.json", async () => {
    const appHome = mkdtempSync(path.join(tmpdir(), "herdr-app-"));
    const { code } = await install(appHome, "--no-dock");
    expect(code).toBe(0);
    const installed = JSON.parse(readFileSync(path.join(appHome, "mods", "shepherd-config", "install.json"), "utf8")) as { plugin?: string };
    const pluginJson = JSON.parse(readFileSync(path.join(repo, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(installed.plugin).toBe(pluginJson.version);
  });
});

describe("bundles run without node_modules", () => {
  it("dist/shepherd-config.mjs and dist/shepherd.mjs run from a copy of dist/ alone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shepherd-dist-"));
    cpSync(path.join(repo, "dist"), path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), readFileSync(path.join(repo, "package.json")));
    const env = { ...process.env, HOME: dir };
    const version = execFileSync(process.execPath, [path.join(dir, "dist", "shepherd.mjs"), "version"], { cwd: dir, env, encoding: "utf8" });
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const json = execFileSync(process.execPath, [path.join(dir, "dist", "shepherd-config.mjs"), "show", "--cwd", dir], { cwd: dir, env, encoding: "utf8", timeout: 20000 });
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
