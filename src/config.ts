import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { AGENT_DEFAULT_PROVIDER, canonicalModelId, DEFAULT_PRICING, inferProviderForModel } from "./pricing-defaults.js";
import { BUILTIN_AGENTS, parseModelRef, parseTicketModel, ticketModelProblem, type AgentDef } from "./agents.js";
import { containsSecret, redact } from "./redact.js";
import { WorkflowError } from "./domain.js";

export { parseModelRef, DEFAULT_PRICING, canonicalModelId, inferProviderForModel };

export interface PricingRow {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
}

export interface CheckConfig {
  name: string;
  command: string;
  args: string[];
}

/** One model the local server serves. Pi is told `contextWindow` and `maxTokens`; the planner sizes tickets from `contextWindow`. */
export interface LocalModelConfig {
  id: string;
  contextWindow: number;
  maxTokens?: number;
}

/** The one OpenAI-compatible server, registered with Pi as provider `local`. */
export interface LocalConfig {
  baseUrl: string;
  /** The name of a variable holding the server's key, when it needs one. */
  apiKeyEnv?: string;
  models: LocalModelConfig[];
}

/** Which model builds each ticket difficulty, and which reviews. Each is `provider/id[:thinking]` or `agent:<name>[/<model>]`. */
export interface ModelsConfig {
  low: string;
  medium: string;
  high: string;
  review: string;
}

export const MODEL_KEYS = ["low", "medium", "high", "review"] as const;

/** One reviewer entry in `review.reviewers` or `review.highRiskReviewers`: a model string or an object with optional display name and focus lens. */
export type ReviewerSpec = string | { model: string; name?: string; focus?: string };

/** Normalized reviewer specification. */
export interface NormalizedReviewer {
  model: string;
  name?: string;
  focus?: string;
}

export function normalizeReviewerSpec(spec: ReviewerSpec): NormalizedReviewer {
  return typeof spec === "string"
    ? { model: spec }
    : { model: spec.model, ...(spec.name ? { name: spec.name } : {}), ...(spec.focus ? { focus: spec.focus } : {}) };
}

export interface WorktreeConfig {
  default: "ask" | "always" | "never";
  dir?: string;
}

export interface WorkflowConfig {
  workspaceDir: string;
  models: ModelsConfig;
  local?: LocalConfig;
  /** Overrides of the built-in agents, and added ones (see agents.ts). */
  agents: Record<string, AgentDef>;
  routing: {
    /** How many rungs (low, medium, high) a failed ticket may climb. */
    maxEscalations: number;
    /**
     * Assistant turns a /build ticket attempt may take (its retries included). At the limit the model is told to wrap
     * up; a few turns later the run is stopped and the ticket fails like a failed check, so it escalates.
     */
    maxTicketTurns: number;
  };
  /** /build runs each ticket as a herdr sub-agent of the terminal it was started from (no pane). `visibleTabs: true` gives each its own labelled tab instead. */
  build: { visibleTabs: boolean };
  /** Optional planning worktree settings (`default`: ask | always | never, `dir`: base directory; defaults to Herdr's worktree dir). */
  worktree?: WorktreeConfig;
  /** /build names each task's branch `<branchPrefix>/<task name>` (with -2, -3 when taken), always from the default branch. */
  branchPrefix: string;
  budgets: {
    taskUsd: number;
    dailyUsd: number;
    softWarningRatio: number;
    /**
     * Budget math only: what one ledger entry with unknown cost and nothing to price it from (no token counts, or no
     * pricing row) counts as. The ledger keeps `actualUsd: null`.
     */
    unknownCallUsd: number;
    /** Ask before a message re-sends a big context after this many idle minutes (the prompt cache has probably expired). 0 disables. */
    idleWarnMinutes: number;
    /** The idle warning applies only at this many context tokens or more. 0 disables. */
    idleWarnTokens: number;
    /** What happens when the idle-cache threshold is crossed: "warn" (non-blocking nudge, default), "block" (pause once per idle stretch), or "off". */
    idleAction?: "warn" | "block" | "off";
    /** Optional IANA timezone for daily budget windows (e.g. "America/New_York"). Unset uses UTC. */
    timeZone?: string;
  };
  checks: CheckConfig[];
  /** Commands /review runs in the repo root before the checks (an install, for example). Same rules as checks. */
  setup: CheckConfig[];
  /**
   * The model pass of /review (`model`): the review model(s), in herdr sub-agents, read the branch diff and list advisory findings. `tickets: false`
   * turns the per-ticket review gate of /build off. `timeoutMs` is how long one per-ticket review turn may take (never less than 15 minutes).
   * `reviewers` configures a multi-model review panel for `/review`; `highRiskReviewers` optionally escalates per-ticket reviews on `high` / security-sensitive tickets.
   */
  review: {
    model: boolean;
    tickets: boolean;
    timeoutMs: number;
    reviewers?: ReviewerSpec[];
    highRiskReviewers?: ReviewerSpec[];
  };
  pricing: PricingRow[];
  /** Notes from loading, for example settings that were ignored. Shown at session start. */
  warnings?: string[];
}

/** Default for `budgets.unknownCallUsd`. */
export const DEFAULT_UNKNOWN_CALL_USD = 0.05;

/** Used for a `models` key the config leaves out. No prices live here: a model without a `pricing` row has an unknown cost. */
export const DEFAULT_MODELS: ModelsConfig = {
  low: "xai/grok-4.7",
  medium: "anthropic/claude-sonnet-5-5",
  high: "openai/gpt-6.1-sol",
  review: "anthropic/claude-opus-5-5",
};

const DEFAULTS: WorkflowConfig = {
  workspaceDir: ".shepherd",
  models: DEFAULT_MODELS,
  agents: {},
  routing: { maxEscalations: 2, maxTicketTurns: 100 },
  build: { visibleTabs: false },
  branchPrefix: "shepherd",
  budgets: { taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8, unknownCallUsd: DEFAULT_UNKNOWN_CALL_USD, idleWarnMinutes: 60, idleWarnTokens: 100_000, idleAction: "warn" },
  checks: [],
  setup: [],
  review: { model: true, tickets: true, timeoutMs: 300_000 },
  pricing: [...DEFAULT_PRICING],
};

/** The top-level sections and, for the nested ones, the keys inside them. Anything else is ignored with a warning. */
const KNOWN_KEYS: Record<string, readonly string[] | undefined> = {
  models: MODEL_KEYS,
  local: ["baseUrl", "apiKeyEnv", "models"],
  agents: undefined,
  budgets: ["taskUsd", "dailyUsd", "softWarningRatio", "unknownCallUsd", "idleWarnMinutes", "idleWarnTokens", "idleAction", "timeZone"],
  pricing: undefined,
  review: ["model", "tickets", "timeoutMs", "reviewers", "highRiskReviewers"],
  checks: undefined,
  setup: undefined,
  build: ["visibleTabs"],
  worktree: ["default", "dir"],
  branchPrefix: undefined,
  workspaceDir: undefined,
  routing: ["maxEscalations", "maxTicketTurns"],
};

/** Sections that only the user file may set: a project file ships with a cloned repo and must not choose servers, commands, prices or checkout paths. */
export const USER_ONLY_SECTIONS = ["local", "agents", "pricing", "workspaceDir", "worktree"] as const;

export const CONFIG_DOCS = "docs/configuration.md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertNoSecrets(value: unknown, where: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (containsSecret(text)) {
    throw new WorkflowError("CONFIG_SECRET", `${where} contains a secret. Keep credentials out of YAML.`);
  }
}

function invalid(where: string, field: string, message: string): never {
  throw new WorkflowError("CONFIG_INVALID", `${where}: ${field} ${message}`);
}

function checkNumber(
  section: Record<string, unknown>,
  key: string,
  where: string,
  rule: { min?: number; max?: number; exclusiveMin?: number; integer?: boolean },
  prefix: string,
): void {
  const value = section[key];
  if (value === undefined) return;
  const field = `${prefix}.${key}`;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(where, field, "must be a finite number");
  if (rule.integer && !Number.isInteger(value)) invalid(where, field, "must be an integer");
  if (rule.min !== undefined && value < rule.min) invalid(where, field, `must be >= ${rule.min}`);
  if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) invalid(where, field, `must be > ${rule.exclusiveMin}`);
  if (rule.max !== undefined && value > rule.max) invalid(where, field, `must be <= ${rule.max}`);
}

function section(raw: Record<string, unknown>, key: string, where: string): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, key, "must be a mapping");
  return value;
}

function stringArray(value: unknown, field: string, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    invalid(where, field, "must be a list of non-empty strings");
  }
  return value as string[];
}

/** Normalizes a YAML date (string or Date) to YYYY-MM-DD, or returns undefined if invalid. */
export function normalizeEffectiveFrom(value: unknown): string | undefined {
  let text: string;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    text = value.toISOString().slice(0, 10);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return undefined;
  return text;
}

function normalizePricing(value: unknown, where: string): PricingRow[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(where, "pricing", "must be a list");
  const seen = new Set<string>();
  return value.flatMap((item, index) => {
    const field = `pricing[${index}]`;
    if (!isRecord(item)) invalid(where, field, "must be a mapping");
    if (typeof item.provider !== "string" || item.provider === "") invalid(where, `${field}.provider`, "must be a non-empty string");
    if (typeof item.model !== "string" || item.model === "") invalid(where, `${field}.model`, "must be a non-empty string");
    const effectiveFrom = normalizeEffectiveFrom(item.effectiveFrom);
    if (!effectiveFrom) invalid(where, `${field}.effectiveFrom`, "must be a valid date in YYYY-MM-DD format");
    for (const key of ["inputPerMillionUsd", "outputPerMillionUsd"] as const) {
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
        invalid(where, `${field}.${key}`, "must be a finite number >= 0");
      }
    }
    for (const key of ["cacheReadPerMillionUsd", "cacheWritePerMillionUsd"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0)) {
        invalid(where, `${field}.${key}`, "must be a finite number >= 0");
      }
    }
    const key = `${item.provider}\u0000${item.model}\u0000${effectiveFrom}`;
    if (seen.has(key)) invalid(where, field, `duplicates another row for ${item.provider}/${item.model} effective ${effectiveFrom}`);
    seen.add(key);
    return [{ ...(item as unknown as PricingRow), effectiveFrom }];
  });
}

function parseUrl(value: string): URL | undefined {
  if (/\s/.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isHttpsUrl(value: string): boolean {
  const url = parseUrl(value);
  return !!url && url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function isLoopbackHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return !!url && url.protocol === "http:" && url.username === "" && url.password === "" && isLoopbackHost(url.hostname);
}

const AGENT_KEYS = new Set(["run", "modelFlag", "billing", "routingFeePerMillionUsd"]);

function normalizeAgents(value: unknown, where: string): Record<string, AgentDef> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, "agents", "must be a mapping of agent names");
  const out: Record<string, AgentDef> = {};
  for (const [name, def] of Object.entries(value)) {
    const field = `agents.${name}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) invalid(where, field, "is not a valid agent name (letters, digits, - and _)");
    if (!isRecord(def)) invalid(where, field, "must be a mapping with run (and optionally modelFlag, billing, routingFeePerMillionUsd)");
    for (const key of Object.keys(def)) if (!AGENT_KEYS.has(key)) invalid(where, `${field}.${key}`, "is not a known key (run, modelFlag, billing, routingFeePerMillionUsd)");
    const builtin = BUILTIN_AGENTS[name];
    const run = def.run !== undefined ? stringArray(def.run, `${field}.run`, where) : builtin ? [...builtin.run] : stringArray(def.run, `${field}.run`, where);
    if (run.length === 0) invalid(where, `${field}.run`, "must name the program to run");
    if (def.modelFlag !== undefined && (typeof def.modelFlag !== "string" || !def.modelFlag.startsWith("-"))) invalid(where, `${field}.modelFlag`, "must be a flag such as --model");
    if (def.billing !== undefined && def.billing !== "api" && def.billing !== "subscription") invalid(where, `${field}.billing`, 'must be "api" or "subscription"');
    if (def.routingFeePerMillionUsd !== undefined && (typeof def.routingFeePerMillionUsd !== "number" || !Number.isFinite(def.routingFeePerMillionUsd) || def.routingFeePerMillionUsd < 0)) {
      invalid(where, `${field}.routingFeePerMillionUsd`, "must be a finite number >= 0");
    }
    const modelFlag = def.modelFlag !== undefined ? (def.modelFlag as string) : builtin?.modelFlag;
    out[name] = {
      run,
      ...(modelFlag !== undefined ? { modelFlag } : {}),
      ...(def.billing !== undefined ? { billing: def.billing } : {}),
      ...(def.routingFeePerMillionUsd !== undefined ? { routingFeePerMillionUsd: def.routingFeePerMillionUsd } : {}),
    };
  }
  return out;
}

function normalizeLocal(value: unknown, where: string): LocalConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, "local", "must be a mapping");
  if (typeof value.baseUrl !== "string" || value.baseUrl === "") invalid(where, "local.baseUrl", "is required (the server's OpenAI-compatible URL)");
  if (!isHttpsUrl(value.baseUrl) && !isLoopbackHttpUrl(value.baseUrl)) invalid(where, "local.baseUrl", "must be an https URL, or http only for localhost");
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))) {
    invalid(where, "local.apiKeyEnv", "must be an environment variable name");
  }
  if (!Array.isArray(value.models) || value.models.length === 0) invalid(where, "local.models", "must be a non-empty list of { id, contextWindow }");
  const seen = new Set<string>();
  const models = value.models.map((item: unknown, index: number): LocalModelConfig => {
    const field = `local.models[${index}]`;
    if (!isRecord(item)) invalid(where, field, "must be a mapping");
    for (const key of Object.keys(item)) if (key !== "id" && key !== "contextWindow" && key !== "maxTokens") invalid(where, `${field}.${key}`, "is not a known key (id, contextWindow, maxTokens)");
    if (typeof item.id !== "string" || item.id.trim() === "" || /\s/.test(item.id)) invalid(where, `${field}.id`, "must be a non-empty string without spaces");
    if (seen.has(item.id)) invalid(where, `${field}.id`, `duplicates ${item.id}`);
    seen.add(item.id);
    if (typeof item.contextWindow !== "number" || !Number.isInteger(item.contextWindow) || item.contextWindow < 4096) invalid(where, `${field}.contextWindow`, "must be an integer of at least 4096 (what the server runs)");
    if (item.maxTokens !== undefined && (typeof item.maxTokens !== "number" || !Number.isInteger(item.maxTokens) || item.maxTokens < 1024)) invalid(where, `${field}.maxTokens`, "must be an integer of at least 1024");
    return { id: item.id, contextWindow: item.contextWindow, ...(item.maxTokens !== undefined ? { maxTokens: item.maxTokens } : {}) };
  });
  return { baseUrl: value.baseUrl, ...(value.apiKeyEnv !== undefined ? { apiKeyEnv: value.apiKeyEnv as string } : {}), models };
}

/** The dotted names of the keys in `raw` that this version does not read. */
export function unknownKeys(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in KNOWN_KEYS)) {
      out.push(key);
      continue;
    }
    const inner = KNOWN_KEYS[key];
    if (inner && isRecord(value)) for (const name of Object.keys(value)) if (!inner.includes(name)) out.push(`${key}.${name}`);
  }
  return out;
}

/**
 * Validates one raw YAML document and returns it with the keys this version does not read removed. Those are added to
 * `ignored`, so a load ends with one warning that lists them all. A model's agent name is checked after layering
 * (`validateModels`), since the project file may name an agent the user file defines.
 */
function normalizeRaw(input: unknown, where: string, ignored: Set<string>): Record<string, unknown> {
  if (!isRecord(input)) throw new WorkflowError("CONFIG_INVALID", `${where} must be a mapping`);
  assertNoSecrets(input, where);
  const out: Record<string, unknown> = {};
  for (const name of unknownKeys(input)) ignored.add(name);
  for (const [key, value] of Object.entries(input)) {
    if (!(key in KNOWN_KEYS) || value === undefined || value === null) continue;
    const inner = KNOWN_KEYS[key];
    out[key] = inner && isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => inner.includes(name))) : value;
  }

  const models = section(out, "models", where);
  if (models) {
    for (const [key, value] of Object.entries(models)) {
      if (typeof value !== "string") invalid(where, `models.${key}`, "must be provider/id or agent:<name>");
      const problem = ticketModelProblem(value, { agents: undefined }, { anyAgent: true });
      if (problem) invalid(where, `models.${key}`, `is not valid: ${problem}`);
    }
  }
  const routing = section(out, "routing", where);
  if (routing) {
    checkNumber(routing, "maxEscalations", where, { min: 0, integer: true }, "routing");
    checkNumber(routing, "maxTicketTurns", where, { min: 5, integer: true }, "routing");
  }
  if (out.branchPrefix !== undefined && (typeof out.branchPrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(out.branchPrefix) || out.branchPrefix.endsWith("/") || out.branchPrefix.includes(".."))) {
    invalid(where, "branchPrefix", "must be a plain branch-name prefix such as shepherd");
  }
  if (out.workspaceDir !== undefined && (typeof out.workspaceDir !== "string" || out.workspaceDir.trim() === "")) invalid(where, "workspaceDir", "must be a non-empty path");
  const buildSection = section(out, "build", where);
  if (buildSection && buildSection.visibleTabs !== undefined && typeof buildSection.visibleTabs !== "boolean") invalid(where, "build.visibleTabs", "must be a boolean");
  const worktreeSection = section(out, "worktree", where);
  if (worktreeSection) {
    if (worktreeSection.default !== undefined && worktreeSection.default !== "ask" && worktreeSection.default !== "always" && worktreeSection.default !== "never") {
      invalid(where, "worktree.default", 'must be "ask", "always", or "never"');
    }
    if (worktreeSection.dir !== undefined && (typeof worktreeSection.dir !== "string" || worktreeSection.dir.trim() === "")) {
      invalid(where, "worktree.dir", "must be a non-empty path");
    }
  }
  const budgets = section(out, "budgets", where);
  if (budgets) {
    for (const key of ["taskUsd", "dailyUsd"]) checkNumber(budgets, key, where, { exclusiveMin: 0 }, "budgets");
    checkNumber(budgets, "softWarningRatio", where, { min: 0, max: 1 }, "budgets");
    checkNumber(budgets, "unknownCallUsd", where, { min: 0 }, "budgets");
    for (const key of ["idleWarnMinutes", "idleWarnTokens"]) checkNumber(budgets, key, where, { min: 0, integer: true }, "budgets");
    if (budgets.idleAction !== undefined && budgets.idleAction !== "warn" && budgets.idleAction !== "block" && budgets.idleAction !== "off") {
      invalid(where, "budgets.idleAction", 'must be "warn", "block", or "off"');
    }
    if (budgets.timeZone !== undefined) {
      if (typeof budgets.timeZone !== "string" || budgets.timeZone.trim() === "") invalid(where, "budgets.timeZone", "must be an IANA timezone name such as America/New_York");
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: budgets.timeZone });
      } catch {
        invalid(where, "budgets.timeZone", `is not a valid IANA timezone (${budgets.timeZone})`);
      }
    }
  }
  for (const key of ["checks", "setup"] as const) {
    const list = out[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) invalid(where, key, "must be a list");
    list.forEach((check, index) => {
      const field = `${key}[${index}]`;
      if (!isRecord(check)) invalid(where, field, "must be a mapping");
      if (typeof check.name !== "string" || typeof check.command !== "string" || check.command === "") {
        invalid(where, field, "needs string name and command");
      }
      if (check.args !== undefined) stringArray(check.args, `${field}.args`, where);
    });
  }
  const review = section(out, "review", where);
  if (review) {
    if (review.model !== undefined && typeof review.model !== "boolean") invalid(where, "review.model", "must be a boolean");
    if (review.tickets !== undefined && typeof review.tickets !== "boolean") invalid(where, "review.tickets", "must be a boolean");
    checkNumber(review, "timeoutMs", where, { min: 1000, integer: true }, "review");
    for (const key of ["reviewers", "highRiskReviewers"] as const) {
      const list = review[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) invalid(where, `review.${key}`, "must be a list of models or { model, name?, focus? } mappings");
      list.forEach((entry, index) => {
        const field = `review.${key}[${index}]`;
        if (typeof entry === "string") {
          if (!entry.trim()) invalid(where, field, "must be a non-empty model string");
          return;
        }
        if (!isRecord(entry) || typeof entry.model !== "string" || !entry.model.trim()) {
          invalid(where, field, "must be a model string or a mapping with a non-empty string model");
        }
        if (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name.trim())) invalid(where, `${field}.name`, "must be a non-empty string");
        if (entry.focus !== undefined && (typeof entry.focus !== "string" || !entry.focus.trim())) invalid(where, `${field}.focus`, "must be a non-empty string");
      });
    }
  }
  const local = normalizeLocal(out.local, where);
  if (local) out.local = local;
  const agents = normalizeAgents(out.agents, where);
  if (agents) out.agents = agents;
  if (out.pricing !== undefined) out.pricing = normalizePricing(out.pricing, where);
  return out;
}

/** The ignored-settings warning: one line for every file read. */
function ignoredWarning(ignored: Set<string>): string[] {
  if (ignored.size === 0) return [];
  return [`Ignored settings that are no longer used: ${[...ignored].join(", ")}. See ${CONFIG_DOCS} for the current settings.`];
}

/** Throws unless every `models` value and reviewer list entry is valid under the agents the merged config defines. */
function validateModels(config: WorkflowConfig, where: string): void {
  for (const key of MODEL_KEYS) {
    const problem = ticketModelProblem(config.models[key], config);
    if (problem) invalid(where, `models.${key}`, `is not valid: ${problem}`);
  }
  for (const key of ["reviewers", "highRiskReviewers"] as const) {
    const list = config.review[key];
    if (!list) continue;
    list.forEach((entry, index) => {
      const model = normalizeReviewerSpec(entry).model;
      const problem = ticketModelProblem(model, config);
      if (problem) invalid(where, `review.${key}[${index}]`, `is not valid: ${problem}`);
    });
  }
}

function build(norm: Record<string, unknown>): WorkflowConfig {
  const obj = (key: string): Record<string, unknown> => (isRecord(norm[key]) ? (norm[key] as Record<string, unknown>) : {});
  const worktreeRaw = isRecord(norm.worktree) ? (norm.worktree as Record<string, unknown>) : undefined;
  const config: WorkflowConfig = {
    workspaceDir: typeof norm.workspaceDir === "string" ? norm.workspaceDir : DEFAULTS.workspaceDir,
    models: { ...DEFAULT_MODELS, ...obj("models") } as ModelsConfig,
    ...(norm.local ? { local: norm.local as LocalConfig } : {}),
    agents: isRecord(norm.agents) ? (norm.agents as Record<string, AgentDef>) : {},
    routing: { ...DEFAULTS.routing, ...obj("routing") } as WorkflowConfig["routing"],
    build: { ...DEFAULTS.build, ...obj("build") } as WorkflowConfig["build"],
    ...(worktreeRaw ? { worktree: { default: (worktreeRaw.default as WorktreeConfig["default"]) ?? "ask", ...(typeof worktreeRaw.dir === "string" ? { dir: worktreeRaw.dir } : {}) } } : {}),
    branchPrefix: typeof norm.branchPrefix === "string" ? norm.branchPrefix : DEFAULTS.branchPrefix,
    budgets: { ...DEFAULTS.budgets, ...obj("budgets") } as WorkflowConfig["budgets"],
    checks: Array.isArray(norm.checks) ? (norm.checks as CheckConfig[]).map((check) => ({ ...check, args: check.args ?? [] })) : DEFAULTS.checks,
    setup: Array.isArray(norm.setup) ? (norm.setup as CheckConfig[]).map((check) => ({ ...check, args: check.args ?? [] })) : DEFAULTS.setup,
    review: { ...DEFAULTS.review, ...obj("review") } as WorkflowConfig["review"],
    // Built-in 2026 pricing defaults sit underneath user rows; user rows always win on matching (provider, model, effectiveFrom) or later dates.
    pricing: [...DEFAULT_PRICING, ...(Array.isArray(norm.pricing) ? (norm.pricing as PricingRow[]) : [])],
  };
  return config;
}

/** Parses one standalone document into a config (tests, tools). Files on disk go through `loadConfig`, which layers them. */
export function parseConfig(text: string, where = "config"): WorkflowConfig {
  const ignored = new Set<string>();
  const config = build(normalizeRaw(parse(text) ?? {}, where, ignored));
  validateModels(config, where);
  const warnings = [...ignoredWarning(ignored), ...unpricedWarning(config)];
  if (warnings.length > 0) config.warnings = warnings;
  return config;
}

/**
 * Layers a project document over a user document. The user file is the base; a section in the project file replaces
 * the user's whole section. `local`, `agents`, `pricing` and `workspaceDir` are read from the user file only: a
 * project file ships with a cloned repo, and must not choose a server, a command to run, a price, or where the ledger lives.
 */
export function layerConfigs(
  userRaw: Record<string, unknown> | undefined,
  projectRaw: Record<string, unknown> | undefined,
  warnings: string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(userRaw ?? {}) };
  const project = projectRaw ?? {};
  const refused: string[] = [];
  for (const [key, value] of Object.entries(project)) {
    if ((USER_ONLY_SECTIONS as readonly string[]).includes(key)) refused.push(key);
    else merged[key] = value;
  }
  if (refused.length > 0) {
    warnings.push(`Ignored project ${refused.join(", ")}: these are read from the user config (~/.claude/shepherd.yaml) only.`);
  }
  return merged;
}

/** First existing of `<base>.yaml` / `<base>.yml`; `.yaml` when neither exists. `ignored` is the `.yml` that lost to an existing `.yaml`. */
function pickYaml(base: string): { path: string; exists: boolean; ignored?: string } {
  const yaml = `${base}.yaml`;
  const yml = `${base}.yml`;
  if (existsSync(yaml)) return { path: yaml, exists: true, ignored: existsSync(yml) ? yml : undefined };
  if (existsSync(yml)) return { path: yml, exists: true };
  return { path: yaml, exists: false };
}

/** Config files that loadConfig reads, so callers can watch them for changes. `watch` lists every candidate file. */
export function configPaths(cwd: string): { projectPath: string; userPath: string; watch: string[] } {
  const project = path.join(cwd, ".shepherd", "config");
  const user = path.join(homedir(), ".claude", "shepherd");
  return {
    projectPath: pickYaml(project).path,
    userPath: pickYaml(user).path,
    watch: [project, user].flatMap((base) => [`${base}.yaml`, `${base}.yml`]),
  };
}

/** `~/...` for paths under the home directory, so messages do not print a user name. */
export function displayPath(file: string): string {
  const home = homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** A config problem that makes a whole file unusable. `file` is the path that was rejected; `reason` is redacted. */
export class ConfigFileError extends WorkflowError {
  constructor(code: string, readonly file: string, readonly reason: string) {
    super(code, reason);
    this.name = "ConfigFileError";
  }
}

/** Reads, parses, and checks one config file. Anything wrong with it (YAML, a secret, a bad value) rejects the whole file: a ConfigFileError that names it. */
function readConfigFile(file: string, ignored: Set<string>): Record<string, unknown> {
  try {
    return readConfigText(readFileSync(file, "utf8"), file, ignored);
  } catch (error) {
    if (error instanceof ConfigFileError) throw error;
    const code = error instanceof WorkflowError ? error.code : "CONFIG_INVALID";
    throw new ConfigFileError(code, file, redact(error instanceof Error && error.message ? error.message : String(error)));
  }
}

function readConfigText(text: string, file: string, ignored: Set<string>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unreadable";
    throw new WorkflowError("CONFIG_INVALID", `${displayPath(file)}: YAML could not be read (${first})`);
  }
  // An empty file, or one that is all comments (the commented shepherd.yaml template), is an empty config.
  return normalizeRaw(parsed ?? {}, file, ignored);
}

export function loadConfig(cwd: string, fallbackProjectRoot?: string): WorkflowConfig {
  const { projectPath: ownProjectPath, userPath } = configPaths(cwd);
  const useFallback =
    !existsSync(ownProjectPath) &&
    !!fallbackProjectRoot &&
    path.resolve(fallbackProjectRoot) !== path.resolve(cwd);
  const projectBase = useFallback ? path.join(fallbackProjectRoot!, ".shepherd", "config") : path.join(cwd, ".shepherd", "config");
  const projectPath = useFallback ? pickYaml(projectBase).path : ownProjectPath;
  const warnings: string[] = [];
  for (const base of [projectBase, path.join(homedir(), ".claude", "shepherd")]) {
    const { path: used, ignored } = pickYaml(base);
    if (ignored) warnings.push(`${displayPath(ignored)} is ignored because ${displayPath(used)} exists; delete one of them.`);
  }
  const ignored = new Set<string>();
  const userRaw = existsSync(userPath) ? readConfigFile(userPath, ignored) : undefined;
  const projectRaw = existsSync(projectPath) ? readConfigFile(projectPath, ignored) : undefined;
  if (!userRaw && !projectRaw) return build({});
  const config = build(layerConfigs(userRaw, projectRaw, warnings));
  // A project `models` section replaces the user's whole section, so a model error belongs to the file that set it.
  const where = projectRaw && isRecord(projectRaw.models) ? projectPath : userPath;
  try {
    validateModels(config, displayPath(where));
  } catch (error) {
    throw new ConfigFileError(error instanceof WorkflowError ? error.code : "CONFIG_INVALID", where, redact(error instanceof Error ? error.message : String(error)));
  }
  warnings.push(...ignoredWarning(ignored), ...unpricedWarning(config));
  if (warnings.length > 0) config.warnings = warnings;
  return config;
}

const BUILTIN_PRICE_ROWS = new WeakSet<PricingRow>(DEFAULT_PRICING);

/** True when `row` came from the built-in `DEFAULT_PRICING` table rather than user config. */
export function isBuiltinPriceRow(row: PricingRow): boolean {
  return BUILTIN_PRICE_ROWS.has(row);
}

interface PriceIndex {
  length: number;
  byKey: Map<string, { user: { day: string; row: PricingRow }[]; builtin: { day: string; row: PricingRow }[] }>;
}
const priceIndexes = new WeakMap<PricingRow[], PriceIndex>();

function priceKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function priceIndex(pricing: PricingRow[]): PriceIndex {
  const cached = priceIndexes.get(pricing);
  if (cached && cached.length === pricing.length) return cached;
  const byKey: PriceIndex["byKey"] = new Map();
  pricing.forEach((row) => {
    const day = normalizeEffectiveFrom(row.effectiveFrom);
    if (!day) return;
    const key = priceKey(row.provider, row.model);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { user: [], builtin: [] };
      byKey.set(key, bucket);
    }
    (BUILTIN_PRICE_ROWS.has(row) ? bucket.builtin : bucket.user).push({ day, row });
  });
  const byDay = (a: { day: string }, b: { day: string }) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  // Array.prototype.sort is stable, so among equal dates the later row in the file stays last and wins.
  for (const bucket of byKey.values()) {
    bucket.user.sort(byDay);
    bucket.builtin.sort(byDay);
  }
  const index = { length: pricing.length, byKey };
  priceIndexes.set(pricing, index);
  return index;
}

function newestOnOrBefore(list: { day: string; row: PricingRow }[], day: string): PricingRow | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.day <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? undefined : list[lo - 1]!.row;
}

/**
 * Newest row for provider+model whose effectiveFrom is on or before `at` (UTC day).
 * User-configured rows always take precedence over built-in defaults (even when a user row is dated earlier
 * than a 2026 built-in default); if no user row is effective yet on `at`, built-in defaults apply.
 * Tries exact match first, then falls back to `canonicalModelId`.
 */
export function priceFor(pricing: PricingRow[], provider: string, model: string, at: Date): PricingRow | undefined {
  if (Number.isNaN(at.getTime())) return undefined;
  const index = priceIndex(pricing);
  const canonical = canonicalModelId(provider, model);
  const exactBucket = index.byKey.get(priceKey(provider, model));
  const canonBucket = canonical !== model ? index.byKey.get(priceKey(provider, canonical)) : undefined;
  if (!exactBucket && !canonBucket) {
    // A model on your own machine has no per-token charge: an unpriced local model is a known $0, not unknown.
    return provider === "local" ? { provider, model, effectiveFrom: "1970-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 } : undefined;
  }
  const day = at.toISOString().slice(0, 10);
  return (
    (exactBucket ? newestOnOrBefore(exactBucket.user, day) : undefined) ??
    (canonBucket ? newestOnOrBefore(canonBucket.user, day) : undefined) ??
    (exactBucket ? newestOnOrBefore(exactBucket.builtin, day) : undefined) ??
    (canonBucket ? newestOnOrBefore(canonBucket.builtin, day) : undefined)
  );
}

const MICRO = 1_000_000;

/** USD to integer micro-USD. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * MICRO);
}

/** Integer micro-USD to a USD number (exactly 6 decimal places of precision). */
export function fromMicroUsd(micro: number): number {
  return micro / MICRO;
}

export function estimateUsd(
  row: PricingRow | undefined,
  usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null },
): number | null {
  if (!row) return null;
  if (usage.input === null || usage.output === null) return null;
  // Require only the cache counter(s) the provider actually prices separately (OpenAI/Google/xAI price cacheRead only).
  if ((row.cacheReadPerMillionUsd ?? 0) > 0 && usage.cacheRead === null) return null;
  if ((row.cacheWritePerMillionUsd ?? 0) > 0 && usage.cacheWrite === null) return null;
  // A row without cache rates bills cache tokens at the input rate, never free.
  // Prices become integer micro-USD per million tokens, so tokens * price is an exact integer
  // sum and dividing by one million yields micro-USD for the call.
  const scaled =
    usage.input * toMicroUsd(row.inputPerMillionUsd) +
    usage.output * toMicroUsd(row.outputPerMillionUsd) +
    (usage.cacheRead ?? 0) * toMicroUsd(row.cacheReadPerMillionUsd ?? row.inputPerMillionUsd) +
    (usage.cacheWrite ?? 0) * toMicroUsd(row.cacheWritePerMillionUsd ?? row.inputPerMillionUsd);
  return fromMicroUsd(Math.round(scaled / MICRO));
}

/** `provider/id` of every model the config uses (Pi models and metered external agents with explicit models) that has no pricing row at all. Local models are $0. */
export function unpricedConfigModels(config: WorkflowConfig, at: Date = new Date()): string[] {
  const out = new Set<string>();
  for (const key of MODEL_KEYS) {
    const model = parseTicketModel(config.models[key], config);
    if (model.kind === "pi") {
      if (model.provider === "local") continue;
      if (!priceFor(config.pricing, model.provider, model.id, at)) out.add(`${model.provider}/${model.id}`);
      continue;
    }
    if (!model.model) continue;
    if (model.name === "cursor-agent") {
      const lower = model.model.toLowerCase();
      if (lower === "auto" || lower.startsWith("auto-smart")) continue;
      const inferred = inferProviderForModel(model.model);
      if (inferred.provider !== "cursor" && !priceFor(config.pricing, inferred.provider, inferred.model, at)) {
        out.add(`${inferred.provider}/${inferred.model}`);
      }
      continue;
    }
    const provider = AGENT_DEFAULT_PROVIDER[model.name];
    if (provider && !priceFor(config.pricing, provider, model.model, at)) out.add(`${provider}/${model.model}`);
  }
  return [...out];
}

function unpricedWarning(config: WorkflowConfig): string[] {
  const unpriced = unpricedConfigModels(config);
  return unpriced.length > 0 ? [`No pricing rows for ${unpriced.join(", ")}: their cost is unknown. Add rows under pricing in ~/.claude/shepherd.yaml (see ${CONFIG_DOCS}).`] : [];
}
