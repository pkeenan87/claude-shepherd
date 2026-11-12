import { readFinding, firstJson, type ParsedFinding } from "./scored-json.js";

/**
 * Reading the /review model pass's answer. The pass itself runs in a herdr sub-agent (`orchestrator/agent-review.ts`),
 * which writes its findings to a file; this is the lenient reader of that file. Advisory by design: nothing here changes `passed`.
 */

export const MAX_FINDINGS = 20;

/** A parsed value that is a findings list: an array holding objects (or empty), or `{"findings": [...]}`. */
function asFindingList(value: unknown): unknown[] | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { findings?: unknown }).findings) ? (value as { findings: unknown[] }).findings : undefined;
  return list && (list.length === 0 || list.some((item) => item && typeof item === "object" && !Array.isArray(item))) ? list : undefined;
}

/**
 * Reads the model's answer leniently: the whole text, a ```json fence, or the first `[ ... ]` (or `{"findings": [...]}`)
 * inside prose that parses as a list of objects; entries with a usable message are kept, with the scores `readScore` could read. Filtering by risk is the caller's, once
 * the parts are merged. Undefined when there is no list.
 */
export function parseModelFindings(text: string): ParsedFinding[] | undefined {
  const list = firstJson(text, asFindingList);
  if (!list) return undefined;
  return list.flatMap((item) => {
    const finding = item && typeof item === "object" && !Array.isArray(item) ? readFinding(item as Record<string, unknown>, ["message"], 300) : undefined;
    return finding ? [finding] : [];
  });
}
