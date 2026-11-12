import { modelText, parseTicketModel, type TicketModel } from "../agents.js";
import type { WorkflowConfig } from "../config.js";
import type { Difficulty } from "../domain.js";
import { NO_PI } from "../runner/pi-path.js";
import { iso, type WorkflowContext } from "./context.js";
import type { LocalLimit } from "./prompts.js";

/** The rungs of the ladder a ticket climbs when it fails: low, then medium, then high, then it stops. */
export const RUNGS: readonly Difficulty[] = ["low", "medium", "high"];

/** The model that builds tickets of this difficulty (`models.low`, `models.medium`, `models.high`). */
export function modelFor(config: WorkflowConfig, difficulty: Difficulty): TicketModel {
  return parseTicketModel(config.models[difficulty], config);
}

/** The next rung up from `rung`, or undefined above high. */
export function escalate(rung: Difficulty): Difficulty | undefined {
  return RUNGS[RUNGS.indexOf(rung) + 1];
}

/**
 * The next rung up whose model differs from the failed rung's. A rung that names the same model (and thinking level)
 * would only repeat the work, so it is skipped. Undefined when nothing above is different.
 */
export function nextRung(config: WorkflowConfig, failed: Difficulty): Difficulty | undefined {
  const from = config.models[failed].trim();
  for (let rung = escalate(failed); rung; rung = escalate(rung)) {
    if (config.models[rung].trim() !== from) return rung;
  }
  return undefined;
}

/** How far up the ladder a ticket has gone, in rungs (counting skipped ones): what `routing.maxEscalations` limits. */
export function climbed(start: Difficulty, at: Difficulty): number {
  return Math.max(0, RUNGS.indexOf(at) - RUNGS.indexOf(start));
}

/**
 * The model the /review model pass uses: `models.review`. It may name an agent (a herdr tab reads the repository);
 * the caller decides what to do with that.
 */
export function reviewModel(config: WorkflowConfig): TicketModel {
  return parseTicketModel(config.models.review, config);
}

/** A model chosen for a job. `blocked` is why it cannot be used right now (Pi does not know it, or holds no credentials). */
export interface Route {
  /** The rung the job runs on; `review` for the review model. */
  rung: Difficulty | "review";
  model: TicketModel;
  label: string;
  blocked?: string;
}

/**
 * Checks that a Pi model can be run: there is a `pi` on PATH, when the host binds that check. An agent is not checked
 * here (a program in a herdr tab); whether Pi knows a model or holds a login is the Pi child's to say.
 */
export function routeFor(ctx: WorkflowContext, rung: Route["rung"], model: TicketModel): Route {
  const label = modelText(model);
  const problem = model.kind === "pi" && ctx.piAvailable && !ctx.piAvailable() ? NO_PI : undefined;
  return { rung, model, label, ...(problem ? { blocked: `${label}: ${problem}` } : {}) };
}

/** Records a `route` event in the task log. */
export async function announce(ctx: WorkflowContext, taskId: string | undefined, purpose: string, route: Route): Promise<void> {
  if (!taskId) return;
  const [provider, model] = route.model.kind === "pi" ? [route.model.provider, route.model.id] : ["agent", route.label.slice("agent:".length)];
  await ctx.store.appendRoute(taskId, { purpose, tier: route.rung, provider, model, reason: route.blocked ?? "", considered: [] }, iso(ctx));
}

/** The context a cloud ticket must fit, in tokens (estimatedContextTokens counts the ticket, its files and about 20K of overhead). */
export const CLOUD_TICKET_TOKENS = 150_000;

/**
 * The difficulties whose model is a `local` model with a context window in the config, with the size a ticket of that
 * difficulty must fit: half the window (the system prompt and tools take the rest). The planner is told these.
 */
export function localLimits(config: WorkflowConfig): LocalLimit[] {
  const out: LocalLimit[] = [];
  for (const difficulty of RUNGS) {
    const model = modelFor(config, difficulty);
    const entry = model.kind === "pi" && model.provider === "local" ? config.local?.models.find((item) => item.id === model.id) : undefined;
    if (entry) out.push({ difficulty, model: `local/${entry.id}`, contextWindow: entry.contextWindow, targetTokens: Math.max(8_000, Math.floor(entry.contextWindow / 2)) });
  }
  return out;
}

/** The context a ticket of this difficulty must fit: half a local model's window, else the cloud target. */
export function contextTarget(config: WorkflowConfig, difficulty: Difficulty): number {
  return localLimits(config).find((item) => item.difficulty === difficulty)?.targetTokens ?? CLOUD_TICKET_TOKENS;
}
