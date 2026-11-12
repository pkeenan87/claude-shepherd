/**
 * `shepherd review [--with <model>] [--json]` and `shepherd fix --tab|--list [--json]`: thin adapters over `Workflow.review`
 * and the fix methods (`orchestrator/review.ts`, `review-latest.ts`). With no `report` listener a review returns its whole
 * markdown report as the result text, and its model pass and every fix run in a herdr
 * sub-agent (a Pi model as a `pi` child). Without herdr the checks and the static scan still run and the report says the
 * model pass needs herdr.
 *
 * `--json`: one document `{ok, code?, text, data?}`. For a review `data` is `{report, findings: [{n, title, file, line, risk}],
 * passed, fixTab}`: `report` the markdown report's absolute path (null when there was nothing to review), `line` null (findings
 * record no line), `risk` the table's label (`L7×S8=56`, or BLOCKING/SUGGESTION), `fixTab` the `models.medium` that "Fix all in
 * a tab" would use, or null when it cannot run here or nothing needs fixing. SIGINT and SIGTERM kill the open tabs and exit 130.
 */
import { modelText } from "../agents.js";
import type { CommandResult, ReviewReport } from "../domain.js";
import { createHerdrClient } from "../herdr/client.js";
import { findingsData } from "../orchestrator/review-latest.js";
import type { Workflow } from "../orchestrator/service.js";
import { redact } from "../redact.js";
import { piOnPath } from "../runner/pi-path.js";
import { tracked, words, type OpenSession } from "./build.js";
import { ticketModePath } from "./build-host.js";
import type { CliIo, CliOptions } from "./shepherd.js";

export const REVIEW_USAGE = "Usage: shepherd review [--with <provider/id | agent:name[/model]>] [--json]";
export const FIX_USAGE = "Usage: shepherd fix --tab [--json]   (fix the latest review's findings with models.medium in a herdr sub-agent; never commits)\n       shepherd fix --list [--json]   (print the findings and rules, to fix them in this chat)";

/** Runs a command that may open herdr tabs: binds the fakeable seams, closes the tabs on a signal, prints the result. */
async function run(rest: string[], io: CliIo, options: CliOptions, open: OpenSession, exec: (workflow: Workflow) => Promise<{ result: CommandResult; data?: unknown }>): Promise<number> {
  const json = rest.includes("--json");
  const progressLines: string[] = [];
  const emit = (result: CommandResult, data?: unknown): number => {
    const text = words(result.text);
    if (json) io.out(`${JSON.stringify({ ok: result.ok, ...(result.code ? { code: result.code } : {}), text, ...(data !== undefined ? { data } : {}) }, null, 2)}\n`);
    else (result.ok ? io.out : io.err)(`${text}\n`);
    return result.ok ? 0 : 1;
  };
  const env = options.env ?? process.env;
  const inner = options.herdr ?? createHerdrClient({ env });
  const { client, open: openTabs } = tracked(inner);
  const piAvailable = options.piAvailable ?? (() => piOnPath(env));
  const progress = (line: string) => {
    const clean = words(redact(line));
    progressLines.push(clean);
    if (!json) io.out(`${clean}\n`);
  };
  const opened = await open({ progress, herdr: client, piAvailable, ticketModePath: options.ticketModePath ?? ticketModePath(), ...(options.runner ? { runner: options.runner } : {}), ...(options.herdrTimings ? { herdrTimings: options.herdrTimings } : {}) });
  if ("problem" in opened) return emit({ ok: false, code: "NO_REPO", text: opened.problem });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let leaving = false;
  const onSignal = () => {
    if (leaving) return;
    leaving = true;
    void Promise.allSettled([...openTabs].map((address) => inner.kill(address))).then(() => exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const { result, data } = await exec(opened.workflow);
    return emit(result, data);
  } catch (error) {
    return emit({ ok: false, code: "ERROR", text: redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!) });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export async function reviewCommand(rest: string[], io: CliIo, options: CliOptions, open: OpenSession): Promise<number> {
  const args = rest.filter((word) => word !== "--json");
  const usage = (): number => {
    if (rest.includes("--json")) io.out(`${JSON.stringify({ ok: false, code: "USAGE", text: REVIEW_USAGE })}\n`);
    else io.err(`${REVIEW_USAGE}\n`);
    return 1;
  };
  if (args.length > 0 && (args[0] !== "--with" || args.length !== 2)) return usage();
  return run(rest, io, options, open, async (workflow) => {
    const result = await workflow.review(args.length > 0 ? `--with ${args[1]}` : "");
    const report = result.data as ReviewReport | undefined;
    // Not a review that ran (nothing to review, no repo, a budget stop): no report.
    if (!report || typeof report !== "object" || !("checks" in report)) return { result, data: { report: null, findings: [], passed: result.ok, fixTab: null } };
    const latest = await workflow.latestReview();
    const findings = findingsData(report);
    const fix = findings.length > 0 ? await workflow.fixModel() : undefined;
    return { result, data: { report: latest?.file ?? null, findings, passed: report.passed, fixTab: fix && "model" in fix ? modelText(fix.model) : null } };
  });
}

export async function fixCommand(rest: string[], io: CliIo, options: CliOptions, open: OpenSession): Promise<number> {
  const args = rest.filter((word) => word !== "--json");
  const mode: "fix-tab" | "fix-list" | undefined = args.length === 1 && args[0] === "--tab" ? "fix-tab" : args.length === 1 && args[0] === "--list" ? "fix-list" : undefined;
  if (!mode) {
    if (rest.includes("--json")) io.out(`${JSON.stringify({ ok: false, code: "USAGE", text: FIX_USAGE })}\n`);
    else io.err(`${FIX_USAGE}\n`);
    return 1;
  }
  return run(rest, io, options, open, async (workflow) => {
    const result = mode === "fix-tab" ? await workflow.fixInTab() : await workflow.fixList();
    return { result, data: result.data };
  });
}
