import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "..");
const script = path.join(repo, "scripts", "herdr-install.mjs");

/** Runs the installer against a throwaway herdr app home; the real ~/.config/herdr-app is never touched. */
function install(appHome: string, ...args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], { env: { ...process.env, HERDR_APP_HOME: appHome }, encoding: "utf8" });
}

describe("npm run herdr:install (the mod part)", () => {
  it("installs herdr/shepherd-config as mods/shepherd-config with an install.json naming the CLI, and installing again changes nothing", () => {
    const appHome = mkdtempSync(path.join(tmpdir(), "herdr-app-"));
    const out = install(appHome, "--no-dock");
    expect(out).toContain(`shepherd-config mod installed in ${path.join(appHome, "mods", "shepherd-config")}`);
    const mod = path.join(appHome, "mods", "shepherd-config");
    expect(readdirSync(mod).sort()).toEqual(["install.json", "lib.js", "main.js", "mod.json"]);
    expect(JSON.parse(readFileSync(path.join(mod, "mod.json"), "utf8"))).toEqual({ place: "right", size: 340 });
    const cli = JSON.parse(readFileSync(path.join(mod, "install.json"), "utf8")).cli as string[];
    expect(cli[0]).toBe("node");
    expect(cli[1]).toBe(path.join(repo, "bin", "shepherd-config.mjs"));
    expect(existsSync(cli[1]!)).toBe(true);
    const before = readFileSync(path.join(mod, "main.js"), "utf8");
    // Idempotent, and a file left from an older install is replaced, not kept.
    writeFileSync(path.join(mod, "gpui-kit.d.ts"), "old\n");
    install(appHome, "--no-dock");
    expect(readFileSync(path.join(mod, "main.js"), "utf8")).toBe(before);
    expect(existsSync(path.join(mod, "gpui-kit.d.ts"))).toBe(false);
    // The panel never names pi-chef's old mod.
    expect(existsSync(path.join(appHome, "mods", "chef-config"))).toBe(false);
  });

  it("refuses a bad --layout name", () => {
    const appHome = mkdtempSync(path.join(tmpdir(), "herdr-app-"));
    mkdirSync(appHome, { recursive: true });
    expect(() => install(appHome, "--layout", "../x")).toThrow(/--layout needs a layout name/);
  });
});
