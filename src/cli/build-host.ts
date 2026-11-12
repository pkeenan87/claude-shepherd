/**
 * The /build driver, free of Pi: every ticket attempt runs as a herdr sub-agent (`hc run`) of the terminal shepherd was
 * started from, through `runTicket` (`runner/ticket.ts`). A Pi model runs as `pi -ne -e ticket-mode.ts` in the tab, an
 * `agent:<name>` ticket as that coding agent. Policy (routing, escalation, budgets, reviews, commits, the build claim) is
 * not here: it stays in `orchestrator/build.ts`, which drives this over the `BuildDriver` interface. Used by `shepherd build`
 * and, until the Pi extension is removed, by `extension.ts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrClient } from "../herdr/client.js";
import type { BuildDriver, ModelRef } from "../orchestrator/build.js";
import type { Workflow } from "../orchestrator/service.js";
import { NO_PI } from "../runner/pi-path.js";
import { ticketHost } from "../runner/host.js";
import type { TabTimings } from "../runner/tab.js";
import { herdrSpace, NEEDS_HERDR, runTicket } from "../runner/ticket.js";
import { redact } from "../redact.js";

export interface BuildHostOptions {
  /** Re-resolved per call: a host may replace the Workflow (Pi does, with its session). */
  getWorkflow: () => Workflow;
  client: HerdrClient;
  /** The checkout the build runs in. */
  cwd: string;
  /** Absolute path of this install's Pi worker extension (`ticketModePath()`). */
  ticketModePath: string;
  /** Replaces the home directory an agent's usage log is read under (tests, the CLI's `home`). */
  home?: string;
  /** Test seam: timings and sleeps of the tab waits. */
  timings?: TabTimings;
  /** Whether a `pi` can be started for a Pi-model ticket. Unset, no such check is made (Pi checks its registry in `modelPreflight`). */
  piAvailable?: () => boolean;
  /** An extra check before a Pi model's ticket opens (Pi's registry): the problem, or undefined. May also warn. */
  modelPreflight?: (model: ModelRef, ticketId: string) => Promise<string | undefined> | string | undefined;
  /** Runs after anything is ledgered (a host redraws its status line). */
  changed?: () => void;
}

/** The driver. It never throws: a ticket that cannot run is `{ stopped }`. */
export function createBuildDriver(options: BuildHostOptions): BuildDriver {
  const { client } = options;
  const visible = () => options.getWorkflow().config.build.visibleTabs;
  const needsHerdr = (problem: string) => `${NEEDS_HERDR} (${redact(problem)})`;
  return {
    // Before the build touches git: /build outside herdr (or without `hc`) starts no ticket and makes no branch.
    async preflight() {
      const where = await herdrSpace(client, visible());
      return "problem" in where ? needsHerdr(where.problem) : undefined;
    },
    async fresh(model, run, ticketId, limits, attempt = 1) {
      if (!model.agent) {
        const problem = await Promise.resolve(options.modelPreflight?.(model, ticketId)).catch((error: unknown) => `${model.provider}/${model.id} could not be checked: ${redact(error instanceof Error ? error.message : String(error))}`);
        if (problem) return { stopped: `Ticket ${ticketId} cannot start on ${problem}. Fix the models config or sign in, then /build again.` };
        if (options.piAvailable && !options.piAvailable()) return { stopped: `Ticket ${ticketId} cannot start on ${model.provider}/${model.id}: ${NO_PI}. Then /build again.` };
      }
      const where = await herdrSpace(client, visible());
      if ("problem" in where) return { stopped: needsHerdr(where.problem) };
      const workflow = options.getWorkflow();
      return runTicket(
        {
          ...options.timings,
          client,
          ...(where.space ? { space: where.space } : {}),
          cwd: options.cwd,
          ticketId,
          attempt,
          model,
          limits,
          config: workflow.config,
          ticketModePath: options.ticketModePath,
          ...(options.home ? { home: options.home } : {}),
          host: ticketHost(options.getWorkflow, options.changed),
        },
        run,
      );
    },
  };
}

/**
 * Absolute path of the Pi ticket-worker extension of this install, found from the module's own location. A plugin install
 * has no node_modules, so the bundle `<plugin>/dist/ticket-mode.mjs` (`npm run bundle`: src modules and `yaml` inlined, Pi's
 * own packages left external) is preferred when it exists; a source checkout falls back to `src/ticket-mode.ts`. Both sit under the
 * package root that `dist/shepherd.mjs`, `build/cli/build-host.js` and `src/cli/build-host.ts` are all one or two levels below.
 */
export function ticketModePath(from: string | URL = import.meta.url): string {
  const start = path.dirname(typeof from === "string" && !from.startsWith("file:") ? from : fileURLToPath(from));
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [path.join(dir, "dist", "ticket-mode.mjs"), path.join(dir, "src", "ticket-mode.ts")]) if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.dirname(start), "src", "ticket-mode.ts");
}
