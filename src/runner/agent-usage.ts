/**
 * Metering for external agents: what an agent spent on a ticket (or a review), read from the agent's own session log
 * instead of a provider response. The meter snapshots the log directory before the agent's tab opens (file -> size and
 * mtime); `collect()` reads only the files that are new or have grown since, and returns what is new since the last
 * `collect()`, so a retry `send` ledgers just its own turn. Nothing here runs a process or touches the ledger.
 *
 * - Claude Code: `~/.claude/projects/<cwd slug>/**.jsonl` (the slug is the repo path with every character outside
 *   A-Z a-z 0-9 replaced by "-", which is how `.` in `/home/me/.codex` becomes `--codex`; sub-agent logs sit in
 *   `<session>/subagents/`). Lines of `type: "assistant"` carry `message.id`, `message.model` and `message.usage`; one
 *   message repeats on a line per content block, so each `message.id` counts once (the largest value seen per field,
 *   since a streamed message may be written more than once).
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The first line is `session_meta` with `payload.cwd` (a
 *   session of another directory is skipped). `event_msg` lines with `payload.type: "token_count"` hold the session's
 *   running `total_token_usage`; the spend is the last total minus the last total at the snapshot. `input_tokens`
 *   includes `cached_input_tokens`, and `output_tokens` already includes the reasoning tokens.
 * - Every other agent has no reader (`createAgentMeter` returns undefined): the caller ledgers one "not metered" row.
 *
 * Both formats were read off files on this machine (2026-11-08); they are the agents' internal logs, not a documented API.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TokenUsage } from "../domain.js";
import { inferProviderForModel } from "../pricing-defaults.js";

/** Usage of one model since the last `collect()`. `provider` is the pricing provider (`anthropic`, `openai`, `google`, `xai`, `cursor`). */
export interface AgentCall {
  provider: string;
  model: string;
  usage: TokenUsage;
  /** True when Cursor routed to a first-party Cursor subscription pool model (Composer / Cursor-hosted Grok). */
  firstPartyCursor?: boolean;
}

/** What the ledger records for an agent: metered calls, or the single "not metered" row of an agent with no reader. */
export interface AgentLedgerEntry {
  agent: string;
  meter: "agent-log" | "not-metered";
  provider: string;
  model: string;
  usage: TokenUsage;
  firstPartyCursor?: boolean;
}

export interface AgentMeter {
  /** Usage that appeared in the agent's log since the snapshot or the previous `collect()`. Never throws. */
  collect(): AgentCall[];
}

export interface AgentMeterOptions {
  /** The repo the agent runs in (its log is found by this path). */
  cwd: string;
  /** Replaces the home directory the logs are looked for under (tests). */
  home?: string;
  /** Called with a log file and the byte offset `collect()` has read it to (the repo's agent-log watermark follows it). */
  onConsumed?: (file: string, offset: number) => void;
  /** Files never read: the main session's own transcripts, which grow while a tab runs. */
  exclude?: (file: string) => boolean;
  /** Per-run JSONL log written by shepherd's Cursor stop hook (`SHEPHERD_CURSOR_USAGE_LOG`). */
  cursorUsageFile?: string;
}

/** The agents that have a reader, with the provider their usage is priced under. */
const READERS: Record<string, "claude" | "codex" | "cursor" | "gemini"> = {
  claude: "claude",
  codex: "codex",
  "cursor-agent": "cursor",
  gemini: "gemini",
  agy: "gemini",
};
const PRICING_PROVIDER = { claude: "anthropic", codex: "openai", gemini: "google" } as const;

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

interface Found {
  provider: string;
  model: string;
  totals: Totals;
  firstPartyCursor?: boolean;
}

type Snapshot = Map<string, number>;

const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Claude Code's project directory name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The path and its real path (symlinks resolved), without repeats. */
function pathForms(cwd: string): string[] {
  const forms = new Set([path.resolve(cwd)]);
  try {
    forms.add(realpathSync(cwd));
  } catch {
    /* a path that does not exist has only its own form */
  }
  return [...forms];
}

/** Every `.jsonl` file under `dir` (at most `depth` levels down) with its size. A missing dir is no files. */
function jsonlFiles(dir: string, accept: (name: string) => boolean, depth: number, out: Snapshot = new Map()): Snapshot {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) jsonlFiles(full, accept, depth - 1, out);
    } else if (entry.isFile() && accept(entry.name)) {
      try {
        out.set(full, statSync(full).size);
      } catch {
        /* gone since the listing */
      }
    }
  }
  return out;
}

/** Lines of a JSONL file with the byte offset each starts at. A half-written last line fails to parse and is skipped by the caller. */
function* lines(buffer: Buffer): Generator<{ start: number; value: unknown }> {
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(10, start);
    if (end < 0) end = buffer.length;
    const text = buffer.toString("utf8", start, end).trim();
    if (text) {
      try {
        yield { start, value: JSON.parse(text) };
      } catch {
        /* a half-written line, or not JSON */
      }
    }
    start = end + 1;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Whether a line is already accounted for: it takes the line's start offset and its parsed value. */
type Before = (start: number, value: Record<string, unknown>) => boolean;

/**
 * Claude Code messages in a file after the `before` boundary, by message id. When a streamed message straddles an
 * offset boundary (partial line before `before`, final line after), only the positive token delta past what was seen
 * before the boundary is returned so tokens are neither double-counted nor dropped.
 */
function claudeMessages(buffer: Buffer, before: Before): Map<string, Found> {
  const earlierMax = new Map<string, Totals>();
  const afterMax = new Map<string, Found>();
  const maxTotals = (a: Totals, b: Totals): Totals => ({
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    requests: 1,
  });
  for (const { start, value } of lines(buffer)) {
    if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message)) continue;
    const message = value.message;
    if (message.model === "<synthetic>") continue;
    const id = typeof message.id === "string" ? message.id : undefined;
    if (!id) continue;
    const usage = isRecord(message.usage) ? message.usage : {};
    const totals: Totals = { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens), requests: 1 };
    if (before(start, value)) {
      const prev = earlierMax.get(id);
      earlierMax.set(id, prev ? maxTotals(prev, totals) : totals);
      continue;
    }
    const model = typeof message.model === "string" && message.model ? message.model : "unknown";
    const seen = afterMax.get(id);
    if (!seen) afterMax.set(id, { provider: PRICING_PROVIDER.claude, model, totals });
    else afterMax.set(id, { provider: seen.provider, model: seen.model === "unknown" ? model : seen.model, totals: maxTotals(seen.totals, totals) });
  }
  const found = new Map<string, Found>();
  for (const [id, item] of afterMax) {
    const prev = earlierMax.get(id);
    if (!prev) {
      found.set(id, item);
      continue;
    }
    const delta: Totals = {
      input: Math.max(0, item.totals.input - prev.input),
      output: Math.max(0, item.totals.output - prev.output),
      cacheRead: Math.max(0, item.totals.cacheRead - prev.cacheRead),
      cacheWrite: Math.max(0, item.totals.cacheWrite - prev.cacheWrite),
      requests: 0,
    };
    if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite > 0) {
      found.set(id, { provider: item.provider, model: item.model, totals: delta });
    }
  }
  return found;
}

/** A Codex rollout's spend after the lines that are `before`: the last running total minus the one at the boundary. Undefined for another directory's session. */
function codexSession(buffer: Buffer, before: Before, repos: string[]): Found | undefined {
  let cwd: string | undefined;
  let model: string | undefined;
  let base: Totals = ZERO;
  let last: Totals = ZERO;
  let requests = 0;
  for (const { start, value } of lines(buffer)) {
    if (!isRecord(value)) continue;
    const payload = isRecord(value.payload) ? value.payload : {};
    if (value.type === "session_meta" && cwd === undefined && typeof payload.cwd === "string") cwd = payload.cwd;
    else if (value.type === "turn_context" && typeof payload.model === "string" && payload.model) model = payload.model;
    else if (value.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info) && isRecord(payload.info.total_token_usage)) {
      const total = payload.info.total_token_usage;
      const cached = num(total.cached_input_tokens);
      const now: Totals = { input: Math.max(0, num(total.input_tokens) - cached), output: num(total.output_tokens), cacheRead: cached, cacheWrite: 0, requests: 0 };
      if (before(start, value)) base = now;
      else if (now.input !== last.input || now.output !== last.output || now.cacheRead !== last.cacheRead) requests += 1;
      last = now;
    }
  }
  if (cwd === undefined || !repos.some((repo) => samePath(repo, cwd!))) return undefined;
  const totals: Totals = { input: Math.max(0, last.input - base.input), output: Math.max(0, last.output - base.output), cacheRead: Math.max(0, last.cacheRead - base.cacheRead), cacheWrite: 0, requests };
  return { provider: PRICING_PROVIDER.codex, model: model ?? "unknown", totals };
}

function samePath(repo: string, cwd: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const a = norm(repo);
  const b = norm(cwd);
  return b === a || b.startsWith(a + path.sep);
}

/** Parses Cursor stop-hook JSONL payloads (`SHEPHERD_CURSOR_USAGE_LOG`) into per-generation usage rows. */
function cursorStopEvents(buffer: Buffer, before: Before): Map<string, Found> {
  const found = new Map<string, Found>();
  let seq = 0;
  for (const { start, value } of lines(buffer)) {
    seq += 1;
    if (!isRecord(value) || before(start, value)) continue;
    const rawModel = typeof value.model_id === "string" && value.model_id ? value.model_id : typeof value.model === "string" && value.model ? value.model : "";
    const input = num(value.input_tokens);
    const output = num(value.output_tokens);
    const cacheRead = num(value.cache_read_tokens);
    const cacheWrite = num(value.cache_write_tokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const inferred = inferProviderForModel(rawModel || "unknown");
    const id = typeof value.generation_id === "string" && value.generation_id ? value.generation_id : `cursor-${start}-${seq}`;
    found.set(id, {
      provider: inferred.provider,
      model: inferred.model,
      totals: { input, output, cacheRead, cacheWrite, requests: 1 },
      firstPartyCursor: inferred.firstPartyCursor,
    });
  }
  return found;
}

/** Checks whether a Gemini/AGY log under `~/.gemini/tmp/<project>/...` belongs to one of `repos`. */
function geminiLogMatchesRepo(file: string, buffer: Buffer, tmpRoot: string, repos: string[]): boolean {
  const rel = path.relative(tmpRoot, file);
  const topDir = rel && !rel.startsWith("..") ? rel.split(path.sep)[0] : undefined;
  if (topDir) {
    const projectDir = path.join(tmpRoot, topDir);
    // 1. Gemini CLI writes `.project_root` containing the repo path.
    const marker = path.join(projectDir, ".project_root");
    if (existsSync(marker)) {
      try {
        const root = readFileSync(marker, "utf8").trim();
        if (root) return repos.some((repo) => samePath(repo, root));
      } catch {
        /* fall through */
      }
    }
    // 2. Gemini CLI project directory hashes are sha256(repoPath).
    const hashes = new Set(repos.map((r) => createHash("sha256").update(r).digest("hex")));
    if (hashes.has(topDir.toLowerCase())) return true;
  }
  // 3. Fall back to cwd/projectRoot/workspace metadata inside the JSONL session itself.
  for (const { value } of lines(buffer)) {
    if (!isRecord(value)) continue;
    for (const key of ["cwd", "projectRoot", "workspace", "repoRoot"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate) {
        return repos.some((repo) => samePath(repo, candidate));
      }
    }
  }
  return false;
}

/** Best-effort reader for Gemini / Antigravity CLI chat JSONL logs (`~/.gemini/tmp/<hash>/chats/*.jsonl`). Skips sessions belonging to other repos. */
function geminiChatEvents(file: string, buffer: Buffer, before: Before, tmpRoot: string, repos: string[]): Map<string, Found> {
  const found = new Map<string, Found>();
  if (!geminiLogMatchesRepo(file, buffer, tmpRoot, repos)) return found;
  let seq = 0;
  for (const { start, value } of lines(buffer)) {
    seq += 1;
    if (!isRecord(value) || before(start, value)) continue;
    const usage = isRecord(value.tokens) ? value.tokens : isRecord(value.usage) ? value.usage : undefined;
    if (!usage) continue;
    const input = num(usage.input_tokens ?? usage.input ?? usage.promptTokenCount);
    const output = num(usage.output_tokens ?? usage.output ?? usage.candidatesTokenCount) + num(usage.thinking_tokens ?? usage.thoughts ?? usage.thoughtsTokenCount);
    const cacheRead = num(usage.cache_read_tokens ?? usage.cached ?? usage.cachedContentTokenCount);
    if (input + output + cacheRead === 0) continue;
    const rawModel = typeof value.model === "string" && value.model ? value.model : "gemini-4-neon";
    const id = typeof value.id === "string" && value.id ? value.id : `gemini-${start}-${seq}`;
    found.set(id, {
      provider: PRICING_PROVIDER.gemini,
      model: rawModel,
      totals: { input, output, cacheRead, cacheWrite: 0, requests: 1 },
    });
  }
  return found;
}

/** The agent's log files for the repo (its path forms `repos`) with their sizes; a missing directory is no files. */
export function listAgentLogs(reader: "claude" | "codex", home: string, repos: string[]): Snapshot {
  if (reader === "claude") {
    const out: Snapshot = new Map();
    for (const repo of repos) jsonlFiles(path.join(home, ".claude", "projects", claudeProjectSlug(repo)), (name) => name.endsWith(".jsonl"), 3, out);
    return out;
  }
  return jsonlFiles(path.join(home, ".codex", "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"), 5);
}

export { pathForms as repoPathForms };

/**
 * What a log file holds past a watermark. Lines that start before `offset`, or are stamped before `since`, are already
 * accounted for: a Claude message id seen in them is not counted again, and a Codex total in them is the base of the
 * delta. Only whole lines are read; `end` is where the next read starts.
 */
export function readAgentLog(reader: "claude" | "codex", file: string, from: { offset: number; since?: string; repos: string[] }): { calls: AgentCall[]; end: number } | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return undefined;
  }
  const end = buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? buffer.lastIndexOf(10) + 1 : buffer.length;
  buffer = buffer.subarray(0, end);
  const since = from.since ? Date.parse(from.since) : NaN;
  const before: Before = (start, value) => {
    if (start < from.offset) return true;
    const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
    return Number.isFinite(since) && Number.isFinite(at) && at < since;
  };
  const found: Found[] = [];
  if (reader === "claude") found.push(...claudeMessages(buffer, before).values());
  else {
    const session = codexSession(buffer, before, from.repos);
    if (session) found.push(session);
  }
  const merged = new Map<string, AgentCall>();
  for (const item of found) {
    const { input, output, cacheRead, cacheWrite, requests } = item.totals;
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const name = `${item.provider}/${item.model}`;
    const sum = merged.get(name);
    merged.set(name, {
      provider: item.provider,
      model: item.model,
      usage: sum
        ? { input: sum.usage.input! + input, output: sum.usage.output! + output, cacheRead: sum.usage.cacheRead! + cacheRead, cacheWrite: sum.usage.cacheWrite! + cacheWrite, requests: sum.usage.requests + requests }
        : { input, output, cacheRead, cacheWrite, requests },
    });
  }
  return { calls: [...merged.values()].map((call) => ({ ...call, usage: { ...call.usage, requests: Math.max(1, call.usage.requests) } })), end };
}

/**
 * A meter for `agent` in `options.cwd`, snapshotted now (call it before the agent's tab opens). Undefined when the agent
 * has no reader: its usage cannot be metered.
 */
export function createAgentMeter(agent: string, options: AgentMeterOptions): AgentMeter | undefined {
  const reader = READERS[agent];
  if (!reader) return undefined;
  if (reader === "cursor" && !options.cursorUsageFile) return undefined;
  const home = options.home ?? homedir();
  const repos = pathForms(options.cwd);
  const list = (): Snapshot => {
    if (reader === "cursor") {
      const out: Snapshot = new Map();
      const file = options.cursorUsageFile;
      if (file) {
        try {
          out.set(file, statSync(file).size);
        } catch {
          /* not written yet */
        }
      }
      return out;
    }
    if (reader === "gemini") {
      return jsonlFiles(path.join(home, ".gemini", "tmp"), (name) => name.endsWith(".jsonl"), 4);
    }
    return listAgentLogs(reader, home, repos);
  };
  const snapshot = list();
  /** Spend per message id (Claude/Cursor/Gemini) or per rollout file (Codex) already handed out. */
  const reported = new Map<string, Totals>();
  return {
    collect() {
      try {
        const current = new Map<string, Found>();
        for (const [file, size] of list()) {
          if (options.exclude?.(file)) continue;
          const was = snapshot.get(file);
          // Only files that are new or have grown since the snapshot are read.
          if (was !== undefined && size <= was) continue;
          let buffer: Buffer;
          try {
            buffer = readFileSync(file);
          } catch {
            continue;
          }
          const end = buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? buffer.lastIndexOf(10) + 1 : buffer.length;
          buffer = buffer.subarray(0, end);
          const from = was ?? 0;
          if (reader === "claude") {
            options.onConsumed?.(file, end);
            for (const [id, found] of claudeMessages(buffer, (start) => start < from)) current.set(`${id}`, found);
          } else if (reader === "cursor") {
            for (const [id, found] of cursorStopEvents(buffer, (start) => start < from)) current.set(`${file}:${id}`, found);
          } else if (reader === "gemini") {
            for (const [id, found] of geminiChatEvents(file, buffer, (start) => start < from, path.join(home, ".gemini", "tmp"), repos)) current.set(`${file}:${id}`, found);
          } else {
            const found = codexSession(buffer, (start) => start < from, repos);
            if (found) {
              options.onConsumed?.(file, end);
              current.set(file, found);
            }
          }
        }
        const merged = new Map<string, AgentCall>();
        for (const [key, found] of current) {
          const before = reported.get(key) ?? ZERO;
          const delta: Totals = {
            input: Math.max(0, found.totals.input - before.input),
            output: Math.max(0, found.totals.output - before.output),
            cacheRead: Math.max(0, found.totals.cacheRead - before.cacheRead),
            cacheWrite: Math.max(0, found.totals.cacheWrite - before.cacheWrite),
            requests: Math.max(0, found.totals.requests - before.requests),
          };
          reported.set(key, found.totals);
          if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite === 0) continue;
          const name = `${found.provider}/${found.model}${found.firstPartyCursor ? ":1p" : ""}`;
          const sum = merged.get(name);
          const usage: TokenUsage = sum
            ? { input: sum.usage.input! + delta.input, output: sum.usage.output! + delta.output, cacheRead: sum.usage.cacheRead! + delta.cacheRead, cacheWrite: sum.usage.cacheWrite! + delta.cacheWrite, requests: sum.usage.requests + delta.requests }
            : { input: delta.input, output: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite, requests: delta.requests };
          merged.set(name, { provider: found.provider, model: found.model, usage, ...(found.firstPartyCursor ? { firstPartyCursor: true } : {}) });
        }
        return [...merged.values()].map((call) => ({ ...call, usage: { ...call.usage, requests: Math.max(1, call.usage.requests) } }));
      } catch {
        return []; // an unreadable log is no news; the next collect looks again
      }
    },
  };
}

/** The one "not metered" ledger entry of an agent attempt (a subscription agent with no reader, or one whose log was not found). */
export function notMeteredEntry(agent: string): AgentLedgerEntry {
  return { agent, meter: "not-metered", provider: "agent", model: agent, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } };
}

/** Ledger entries for metered calls. */
export function meteredEntries(agent: string, calls: readonly AgentCall[]): AgentLedgerEntry[] {
  return calls.map((call) => ({ agent, meter: "agent-log", provider: call.provider, model: call.model, usage: call.usage, ...(call.firstPartyCursor ? { firstPartyCursor: true } : {}) }));
}
