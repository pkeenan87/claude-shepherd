/**
 * Unified model discovery & curated 2026 catalogs for every supported agent CLI and Pi provider.
 * Live CLI discovery (`cursor-agent --list-models`, `codex --list-models`, `agy models`, `opencode models`)
 * runs with a short timeout and caches results in `$SHEPHERD_HOME/agent-models.json` (1 h TTL for live lists,
 * 60 s backoff for unavailable CLIs). Tests inject `run` and `home` so no real subprocess runs in unit tests.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { priceFor, type PricingRow } from "./config.js";
import { AGENT_DEFAULT_PROVIDER, DEFAULT_PRICING, inferProviderForModel } from "./pricing-defaults.js";
import { shepherdHome } from "./shepherd-home.js";
import { atomicWrite } from "./storage/store.js";

const execFileAsync = promisify(execFile);

export const AGENT_MODELS_CACHE_FILE = "agent-models.json";
const LIVE_CACHE_MS = 60 * 60_000;
const ERROR_CACHE_MS = 60_000;
const DISCOVER_TIMEOUT_MS = 4000;

export const CURSOR_SMART_SETTINGS = ["cost", "balanced", "intelligence"] as const;

export interface AgentModelOption {
  /** Model id passed after `agent:<name>/`, or `provider/id` for Pi models. */
  id: string;
  /** Human-readable display label for dropdowns. */
  label: string;
  /** Full config value, e.g. `agent:codex/gpt-6.2-astra` or `anthropic/claude-opus-5-5`. */
  value: string;
  source: "live" | "curated";
  group?: string;
  note?: string;
  pricing?: { input: number; output: number };
}

export interface AgentCatalogEntry {
  source: "live" | "curated" | "cache" | "unavailable";
  smart?: boolean;
  models: AgentModelOption[];
}

export interface AgentModelCatalog {
  ok: true;
  agents: Record<string, AgentCatalogEntry>;
  piModels: AgentModelOption[];
}

export interface DiscoverOptions {
  /** Limit discovery to one agent name (default: all built-in agents). */
  agent?: string;
  /** Bypass the disk cache and re-probe live CLIs. */
  refresh?: boolean;
  /** Test seam for running a CLI command; returns stdout. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  now?: () => number;
  /** Overrides `$SHEPHERD_HOME` for the cache file (tests). */
  home?: string;
  /** Effective pricing rows (default: `DEFAULT_PRICING`). */
  pricing?: PricingRow[];
}

interface CuratedEntry {
  id: string;
  label: string;
  note?: string;
}

const CURATED: Record<string, CuratedEntry[]> = {
  claude: [
    { id: "opus", label: "Claude Opus (alias)", note: "highest reasoning" },
    { id: "sonnet", label: "Claude Sonnet (alias)", note: "balanced default" },
    { id: "haiku", label: "Claude Haiku (alias)", note: "fast & low cost" },
    { id: "fable", label: "Claude Fable (alias)", note: "deep advisor" },
    { id: "opusplan", label: "Claude OpusPlan (alias)", note: "opus plan, sonnet build" },
    { id: "best", label: "Claude Best (alias)" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
  ],
  codex: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", note: "flagship review & reasoning" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "strong general coding" },
    { id: "gpt-6-luna", label: "GPT-6 Luna", note: "fast & economical" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "o4-mini", label: "o4-mini", note: "compact reasoning" },
  ],
  agy: [
    { id: "gemini-4-argon", label: "Gemini 4 Argon", note: "flagship review & architecture" },
    { id: "gemini-4-carbon", label: "Gemini 4 Carbon", note: "high-throughput coding" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  gemini: [
    { id: "gemini-4-argon", label: "Gemini 4 Argon", note: "flagship review" },
    { id: "gemini-4-carbon", label: "Gemini 4 Carbon", note: "balanced coding" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "fast & low cost" },
  ],
  grok: [
    { id: "grok-4.7", label: "Grok 4.7", note: "flagship xAI" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.3", label: "Grok 4.3" },
    { id: "grok-code-fast", label: "Grok Code Fast", note: "fast low-cost coding" },
    { id: "grok-build-0.1", label: "Grok Build 0.1" },
  ],
  "cursor-agent": [
    { id: "auto", label: "Auto (Cursor router)", note: "included router" },
  ],
  opencode: [
    { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "openai/gpt-6.2-astra", label: "GPT-6.2 Astra" },
    { id: "google/gemini-4-argon", label: "Gemini 4 Argon" },
  ],
};

const LIVE_PROBES: Record<string, { cmd: string; args: string[] }> = {
  "cursor-agent": { cmd: "cursor-agent", args: ["--list-models"] },
  codex: { cmd: "codex", args: ["--list-models"] },
  agy: { cmd: "agy", args: ["models"] },
  opencode: { cmd: "opencode", args: ["models"] },
};

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/** Parses `cursor-agent --list-models` (`<id> - <label>` lines) and detects `auto-smart`. */
export function parseCursorListModels(output: string): { smart: boolean; items: { id: string; label: string }[] } {
  const plain = stripAnsi(output);
  const smart = /(?<![\w-])auto-smart(?![\w-])/.test(plain);
  const items: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^available models/i.test(line) || /^[-=]+$/.test(line)) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/[\]=+-]*)\s+(?:-|—|:)\s+(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const label = match[2]!.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, label });
  }
  return { smart, items };
}

/** Parses model ids from `codex --list-models`, `agy models`, or `opencode models`. */
export function parseGenericModelList(output: string): { id: string; label: string }[] {
  const plain = stripAnsi(output);
  const items: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(available|models|usage|error|warning|---+)/i.test(line)) continue;
    // Accept "<id> - <label>", "<id>  <label>", or bare "<id>" (no spaces).
    const dash = /^([A-Za-z0-9][A-Za-z0-9._:/+-]*)\s+(?:-|—)\s+(.+)$/.exec(line);
    const id = dash ? dash[1]! : /^([A-Za-z0-9][A-Za-z0-9._:/+-]*)(?:\s{2,}(.+))?$/.exec(line)?.[1];
    if (!id || id.length < 2 || seen.has(id)) continue;
    // Skip single generic English words that look like prose headers rather than model ids.
    if (!/[-._/:0-9]/.test(id) && !["auto", "opus", "sonnet", "haiku", "fable", "best"].includes(id)) continue;
    seen.add(id);
    const label = dash ? dash[2]!.trim() : (/^[A-Za-z0-9._:/+-]+\s{2,}(.+)$/.exec(line)?.[1]?.trim() ?? id);
    items.push({ id, label });
  }
  return items;
}

function pricingHint(pricing: readonly PricingRow[], agent: string, modelId: string, at: Date): { input: number; output: number } | undefined {
  const slash = modelId.indexOf("/");
  const inferred = slash > 0 ? { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) } : inferProviderForModel(modelId);
  const provider = inferred.provider === "unknown" ? (AGENT_DEFAULT_PROVIDER[agent] ?? "unknown") : inferred.provider;
  const row = priceFor([...pricing], provider, inferred.model, at);
  return row ? { input: row.inputPerMillionUsd, output: row.outputPerMillionUsd } : undefined;
}

interface CacheFile {
  entries?: Record<string, { at: number; ok: boolean; smart?: boolean; items: { id: string; label: string }[] }>;
}

function readCache(file: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toOptions(agent: string, items: { id: string; label: string; note?: string; source: "live" | "curated" }[], pricing: readonly PricingRow[], at: Date): AgentModelOption[] {
  const seen = new Set<string>();
  const out: AgentModelOption[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const hint = pricingHint(pricing, agent, item.id, at);
    out.push({
      id: item.id,
      label: item.label,
      value: `agent:${agent}/${item.id}`,
      source: item.source,
      ...(item.note ? { note: item.note } : {}),
      ...(hint ? { pricing: hint } : {}),
    });
  }
  return out;
}

/** Deduplicated Pi-provider models (`provider/id`) built from default + user pricing rows. */
export function piModelCatalog(pricing: readonly PricingRow[] = DEFAULT_PRICING, at: Date = new Date()): AgentModelOption[] {
  const rows = [...pricing];
  const seen = new Set<string>();
  const out: AgentModelOption[] = [];
  for (const row of rows) {
    const value = `${row.provider}/${row.model}`;
    if (seen.has(value)) continue;
    seen.add(value);
    const active = priceFor(rows, row.provider, row.model, at) ?? row;
    out.push({
      id: value,
      label: `${row.model} ($${active.inputPerMillionUsd}/$${active.outputPerMillionUsd})`,
      value,
      source: "curated",
      group: row.provider,
      pricing: { input: active.inputPerMillionUsd, output: active.outputPerMillionUsd },
    });
  }
  return out;
}

/**
 * Discovers available models for each built-in agent (or a single `options.agent`) and returns the Pi catalog.
 * Live CLI results are merged ahead of curated 2026 defaults so newly released models appear automatically.
 */
export async function discoverAgentModels(options: DiscoverOptions = {}): Promise<AgentModelCatalog> {
  const now = options.now ?? Date.now;
  const at = new Date(now());
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const dir = options.home ?? shepherdHome();
  const cachePath = path.join(dir, AGENT_MODELS_CACHE_FILE);
  const cache = readCache(cachePath);
  const entries = { ...(cache.entries ?? {}) };
  let cacheDirty = false;

  const run =
    options.run ??
    (async (file: string, args: string[], timeoutMs: number) =>
      (await execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 })).stdout);

  const targets = options.agent ? [options.agent] : Object.keys(CURATED);
  const agents: Record<string, AgentCatalogEntry> = {};

  for (const agent of targets) {
    const probe = LIVE_PROBES[agent];
    const curated = (CURATED[agent] ?? []).map((item) => ({ ...item, source: "curated" as const }));

    if (!probe) {
      agents[agent] = { source: "curated", models: toOptions(agent, curated, pricing, at) };
      continue;
    }

    const cached = !options.refresh ? entries[agent] : undefined;
    const ttl = cached?.ok ? LIVE_CACHE_MS : ERROR_CACHE_MS;
    const fresh = cached && typeof cached.at === "number" && now() >= cached.at && now() - cached.at < ttl;

    let liveItems: { id: string; label: string }[] = [];
    let smart: boolean | undefined;
    let source: AgentCatalogEntry["source"];

    if (fresh) {
      liveItems = cached.items ?? [];
      smart = cached.smart;
      source = cached.ok ? "cache" : "unavailable";
    } else {
      try {
        const stdout = await run(probe.cmd, probe.args, DISCOVER_TIMEOUT_MS);
        if (agent === "cursor-agent") {
          const parsed = parseCursorListModels(stdout);
          smart = parsed.smart;
          liveItems = parsed.items;
        } else {
          liveItems = parseGenericModelList(stdout);
        }
        source = "live";
        entries[agent] = { at: now(), ok: true, ...(smart !== undefined ? { smart } : {}), items: liveItems };
      } catch {
        source = "unavailable";
        if (agent === "cursor-agent") smart = false;
        entries[agent] = { at: now(), ok: false, ...(smart !== undefined ? { smart } : {}), items: [] };
      }
      cacheDirty = true;
    }

    if (agent === "cursor-agent") {
      const merged: { id: string; label: string; note?: string; source: "live" | "curated" }[] = [
        { id: "auto", label: "Auto (Cursor router)", note: "included router", source: "curated" },
      ];
      if (smart) {
        for (const setting of CURSOR_SMART_SETTINGS) {
          merged.push({
            id: `auto-smart[optimize_for=${setting}]`,
            label: `Auto-Smart (${setting})`,
            note: "Teams/Enterprise router",
            source: source === "live" ? "live" : "curated",
          });
        }
      }
      for (const item of liveItems) {
        if (item.id === "auto" || item.id === "auto-smart") continue;
        merged.push({ id: item.id, label: item.label, source: "live" });
      }
      agents[agent] = { source, smart: !!smart, models: toOptions(agent, merged, pricing, at) };
    } else {
      const merged = [
        ...liveItems.map((item) => ({ ...item, source: "live" as const })),
        ...curated,
      ];
      agents[agent] = { source, models: toOptions(agent, merged, pricing, at) };
    }
  }

  if (cacheDirty) {
    try {
      atomicWrite(cachePath, JSON.stringify({ entries }, null, 2));
    } catch {
      /* cache write is best-effort */
    }
  }

  return { ok: true, agents, piModels: piModelCatalog(pricing, at) };
}
