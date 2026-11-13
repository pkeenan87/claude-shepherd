/**
 * `shepherd statusline-install`: shows shepherd's spend in Claude Code's status line, the way pi-chef's footer did.
 *
 * A plugin cannot set the status line, so this writes `statusLine` into the user's `~/.claude/settings.json`. The
 * plugin's own folder moves on every version, so the setting runs a small launcher, `<shepherd home>/statusline.sh`,
 * and every prompt hook rewrites that launcher to point at the plugin version that is running (`refreshStatusLine`).
 * An existing status line that is not shepherd's is never replaced without `--force`; the old settings are kept in
 * `settings.json.shepherd.bak`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { done, fail } from "../orchestrator/context.js";
import type { CommandResult } from "../domain.js";

export const STATUSLINE_USAGE = `Usage: shepherd statusline-install [--force]
Shows "shepherd · <plan> · plan $spent/$budget · today $spent/$budget" in Claude Code's status line by setting
statusLine in ~/.claude/settings.json. --force replaces a status line you already have (a backup is kept).`;

export const LAUNCHER = "statusline.sh";

export function launcherText(entry: string): string {
  return `#!/bin/sh\n# Written by shepherd: runs the installed plugin's status command. Rewritten on every prompt.\nexec node '${entry.replace(/'/g, "'\\''")}' status --statusline\n`;
}

function writeAtomic(file: string, text: string, mode?: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  renameSync(temp, file);
}

/** Points the launcher at `entry` if the launcher exists and points elsewhere. Never throws. */
export function refreshStatusLine(shepherd: string, entry: string): void {
  try {
    const file = path.join(shepherd, LAUNCHER);
    if (!existsSync(file)) return;
    const text = launcherText(entry);
    if (readFileSync(file, "utf8") !== text) writeAtomic(file, text, 0o755);
  } catch {
    // The status line is a convenience; a hook must not fail over it.
  }
}

export interface StatusLineInstall {
  /** The user's home (settings are `<home>/.claude/settings.json`). */
  home: string;
  /** The shepherd home the launcher goes in. */
  shepherd: string;
  /** The running bundle (`dist/shepherd.mjs`). */
  entry: string;
  force?: boolean;
}

export function installStatusLine({ home, shepherd, entry, force = false }: StatusLineInstall): CommandResult {
  const settingsFile = path.join(home, ".claude", "settings.json");
  const launcher = path.join(shepherd, LAUNCHER);
  const command = `sh '${launcher.replace(/'/g, "'\\''")}'`;
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("SETTINGS", `${settingsFile} is not a JSON object; left it alone.`);
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      return fail("SETTINGS", `Cannot read ${settingsFile} (${(error as Error).message.split("\n")[0]}); left it alone.`);
    }
  }
  const current = settings.statusLine as { command?: unknown } | undefined;
  const ours = !!current && typeof current.command === "string" && current.command.includes(LAUNCHER);
  if (current && !ours && !force) {
    return fail("STATUSLINE_SET", `You already have a status line (${JSON.stringify(current)}). Run \`shepherd statusline-install --force\` to replace it with shepherd's; your settings are backed up first.`);
  }
  mkdirSync(shepherd, { recursive: true });
  writeAtomic(launcher, launcherText(entry), 0o755);
  if (!ours) {
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.shepherd.bak`);
    writeAtomic(settingsFile, `${JSON.stringify({ ...settings, statusLine: { type: "command", command, padding: 0 } }, null, 2)}\n`);
  }
  return done(`${ours ? "The status line was already shepherd's; refreshed its launcher" : `Set statusLine in ${settingsFile}`}. It shows the active plan, what it has spent and today's spend. It appears after the next message.`, { settings: settingsFile, launcher });
}
