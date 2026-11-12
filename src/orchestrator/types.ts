import type { CostRecord } from "../domain.js";
import type { WorkflowConfig } from "../config.js";
import type { HerdrClient } from "../herdr/client.js";
import type { TabTimings } from "../runner/tab.js";
import type { GitWorkspace } from "../git/workspace.js";
import type { CheckRunner } from "../review/review.js";
import type { TaskStore } from "../storage/store.js";

export interface WorkflowOptions {
  /** The checkout commands work in: git, checks, project files. */
  cwd: string;
  config?: WorkflowConfig;
  store?: TaskStore;
  now?: () => Date;
  id?: () => string;
  git?: GitWorkspace;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
  progress?: (message: string) => void;
  report?: (markdown: string) => void;
  runner?: CheckRunner;
  herdr?: HerdrClient;
  /** Test seam: timings and sleeps of the herdr tab waits. */
  herdrTimings?: TabTimings;
  /** Absolute path of `ticket-mode.ts` (or the bundled `ticket-mode.mjs`), for a Pi model's ticket, review or fix in a tab. */
  ticketModePath?: string;
  /** Whether `pi` can be started (see `WorkflowContext.piAvailable`). */
  piAvailable?: () => boolean;
  /** Home directory the agent logs are looked for under (default: the user's). */
  agentLogHome?: string;
  /** Main Claude Code sessions the hooks have recorded: their logs are the session's own, never an agent tab's or outside chef. */
  knownSessions?: () => { transcriptPath: string; sessionId: string }[];
  /** Today's records for the daily budget, across repos (default: this repo's ledger). */
  dailyRecords?: () => CostRecord[];
}
