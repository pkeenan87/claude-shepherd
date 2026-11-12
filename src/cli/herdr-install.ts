/**
 * `shepherd herdr-install [--layout <name>] [--no-dock]`: copies the herdr panel mod into the herdr app's mods folder, with
 * the bundled panel CLI next to it, and writes install.json naming that copy (the plugin's own folder moves on every
 * plugin update, so nothing may point into it). herdr applies a mod's mod.json "place" only the first time it sees the mod,
 * so an already-seen mod needs a column in a layout; herdr rewrites its shipped layouts (main, terminals, win98) on every
 * start, so the column goes in a layout of your own: "shepherd" (made from the layout in use) unless --layout names another.
 * `$HERDR_APP_HOME` overrides `~/.config/herdr-app`.
 */
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockLayoutFile } from "./herdr-layout.js";

export const HERDR_INSTALL_USAGE = "Usage: shepherd herdr-install [--layout <name>] [--no-dock]";

export interface HerdrInstallOptions {
  /** Plugin root (holds herdr/ and dist/). Default: found from this file's location (dist/ or src/cli/). */
  root?: string;
  appHome?: string;
}

const EDITOR_ONLY = ["gpui-kit.d.ts", "jsconfig.json"];
const CLI_FILE = "shepherd-config.mjs";

/** The plugin root: the nearest folder above this file that holds herdr/shepherd-config (dist/shepherd.mjs -> ..). */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, "herdr", "shepherd-config"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function herdrInstall(args: string[], out: (text: string) => void, err: (text: string) => void, options: HerdrInstallOptions = {}): number {
  const layoutAt = args.indexOf("--layout");
  const layout = layoutAt >= 0 ? args[layoutAt + 1] : undefined;
  if (layoutAt >= 0 && (!layout || layout.startsWith("--") || !/^[\w.-]+$/.test(layout))) {
    err("herdr-install: --layout needs a layout name (the file in layouts/ without .json)\n");
    return 2;
  }
  const root = options.root ?? findRoot();
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
  for (const name of ["main.js", "lib.js", "edit.js", "mod.json", CLI_FILE, ...EDITOR_ONLY]) rmSync(path.join(target, name), { force: true });
  cpSync(source, target, { recursive: true, filter: (file) => !EDITOR_ONLY.includes(path.basename(file)) });
  copyFileSync(bundle, path.join(target, CLI_FILE));
  writeFileSync(path.join(target, "install.json"), JSON.stringify({ cli: ["node", path.join(target, CLI_FILE)] }, null, 2) + "\n");
  out(`shepherd-config mod installed in ${target}\n`);
  if (!args.includes("--no-dock")) {
    for (const line of dockLayoutFile(appHome, layout ? { layout } : {}).lines) out(`${line}\n`);
  }
  return 0;
}
