/**
 * `shepherd herdr-install [--layout <name>] [--no-dock] [--remote]`: copies the herdr panel mod into the herdr app's mods folder, with
 * the bundled panel CLI next to it, and writes install.json naming that copy (the plugin's own folder moves on every
 * plugin update, so nothing may point into it). herdr applies a mod's mod.json "place" only the first time it sees the mod,
 * so an already-seen mod needs a column in a layout; herdr rewrites its shipped layouts (main, terminals, win98) on every
 * start, so the column goes in a layout of your own: "shepherd" (made from the layout in use) unless --layout names another.
 * `$HERDR_APP_HOME` overrides `~/.config/herdr-app`.
 *
 * `--remote` installs the panel CLI for a remote machine instead: it copies the bundled CLI to a stable folder under the
 * shepherd home (`$SHEPHERD_HOME`, default `~/.claude/shepherd`) and writes panel-cli.json naming it, so a herdr panel on
 * the other computer can run the CLI there. It touches no app home, mods or layouts.
 */
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shepherdHome } from "../shepherd-home.js";
import { atomicWrite } from "../storage/store.js";
import { dockLayoutFile } from "./herdr-layout.js";

export const HERDR_INSTALL_USAGE = "Usage: shepherd herdr-install [--layout <name>] [--no-dock] [--remote]";

export interface HerdrInstallOptions {
  /** Plugin root (holds herdr/ and dist/). Default: found from this file's location (dist/ or src/cli/). */
  root?: string;
  appHome?: string;
  /** The shepherd home (panel/ and panel-cli.json). Default: `$SHEPHERD_HOME` or `~/.claude/shepherd`. */
  shepherdHome?: string;
  /** Absolute path to the Node binary written into install.json / panel-cli.json. Default: `process.execPath`. */
  nodePath?: string;
}

const EDITOR_ONLY = ["gpui-kit.d.ts", "jsconfig.json"];
const CLI_FILE = "shepherd-config.mjs";

/** The plugin's version from `<root>/.claude-plugin/plugin.json`; undefined when missing or unreadable. Never throws. */
export function pluginVersion(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown };
    return typeof parsed?.version === "string" && parsed.version ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** The plugin root: the nearest folder above this file that holds herdr/shepherd-config (dist/shepherd.mjs -> ..). */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, "herdr", "shepherd-config"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** The Node binary and saved PATH written into install.json / panel-cli.json; captured so GUI apps can launch the CLI without a shell PATH. */
function nodeBin(options: HerdrInstallOptions): string {
  return options.nodePath || process.execPath || "node";
}

function savedPath(): string | undefined {
  return process.env.PATH && !process.env.PATH.includes("\n") ? process.env.PATH : undefined;
}

export function herdrInstall(args: string[], out: (text: string) => void, err: (text: string) => void, options: HerdrInstallOptions = {}): number {
  const root = options.root ?? findRoot();

  // Remote install: the panel CLI for another computer. It needs only the bundle; no app home, mods or layouts.
  if (args.includes("--remote")) {
    const bundle = path.join(root, "dist", CLI_FILE);
    if (!existsSync(bundle)) {
      err(`herdr-install: ${bundle} is missing; is this the plugin's folder?\n`);
      return 1;
    }
    const home = options.shepherdHome ?? shepherdHome();
    const panelDir = path.join(home, "panel");
    mkdirSync(panelDir, { recursive: true });
    const target = path.join(panelDir, CLI_FILE);
    copyFileSync(bundle, target);
    const plugin = pluginVersion(root);
    const saved = savedPath();
    atomicWrite(
      path.join(home, "panel-cli.json"),
      JSON.stringify(
        { version: 1, ...(plugin ? { plugin } : {}), cli: [nodeBin(options), target], ...(saved ? { path: saved } : {}) },
        null,
        2,
      ) + "\n",
    );
    out(`shepherd-config panel CLI installed in ${target}\n`);
    out(`A herdr panel on your other computer now finds it: ${path.join(home, "panel-cli.json")}\n`);
    return 0;
  }

  const layoutAt = args.indexOf("--layout");
  const layout = layoutAt >= 0 ? args[layoutAt + 1] : undefined;
  if (layoutAt >= 0 && (!layout || layout.startsWith("--") || !/^[\w.-]+$/.test(layout))) {
    err("herdr-install: --layout needs a layout name (the file in layouts/ without .json)\n");
    return 2;
  }
  const appHome = options.appHome ?? process.env.HERDR_APP_HOME ?? path.join(homedir(), ".config", "herdr-app");
  const source = path.join(root, "herdr", "shepherd-config");
  const bundle = path.join(root, "dist", CLI_FILE);
  for (const needed of [source, bundle]) {
    if (!existsSync(needed)) {
      err(`herdr-install: ${needed} is missing; is this the plugin's folder?\n`);
      return 1;
    }
  }
  const target = path.join(appHome, "mods", "shepherd-config");
  mkdirSync(target, { recursive: true });
  // The mod is a few files: copy them over a clean folder so a file removed from the plugin does not linger.
  // gpui-kit.d.ts and jsconfig.json are editor types for working on the mod; the installed mod does not need them.
  for (const name of ["main.js", "lib.js", "link.js", "edit.js", "mod.json", CLI_FILE, ...EDITOR_ONLY]) rmSync(path.join(target, name), { force: true });
  cpSync(source, target, { recursive: true, filter: (file) => !EDITOR_ONLY.includes(path.basename(file)) });
  copyFileSync(bundle, path.join(target, CLI_FILE));
  // Record the running Node binary (`process.execPath`) so GUI apps on macOS (launchd minimal PATH, nvm/fnm/mise/Homebrew)
  // can launch the panel CLI without relying on shell PATH; also save PATH so model discovery finds installed agent CLIs.
  const plugin = pluginVersion(root);
  const saved = savedPath();
  writeInstallJson(target, plugin, saved, nodeBin(options));
  out(`shepherd-config mod installed in ${target}\n`);
  const viewerSource = path.join(root, "herdr", "shepherd-viewer");
  if (existsSync(viewerSource)) {
    const viewerTarget = path.join(appHome, "mods", "shepherd-viewer");
    mkdirSync(viewerTarget, { recursive: true });
    for (const name of ["main.js", "mod.json", ...EDITOR_ONLY]) rmSync(path.join(viewerTarget, name), { force: true });
    cpSync(viewerSource, viewerTarget, { recursive: true, filter: (file) => !EDITOR_ONLY.includes(path.basename(file)) });
    out(`shepherd-viewer mod installed in ${viewerTarget}\n`);
  }
  if (!args.includes("--no-dock")) {
    for (const line of dockLayoutFile(appHome, layout ? { layout } : {}).lines) out(`${line}\n`);
  }
  return 0;
}

function writeInstallJson(target: string, plugin: string | undefined, saved: string | undefined, nodeBin: string): void {
  atomicWrite(
    path.join(target, "install.json"),
    JSON.stringify({ cli: [nodeBin, path.join(target, CLI_FILE)], ...(plugin ? { plugin } : {}), ...(saved ? { path: saved } : {}) }, null, 2) + "\n",
  );
}
