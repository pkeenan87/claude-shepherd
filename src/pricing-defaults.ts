/**
 * Built-in 2026 API list pricing defaults (USD per 1M tokens) and model-name normalization.
 * User `pricing` rows in `~/.claude/shepherd.yaml` layer on top of these defaults and always win for matching rows.
 * Pricing reflects published 2026 global standard API rates (including Gemini 4 Argon/Carbon's 2026-12-01 rate change).
 */
import type { PricingRow } from "./config.js";

export const DEFAULT_PRICING: readonly PricingRow[] = [
  // Anthropic (Claude 5.5 / Fable 5.2 + 2026 prior-gen fallbacks)
  { provider: "anthropic", model: "claude-haiku-5-5", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, cacheReadPerMillionUsd: 0.01, cacheWritePerMillionUsd: 0.125 },
  { provider: "anthropic", model: "claude-sonnet-5-5", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 2.5 },
  { provider: "anthropic", model: "claude-opus-5-5", effectiveFrom: "2026-01-01", inputPerMillionUsd: 4.0, outputPerMillionUsd: 20.0, cacheReadPerMillionUsd: 0.2, cacheWritePerMillionUsd: 5.0 },
  { provider: "anthropic", model: "claude-fable-5-2", effectiveFrom: "2026-01-01", inputPerMillionUsd: 8.0, outputPerMillionUsd: 40.0, cacheReadPerMillionUsd: 0.2, cacheWritePerMillionUsd: 10.0 },
  { provider: "anthropic", model: "claude-opus-4-6", effectiveFrom: "2026-01-01", inputPerMillionUsd: 5.0, outputPerMillionUsd: 25.0, cacheReadPerMillionUsd: 0.5, cacheWritePerMillionUsd: 6.25 },
  { provider: "anthropic", model: "claude-sonnet-4-6", effectiveFrom: "2026-01-01", inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
  { provider: "anthropic", model: "claude-haiku-4-5", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.0, outputPerMillionUsd: 5.0, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25 },

  // OpenAI / Codex (GPT-6 family + GPT-5.4 / Codex)
  { provider: "openai", model: "gpt-6.2-astra", effectiveFrom: "2026-01-01", inputPerMillionUsd: 8.0, outputPerMillionUsd: 40.0, cacheReadPerMillionUsd: 0.4 },
  { provider: "openai", model: "gpt-6-astra", effectiveFrom: "2026-01-01", inputPerMillionUsd: 10.0, outputPerMillionUsd: 50.0, cacheReadPerMillionUsd: 1.0 },
  { provider: "openai", model: "gpt-6.2-sol", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.1 },
  { provider: "openai", model: "gpt-6.1-sol", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.1 },
  { provider: "openai", model: "gpt-6-sol", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.1 },
  { provider: "openai", model: "gpt-6.1-terra", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.0, outputPerMillionUsd: 5.0, cacheReadPerMillionUsd: 0.05 },
  { provider: "openai", model: "gpt-6-luna", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, cacheReadPerMillionUsd: 0.01 },
  { provider: "openai", model: "gpt-5.4", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.5, outputPerMillionUsd: 15.0, cacheReadPerMillionUsd: 0.25 },
  { provider: "openai", model: "gpt-5.3-codex", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.75, outputPerMillionUsd: 14.0, cacheReadPerMillionUsd: 0.175 },

  // Google / Gemini / Antigravity (Gemini 4 element lineup + Dec 1, 2026 Argon/Carbon standard rate rollover)
  { provider: "google", model: "gemini-4-neon", effectiveFrom: "2026-01-01", inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0, cacheReadPerMillionUsd: 0.15 },
  { provider: "google", model: "gemini-4-hydrogen", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5, cacheReadPerMillionUsd: 0.075 },
  { provider: "google", model: "gemini-4-argon", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.1 },
  { provider: "google", model: "gemini-4-argon", effectiveFrom: "2026-12-01", inputPerMillionUsd: 4.0, outputPerMillionUsd: 20.0, cacheReadPerMillionUsd: 0.2 },
  { provider: "google", model: "gemini-4-carbon", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.1 },
  { provider: "google", model: "gemini-4-carbon", effectiveFrom: "2026-12-01", inputPerMillionUsd: 4.0, outputPerMillionUsd: 20.0, cacheReadPerMillionUsd: 0.2 },
  { provider: "google", model: "gemini-2.5-pro", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 0.125 },
  { provider: "google", model: "gemini-2.5-flash", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, cacheReadPerMillionUsd: 0.03 },

  // xAI / Grok 4 family
  { provider: "xai", model: "grok-4.7", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 6.0, cacheReadPerMillionUsd: 0.5 },
  { provider: "xai", model: "grok-4.6", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.0, outputPerMillionUsd: 6.0, cacheReadPerMillionUsd: 0.5 },
  { provider: "xai", model: "grok-4.3", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.25, outputPerMillionUsd: 2.5, cacheReadPerMillionUsd: 0.2 },
  { provider: "xai", model: "grok-4.20", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.25, outputPerMillionUsd: 2.5, cacheReadPerMillionUsd: 0.2 },
  { provider: "xai", model: "grok-code-fast", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0, cacheReadPerMillionUsd: 0.2 },
  { provider: "xai", model: "grok-build-0.1", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0, cacheReadPerMillionUsd: 0.2 },

  // Cursor first-party included models (subscription pool, $0 incremental API fee)
  { provider: "cursor", model: "composer-2", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0, cacheReadPerMillionUsd: 0 },
  { provider: "cursor", model: "composer-1", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0, cacheReadPerMillionUsd: 0 },
  { provider: "cursor", model: "cursor-small", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0, cacheReadPerMillionUsd: 0 },
];

const ALIASES: Readonly<Record<string, string>> = {
  // Anthropic CLI aliases
  opus: "claude-opus-5-5",
  best: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  opusplan: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
  "claude-fable": "claude-fable-5-2",
  "claude-fable-5": "claude-fable-5-2",
  // OpenAI / Codex shorthand
  astra: "gpt-6.2-astra",
  sol: "gpt-6.2-sol",
  luna: "gpt-6-luna",
  terra: "gpt-6.1-terra",
  // Google / AGY shorthand
  argon: "gemini-4-argon",
  carbon: "gemini-4-carbon",
  neon: "gemini-4-neon",
  hydrogen: "gemini-4-hydrogen",
};

/**
 * Normalizes a provider's model id for pricing lookup: lowercases, turns spaces to hyphens ("Gemini 4 Argon"),
 * drops bracket suffixes ("[1m]", "[optimize_for=...]"), drops leading "cursor-" wrapper, strips trailing date
 * snapshots ("-20260514", "-2026-05-14") and effort/speed modifiers ("-high-fast", "-fast", "-thinking"), and
 * expands short CLI aliases ("opus" -> "claude-opus-5-5").
 */
export function canonicalModelId(provider: string, model: string): string {
  let clean = model.trim().toLowerCase();
  // Strip Cursor router bracket parameters (`[optimize_for=...]`), but keep billing-relevant context tier tags such as `[1m]`.
  clean = clean.replace(/\[optimize_for=[^\]]*\]/g, "").trim();
  // Normalize whitespace to hyphens (e.g. "Gemini 4 Argon" -> "gemini-4-argon").
  clean = clean.replace(/\s+/g, "-");
  if (clean.startsWith("cursor-") && clean !== "cursor-small") clean = clean.slice("cursor-".length);
  // Strip trailing date snapshots (-YYYYMMDD or -YYYY-MM-DD).
  clean = clean.replace(/-(?:20\d{2}-?\d{2}-?\d{2})$/, "");
  // Strip billing-neutral effort/thinking suffixes (never strip `-fast`, which may carry a premium rate).
  clean = clean.replace(/-(?:high|medium|low|xhigh|max|thinking)$/, "");
  const aliased = ALIASES[clean];
  if (aliased) return aliased;
  // Normalize dotted Claude minor versions (claude-sonnet-5.5 -> claude-sonnet-5-5).
  if (provider === "anthropic" || clean.startsWith("claude-")) {
    clean = clean.replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, "$1-$2");
  }
  return clean;
}

/**
 * Infers the underlying pricing provider and canonical model id for a router-selected model (such as Cursor's
 * `auto` / `auto-smart` stop-hook `model_id`). `firstPartyCursor` is true for models in Cursor's own subscription
 * pool (Composer, Cursor-hosted Grok), which are exempt from Cursor's third-party token routing surcharge.
 */
export function inferProviderForModel(rawModel: string): { provider: string; model: string; firstPartyCursor: boolean } {
  const lower = rawModel.trim().toLowerCase();
  const canonical = canonicalModelId("", rawModel);
  const cursorPrefixed = lower.startsWith("cursor-") || lower.startsWith("composer");
  if (canonical.startsWith("claude-")) return { provider: "anthropic", model: canonical, firstPartyCursor: false };
  if (canonical.startsWith("gpt-") || canonical.startsWith("o3") || canonical.startsWith("o4") || canonical.includes("codex")) {
    return { provider: "openai", model: canonical, firstPartyCursor: false };
  }
  if (canonical.startsWith("gemini-")) return { provider: "google", model: canonical, firstPartyCursor: false };
  if (canonical.startsWith("grok-")) return { provider: "xai", model: canonical, firstPartyCursor: cursorPrefixed };
  if (lower.startsWith("composer")) return { provider: "cursor", model: canonical, firstPartyCursor: true };
  return { provider: "cursor", model: canonical || lower || "unknown", firstPartyCursor: cursorPrefixed };
}

/** Built-in pricing provider for a known external agent CLI (undefined for routers or custom agents). */
export const AGENT_DEFAULT_PROVIDER: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
  agy: "google",
  gemini: "google",
  grok: "xai",
};
