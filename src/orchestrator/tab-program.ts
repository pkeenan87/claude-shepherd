import { isSessionLog } from "./agent-sweep.js";
/**
 * What differs between a Pi child and an external agent when a model works in a herdr tab outside the ticket runners: the
 * argv, how its spend is ledgered, and what it said last. Shared by "Fix all in a tab" (`review-fix.ts`) and the per-ticket
 * review (`ticket-review-tab.ts`); each says which job, tier and ticket the rows are ledgered under.
 */
import { mkdirSync } from "node:fs";
import { agentCommand, TRUST_PROMPTS, type TicketModel, type TrustPrompt } from "../agents.js";
import type { CostRecord, Phase } from "../domain.js";
import { lastAssistantText, ledgerChildSession, readChildSession, type ChildSessionFile } from "../herdr/session-file.js";
import { redact } from "../redact.js";
import { createAgentMeter, meteredEntries, notMeteredEntry } from "../runner/agent-usage.js";
import { readStatus } from "../runner/pi-ticket.js";
import type { Tab } from "../runner/tab.js";
import { recordAgentUsage } from "./budget.js";
import type { WorkflowContext } from "./context.js";

/** A Pi child is up in seconds; a tab that is not ready after this never started it (as in pi-ticket.ts). */
export const PI_READY_TIMEOUT_MS = 2 * 60_000;

export interface Program {
  argv: string[];
  /** The agent's trust prompt to answer, if it has one (`TRUST_PROMPTS`). */
  trust?: TrustPrompt;
  readyTimeoutMs?: number;
  /** Ledgers whatever the program spent since the last look and returns the rows added. */
  collect(): CostRecord[];
  /** What the model said last. */
  reply(tab: Tab): Promise<string>;
  /** A failure the program itself reported (a Pi child that could not load its providers). */
  failed?(): string | undefined;
}

/** How the program's rows are ledgered. `ticketId` makes them a ticket's (` · ticket <id>`). */
export interface ProgramLedger {
  job: string;
  tier: string;
  phase?: Phase;
  taskId?: string;
  ticketId?: string;
}

/** A Pi model as `pi -ne -e ticket-mode.ts --model …` with its session files in `sessionDir`. The caller checks that Pi can run it. */
export function piProgram(ctx: WorkflowContext, model: Extract<TicketModel, { kind: "pi" }>, input: { sessionDir: string; /** `PI_CHEF_TICKET`, for labels. */ label: string } & ProgramLedger): Program {
  const { sessionDir } = input;
  const statusFile = `${sessionDir}.status.json`;
  mkdirSync(sessionDir, { recursive: true });
  const thinking = model.thinking ? `:${model.thinking}` : "";
  const launched = { provider: model.provider, id: model.id };
  let files: ChildSessionFile[] = [];
  return {
    argv: ["env", `PI_CHEF_TICKET=${input.label}`, `PI_CHEF_STATUS=${statusFile}`, "pi", "-ne", "-e", ctx.ticketModePath!, "--model", `${model.provider}/${model.id}${thinking}`, "--session-dir", sessionDir],
    readyTimeoutMs: ctx.herdrTimings?.readyTimeoutMs ?? PI_READY_TIMEOUT_MS,
    collect: () => {
      files = readChildSession(sessionDir);
      return ledgerChildSession(ctx, files, { model: launched, job: input.job, tier: input.tier, ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.phase ? { phase: input.phase } : {}) });
    },
    reply: async (tab) => lastAssistantText(files) ?? tab.lastText(),
    failed: () => {
      const error = readStatus(statusFile).error;
      return error ? `the Pi child reported: ${redact(error)}` : undefined;
    },
  };
}

/** An external agent in a tab, metered from its log (else one "not metered" row). Call before the tab opens: the log is snapshotted here. */
export function agentProgram(ctx: WorkflowContext, model: Extract<TicketModel, { kind: "agent" }>, input: { home?: string } & ProgramLedger): Program {
  // Advancing the watermark keeps the outside-chef sweep from counting this tab again.
  const meter = createAgentMeter(model.name, { cwd: ctx.git.repoRoot, home: input.home ?? ctx.agentLogHome, onConsumed: (file, offset) => void ctx.store.advanceAgentLog(file, offset, input.job).catch(() => undefined), exclude: (file) => isSessionLog(ctx, file) });
  return {
    argv: agentCommand(model, ctx.config),
    ...(TRUST_PROMPTS[model.name] ? { trust: TRUST_PROMPTS[model.name] } : {}),
    collect: () => {
      const calls = meter?.collect() ?? [];
      const entries = calls.length > 0 ? meteredEntries(model.name, calls) : [notMeteredEntry(model.name)];
      return recordAgentUsage(ctx, { reason: input.job, entries, tier: input.tier, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.phase ? { phase: input.phase } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) });
    },
    reply: (tab) => tab.lastText(),
  };
}
