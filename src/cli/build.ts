/**
 * `shepherd build [--once] [--json]`: a thin adapter from argv to `runBuild` (`orchestrator/build.ts`) with the build driver
 * (`build-host.ts`). Every rule stays in the orchestrator. Without `--once` it builds every ticket, streaming the progress
 * lines to stdout; with `--once` it builds exactly one ticket to its end and reports `{ticket, outcome, done, stopped?, next?, report?}`,
 * so a Claude Code skill can run it in the background, relay the result and loop (a foreground Bash call is limited to 10 minutes).
 *
 * With `--json` stdout is exactly one JSON document whose `text` carries the progress lines and the result line; the lines
 * are not streamed. The build claim is released on every exit path; SIGINT and SIGTERM release it, clear the build-in-progress marker, kill the open tabs and exit 130.
 */
import type { CommandResult } from "../domain.js";
import { createHerdrClient, type HerdrClient } from "../herdr/client.js";
import { modelFor } from "../orchestrator/routing.js";
import { runBuild } from "../orchestrator/build.js";
import { redact } from "../redact.js";
import { piOnPath } from "../runner/pi-path.js";
import { modelText } from "../agents.js";
import type { Difficulty } from "../domain.js";
import { createBuildDriver, ticketModePath } from "./build-host.js";
import { cliText } from "./plan.js";
import type { Workflow, WorkflowOptions } from "../orchestrator/service.js";
import type { WorkflowConfig } from "../config.js";
import type { CliIo, CliOptions } from "./shepherd.js";
import { NO_PI } from "../runner/pi-path.js";

export const BUILD_USAGE = "Usage: shepherd build [--once] [--json]";

/** What the CLI needs from `open()`; passed in so this file does not import shepherd.ts. */
export type OpenSession = (extras: Partial<WorkflowOptions>) => Promise<{ workflow: Workflow; root: string; config: WorkflowConfig } | { problem: string }>;

/** Wraps a client to remember which tabs this build opened and has not closed, so a signal can close them. */
export function tracked(inner: HerdrClient): { client: HerdrClient; open: Set<string> } {
  const open = new Set<string>();
  const client: HerdrClient = {
    ...inner,
    self: () => inner.self(),
    run: async (options) => {
      const address = await inner.run(options);
      open.add(address);
      return address;
    },
    send: (terminal, text, options) => inner.send(terminal, text, options),
    waitIdle: (terminal, options) => inner.waitIdle(terminal, options),
    read: (terminal, lines) => inner.read(terminal, lines),
    keys: (terminal, keys) => inner.keys(terminal, keys),
    kill: async (terminal) => {
      await inner.kill(terminal);
      open.delete(terminal);
    },
  };
  return { client, open };
}

/** The result's text in the CLI's words (`/build` is `/shepherd:build`, `/review` is `/shepherd:review`). */
export function words(text: string): string {
  return cliText(text)
    .replace(/or answer yes when \/shepherd:build asks, so they don't land in ticket 01's commit\./g, "so they don't land in ticket 01's commit.")
    .replace(/Run \/review/g, "Run /shepherd:review")
    .replace(/(?<![\w.])\/review\b/g, "/shepherd:review");
}

export async function buildCommand(rest: string[], io: CliIo, options: CliOptions, open: OpenSession): Promise<number> {
  const json = rest.includes("--json");
  const once = rest.includes("--once");
  const stray = rest.filter((word) => word !== "--json" && word !== "--once");
  const lines: string[] = [];
  const reports: string[] = [];
  const emitResult = (result: CommandResult): number => {
    const text = words(result.text);
    const data = once ? (result.data ?? { outcome: "stopped", done: false, stopped: text }) : { done: result.ok, ...(result.ok ? {} : { stopped: text }) };
    if (json) {
      io.out(`${JSON.stringify({ ok: result.ok, ...(result.code ? { code: result.code } : {}), text: [...lines, text].join("\n"), data }, null, 2)}\n`);
    } else (result.ok ? io.out : io.err)(`${text}\n`);
    return result.ok ? 0 : 1;
  };
  if (stray.length > 0) return emitResult({ ok: false, code: "USAGE", text: `${BUILD_USAGE}` });
  const progress = (line: string) => {
    const clean = words(redact(line));
    lines.push(clean);
    if (!json) io.out(`${clean}\n`);
  };
  const report = (markdown: string) => {
    reports.push(markdown);
    if (!json) io.out(`${words(markdown)}\n`);
  };
  const env = options.env ?? process.env;
  const inner = options.herdr ?? createHerdrClient({ env });
  const { client, open: openTabs } = tracked(inner);
  const piAvailable = options.piAvailable ?? (() => piOnPath(env));
  const modePath = options.ticketModePath ?? ticketModePath();
  const opened = await open({ progress, report, herdr: client, piAvailable, ticketModePath: modePath, ...(options.runner ? { runner: options.runner } : {}), ...(options.herdrTimings ? { herdrTimings: options.herdrTimings } : {}) });
  if ("problem" in opened) return emitResult({ ok: false, code: "NO_REPO", text: opened.problem });
  const { workflow, root } = opened;

  const driver = createBuildDriver({ getWorkflow: () => workflow, client, cwd: root, ticketModePath: modePath, home: options.home, piAvailable, ...(options.herdrTimings ? { timings: options.herdrTimings } : {}) });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let leaving = false;
  const onSignal = () => {
    if (leaving) return;
    leaving = true;
    void (async () => {
      await Promise.allSettled([...openTabs].map((address) => inner.kill(address)));
      try {
        workflow.releaseBuild();
        workflow.endBuild();
      } catch {
        /* a claim whose process ended is taken over by the next build */
      }
      exit(130);
    })();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await workflow.activeTask();
    // Before the build makes a branch: no herdr is NEEDS_HERDR, and a first ticket on a Pi model with no `pi` is NEEDS_PI.
    const unfit = await driver.preflight?.();
    if (unfit) return emitResult({ ok: false, code: "NEEDS_HERDR", text: unfit });
    const noPi = firstTicketNeedsPi(workflow, piAvailable);
    if (noPi) return emitResult({ ok: false, code: "NEEDS_PI", text: noPi });
    return emitResult(await runBuild(() => workflow, driver, { once }));
  } catch (error) {
    return emitResult({ ok: false, code: "ERROR", text: redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!) });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // runBuild releases the claim itself; this covers a throw before or around it.
    try {
      workflow.releaseBuild();
    } catch {
      /* nothing held */
    }
  }
}

/** The NEEDS_PI message when the next ticket would start on a Pi model and no `pi` is on PATH; undefined otherwise or when unknown. */
function firstTicketNeedsPi(workflow: Workflow, piAvailable: () => boolean): string | undefined {
  if (piAvailable()) return undefined;
  try {
    const next = workflow.peekTicket();
    if (!next) return undefined;
    const model = modelFor(workflow.config, next.difficulty as Difficulty);
    return model.kind === "pi" ? `Ticket ${next.id} starts on ${modelText(model)}: ${NO_PI}. No branch was made.` : undefined;
  } catch {
    return undefined;
  }
}
