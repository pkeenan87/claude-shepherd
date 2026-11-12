/**
 * `shepherd migrate-config`: copies a pi-chef config (`~/.pi/agent/chef.yaml` or `.yml`) to `~/.claude/shepherd.yaml`.
 * Never overwrites: with a shepherd config already there it stops, unless `--force`, which first copies the old one to
 * `shepherd.yaml.bak` (a number is added when that exists). Keys shepherd does not read (Pi-main-only settings, and
 * `review.maxDiffChars`/`maxChunks` after phase 5) are removed with the YAML Document API, so the rest keeps its
 * comments, and are reported. The result is checked by the config loader before anything is written. Nothing is a secret
 * here: the loader rejects a file that holds one, and then nothing is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { displayPath, loadConfig, parseConfig, unknownKeys } from "../config.js";
import { done, fail } from "../orchestrator/context.js";
import type { CommandResult } from "../domain.js";
import { redact } from "../redact.js";
import { atomicWrite } from "../storage/store.js";

export const MIGRATE_USAGE = "Usage: shepherd migrate-config [--force] [--json]   (copies ~/.pi/agent/chef.yaml to ~/.claude/shepherd.yaml)";

function firstExisting(base: string): string | undefined {
  return [`${base}.yaml`, `${base}.yml`].find((file) => existsSync(file));
}

/** `<file>.bak`, else `.bak.2`, `.bak.3` …: an older backup is never replaced. */
function backupName(file: string): string {
  let candidate = `${file}.bak`;
  for (let n = 2; existsSync(candidate); n += 1) candidate = `${file}.bak.${n}`;
  return candidate;
}

/** `home` replaces the user's home directory (tests); `cwd` is where the final check looks for a project config. */
export function migrateConfig(options: { home?: string; cwd?: string; force?: boolean } = {}): CommandResult {
  const home = options.home ?? homedir();
  const shown = (file: string) => (file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);
  const source = firstExisting(path.join(home, ".pi", "agent", "chef"));
  if (!source) return fail("NO_SOURCE", `No pi-chef config found (looked for ${shown(path.join(home, ".pi", "agent", "chef.yaml"))} and chef.yml). Copy templates/shepherd.yaml to ~/.claude/shepherd.yaml instead.`);
  const existing = firstExisting(path.join(home, ".claude", "shepherd"));
  const dest = existing ?? path.join(home, ".claude", "shepherd.yaml");
  if (existing && !options.force) return fail("EXISTS", `${shown(existing)} already exists, so nothing was changed. Run \`shepherd migrate-config --force\` to replace it (the old file is kept as ${shown(backupName(existing))}).`);

  const doc = parseDocument(readFileSync(source, "utf8"));
  if (doc.errors.length > 0) return fail("BAD_YAML", `${shown(source)}: YAML could not be read (${doc.errors[0]!.message.split("\n")[0]}). Nothing was written.`);
  const raw = doc.toJS() as unknown;
  const dropped = raw && typeof raw === "object" && !Array.isArray(raw) ? unknownKeys(raw as Record<string, unknown>) : [];
  for (const key of dropped) doc.deleteIn(key.split("."));
  // A section left empty by the drops goes too (`review:` with nothing under it).
  for (const key of new Set(dropped.filter((name) => name.includes(".")).map((name) => name.split(".")[0]!))) {
    const section = doc.get(key, true) as { items?: unknown[] } | null;
    if (section && Array.isArray(section.items) && section.items.length === 0) doc.delete(key);
  }
  const text = doc.toString();

  let warnings: string[] = [];
  try {
    warnings = parseConfig(text, shown(dest)).warnings ?? [];
  } catch (error) {
    return fail("CONFIG_INVALID", `${shown(source)} does not make a valid shepherd config, so nothing was written: ${redact(error instanceof Error ? error.message : String(error))}`);
  }

  const lines: string[] = [];
  if (existing) {
    const backup = backupName(existing);
    atomicWrite(backup, readFileSync(existing, "utf8"));
    lines.push(`Backed up ${shown(existing)} to ${shown(backup)}.`);
  }
  atomicWrite(dest, text);
  lines.push(`Wrote ${shown(dest)} from ${shown(source)} (the pi-chef file is left where it is).`);
  lines.push(dropped.length > 0 ? `Dropped ${dropped.length} setting(s) shepherd does not read: ${dropped.join(", ")}.` : "Every setting is one shepherd reads; none were dropped.");
  const workspace = (raw as { workspaceDir?: unknown } | null)?.workspaceDir;
  if (typeof workspace === "string" && workspace !== ".shepherd") lines.push(`workspaceDir is ${workspace}; shepherd's default is .shepherd. Existing pi-chef tasks there are not picked up by name; remove the line to start fresh in .shepherd.`);

  // The check an ordinary run would make: the file as the loader layers it (home only when it is the real one).
  if (home === homedir()) {
    try {
      warnings = loadConfig(options.cwd ?? process.cwd()).warnings ?? warnings;
    } catch (error) {
      lines.push(`Note: the config loader now rejects ${displayPath(dest)} or a project file: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  }
  for (const warning of warnings) lines.push(`Note: ${warning}`);
  return done(lines.join("\n"), { source, dest, dropped, backedUp: !!existing });
}
