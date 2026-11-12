/**
 * Every /build ticket runs in its own herdr tab. `runTicket` picks the runner by what the model is: a Pi model runs as
 * `pi -ne -e ticket-mode.ts` in the tab (`pi-ticket.ts`), an `agent:<name>` ticket runs that coding agent (`agent-ticket.ts`).
 * `herdrFor` is the check both need first: shepherd must itself be inside herdr, and `hc` must work.
 */
import { agentCommand, type AgentsConfig } from "../agents.js";
import type { ChunkLimits, ChunkSession, ModelRef } from "../orchestrator/build.js";
import type { HerdrClient } from "../herdr/client.js";
import { messageOf, type TabTimings } from "./tab.js";
import { runAgentTicket, type AgentTicketHost } from "./agent-ticket.js";
import { runPiTicket, type HerdrTicketHost } from "./pi-ticket.js";

/** The stop message when /build is not running inside herdr (or `hc` is missing). No ticket is started. */
export const NEEDS_HERDR = "/build runs each ticket in a herdr sub-agent; run shepherd from a terminal inside herdr (HC_TERMINAL_ID set, `hc` working) and run /build again.";

/**
 * Why this process cannot start sub-agents, or where to put them. Needs only HC_TERMINAL_ID and a working `hc`; a `space` comes
 * back only with `visible` (`build.visibleTabs`), which then needs the terminal to have a `herdr.space` label. Never throws.
 */
export async function herdrSpace(client: HerdrClient | undefined, visible = false): Promise<{ space?: string } | { problem: string }> {
  if (!client) return { problem: "no herdr client" };
  try {
    const self = await client.self();
    if ("problem" in self) return { problem: self.problem };
    if (!visible) return {};
    return self.space ? { space: self.space } : { problem: `terminal ${self.terminal} has no herdr.space label, which build.visibleTabs needs` };
  } catch (error) {
    return { problem: messageOf(error) };
  }
}

export interface TicketRunInput extends TabTimings {
  client: HerdrClient;
  host: HerdrTicketHost & AgentTicketHost;
  /** The herdr space of shepherd's own terminal, only with `build.visibleTabs`; absent, the ticket runs as a paneless sub-agent. */
  space?: string;
  cwd: string;
  ticketId: string;
  /** The ticket's attempt number, for an agent tab's name. */
  attempt: number;
  model: ModelRef;
  limits?: ChunkLimits;
  /** The config's agents, for the argv of an agent ticket. */
  config: AgentsConfig;
  /** Absolute path of this install's `src/ticket-mode.ts`. */
  ticketModePath: string;
  /** Replaces the home directory an agent's usage log is read under (tests). */
  home?: string;
}

/** Runs one ticket attempt in a herdr tab. Never throws: a failure is `{ stopped }`. */
export async function runTicket(input: TicketRunInput, run: (session: ChunkSession) => Promise<void>): Promise<void | { stopped: string }> {
  const { model } = input;
  if (!model.agent) return runPiTicket(input, run);
  let argv: string[];
  try {
    argv = agentCommand({ kind: "agent", ...model.agent }, input.config);
  } catch (error) {
    return { stopped: `Ticket ${input.ticketId} cannot start: ${messageOf(error)}` };
  }
  return runAgentTicket({ ...input, agent: model.agent, argv }, run);
}
