/**
 * `shepherd migrate-config`: copies a pi-chef config (`~/.pi/agent/chef.yaml` or `.yml`) to `~/.claude/shepherd.yaml`.
 * Never overwrites: with a shepherd config already there it stops, unless `--force`, which first copies the old one to
 * `shepherd.yaml.bak` (a number is added when that exists). Keys shepherd does not read (Pi-main-only settings, and
 * `review.maxDiffChars`/`maxChunks` after phase 5) are removed with the YAML Document API, so the rest keeps its
 * comments, and are reported. An older pi-chef file that routes with `tiers` and `providers.local` has its ticket tiers,
 * premium tier and local server carried over to `models` and `local` (see `fromTiers`); when nothing else is left, the
 * result starts from `templates/shepherd.yaml` so it carries shepherd's comments, not pi-chef's. The result is checked by the config loader before anything is written. Nothing is a secret
 * here: the loader rejects a file that holds one, and then nothing is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";
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

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => !!value && typeof value === "object" && !Array.isArray(value);

/** The pi-chef tier whose first candidate becomes each shepherd model. */
const TIER_MODELS = [["ticketLow", "low"], ["ticketMedium", "medium"], ["ticketHigh", "high"], ["premium", "review"]] as const;

/**
 * What an older pi-chef file's `tiers` and `providers.local` mean in shepherd: the first candidate of `ticketLow`,
 * `ticketMedium`, `ticketHigh` and `premium` as `models.low/medium/high/review` (only where `models` names none), and
 * `local` from `providers.local` (baseUrl, apiKeyEnv) with the `local` tier's local candidates (only when `local` is
 * unset). pi-chef's local mode (`localMode.difficulties`) has no shepherd switch, so it becomes a note, not a model.
 */
export function fromTiers(raw: Record_): { models: Record<string, string>; local?: Record_; notes: string[] } {
  const tiers = isRecord(raw.tiers) ? raw.tiers : {};
  const current = isRecord(raw.models) ? raw.models : {};
  const models: Record<string, string> = {};
  const notes: string[] = [];
  for (const [tier, key] of TIER_MODELS) {
    const first = Array.isArray(tiers[tier]) ? (tiers[tier] as unknown[])[0] : undefined;
    if (!isRecord(first) || typeof first.provider !== "string" || typeof first.model !== "string" || !first.provider || !first.model) continue;
    if (typeof current[key] === "string") continue;
    models[key] = `${first.provider}/${first.model}`;
  }
  let local: Record_ | undefined;
  const server = isRecord(raw.providers) && isRecord(raw.providers.local) ? raw.providers.local : undefined;
  const candidates = (Array.isArray(tiers.local) ? (tiers.local as unknown[]) : []).filter((item): item is Record_ => isRecord(item) && item.provider === "local" && typeof item.model === "string" && item.model !== "");
  if (raw.local === undefined && server && typeof server.baseUrl === "string" && candidates.length > 0) {
    local = {
      baseUrl: server.baseUrl,
      ...(typeof server.apiKeyEnv === "string" ? { apiKeyEnv: server.apiKeyEnv } : {}),
      // pi-chef told Pi 128000 when a tier entry set no window; shepherd needs it written down.
      models: candidates.map((item) => ({ id: item.model, contextWindow: typeof item.contextWindow === "number" ? item.contextWindow : 128000, ...(typeof item.maxTokens === "number" ? { maxTokens: item.maxTokens } : {}) })),
    };
  }
  const difficulties = isRecord(raw.localMode) && Array.isArray(raw.localMode.difficulties) ? raw.localMode.difficulties.filter((item): item is string => typeof item === "string") : [];
  if (difficulties.length > 0 && candidates.length > 0) {
    const ref = `local/${candidates[0]!.model as string}`;
    notes.push(`pi-chef's local mode sent ${difficulties.join(" and ")} tickets to ${ref} under /plan --local. shepherd has no local mode: to build them there always, set ${difficulties.map((item) => `models.${item}: ${ref}`).join(" and ")}.`);
  }
  return { models, ...(local ? { local } : {}), notes };
}

/** shepherd's commented user config, from the plugin root (`dist/shepherd.mjs` and `src/cli/` are below it). */
function templateText(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const file = path.join(dir, "templates", "shepherd.yaml");
    if (existsSync(file)) return readFileSync(file, "utf8");
    dir = path.dirname(dir);
  }
  return undefined;
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
  const kept = doc.toJS() as unknown;
  const legacy = raw && typeof raw === "object" && !Array.isArray(raw) ? fromTiers(raw as Record_) : { models: {}, notes: [] as string[] };
  const carried: string[] = [];
  for (const [key, ref] of Object.entries(legacy.models)) {
    doc.setIn(["models", key], ref);
    carried.push(`models.${key}: ${ref}`);
  }
  if (legacy.local) {
    doc.set("local", doc.createNode(legacy.local));
    carried.push("local (from providers.local and tiers.local)");
  }
  // Nothing of the pi-chef file is still read (only translated sections, or nothing, are left): start from shepherd's
  // commented template instead of keeping pi-chef's comments around an empty map.
  const template = !isRecord(kept) || Object.keys(kept).length === 0 ? templateText() : undefined;
  let text = doc.toString();
  if (template !== undefined) {
    const left = doc.toJS() as unknown;
    text = isRecord(left) && Object.keys(left).length > 0 ? `${template.trimEnd()}\n\n## Carried over from ${shown(source)}\n${stringify(left)}` : template;
  }

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
  if (carried.length > 0) lines.push(`Carried over from pi-chef's tiers: ${carried.join(", ")}.`);
  if (template !== undefined) lines.push(carried.length > 0 ? "Nothing else applied to shepherd, so the file is shepherd's commented template with those settings added at the end." : "Nothing in it applied to shepherd, so the file is shepherd's commented template: the built-in defaults apply.");
  for (const note of legacy.notes) lines.push(`Note: ${note}`);
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
