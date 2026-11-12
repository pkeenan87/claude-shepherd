/**
 * The agent-log sweep: Claude Code and Codex use in this repo that shepherd did not start is ledgered so /cost and the
 * budgets include it: the user's own session (reason "session", with its Claude subagents as "session subagent"; the
 * Stop hook names the transcript), and anything else (reason "outside chef": a session in another window, or one the chat
 * ran with `hc run`). It reads each agent log file from the repo's watermark (`agent-logs.json`, see `AgentWatermark`) to
 * its end and moves the watermark on, under the store's lock because hooks of several sessions run at once. The ticket and
 * review meters advance the same watermark for what they ledger, so nothing is counted twice. The first sweep in a repo
 * only records where every log stands (and `since`): spend before that is not counted. A running build owns the logs, so
 * it is never swept over. Rows go to the active task, or to the session pseudo-task without one. Never throws: a missing
 * or unreadable log is no usage.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentLedgerEntry } from "../runner/agent-usage.js";
import { listAgentLogs, meteredEntries, readAgentLog, repoPathForms } from "../runner/agent-usage.js";
import type { AgentWatermark } from "../storage/store.js";
import { recordAgentUsage } from "./budget.js";
import { active, type WorkflowContext } from "./context.js";
import { formatUsd } from "./format.js";

const AGENTS = [
  { reader: "claude", name: "Claude Code" },
  { reader: "codex", name: "Codex" },
] as const;

export type SweepReason = "session" | "session subagent" | "outside chef";

export interface SweepOptions {
  /** Replaces the home directory the logs are looked for under (tests). */
  home?: string;
  /** The main session's transcript (hooks pass it): its rows are "session", its subagents' "session subagent". */
  transcriptPath?: string;
  sessionId?: string;
  /** Other sessions' transcripts the hooks have recorded (a `/cost` run mid-turn knows no `transcriptPath` of its own). */
  known?: { transcriptPath: string; sessionId: string }[];
}

/** What a sweep counted, per reason. `line` is the chat line for outside-chef use; undefined when there was none. */
export interface SweepSummary {
  counted: Partial<Record<SweepReason, { records: number; knownUsd: number; unknownRecords: number }>>;
  line?: string;
}

/** The agent's log files, plus the session transcript itself when it sits outside the repo's project directory (a session started in a subdirectory). */
function logsOf(reader: "claude" | "codex", home: string, repos: string[], transcript: string | undefined): Map<string, number> {
  const files = new Map(listAgentLogs(reader, home, repos));
  if (reader === "claude" && transcript && !files.has(transcript)) {
    try {
      files.set(transcript, statSync(transcript).size);
    } catch {
      /* no transcript yet */
    }
  }
  return files;
}

/** Records where every agent log stands now, with `since` = now. Nothing is ledgered. */
function initialMark(ctx: WorkflowContext, home: string, transcript: string | undefined): AgentWatermark {
  const files: AgentWatermark["files"] = {};
  const repos = repoPathForms(ctx.git.repoRoot);
  for (const { reader } of AGENTS) for (const [file, size] of logsOf(reader, home, repos, transcript)) files[file] = { offset: size };
  return { since: ctx.now().toISOString(), files };
}

/** Starts the repo's watermark when it has none. */
export function initAgentWatermark(ctx: WorkflowContext, home: string = ctx.agentLogHome ?? homedir()): Promise<AgentWatermark | undefined> {
  return ctx.store
    .withWatermarkLock(() => {
      const existing = ctx.store.readAgentWatermark();
      if (existing) return existing;
      const mark = initialMark(ctx, home, undefined);
      ctx.store.writeAgentWatermark(mark);
      return mark;
    })
    .catch(() => undefined);
}

/**
 * Ledgers what the agents spent in this repo since the watermark, and posts one progress line when some of it was
 * outside chef. Nothing is counted the first time (see above).
 */
export async function sweepAgentLogs(ctx: WorkflowContext, options: SweepOptions = {}): Promise<SweepSummary> {
  const summary: SweepSummary = { counted: {} };
  try {
    const home = options.home ?? ctx.agentLogHome ?? homedir();
    const transcript = options.transcriptPath ? path.resolve(options.transcriptPath) : undefined;
    const sessions = [...(options.transcriptPath && options.sessionId ? [{ transcriptPath: options.transcriptPath, sessionId: options.sessionId }] : []), ...(options.known ?? [])].map((item) => ({ file: path.resolve(item.transcriptPath), dir: path.join(path.dirname(path.resolve(item.transcriptPath)), item.sessionId) + path.sep }));
    const reasonOf = (file: string): SweepReason => {
      const full = path.resolve(file);
      return sessions.some((item) => item.file === full) ? "session" : sessions.some((item) => full.startsWith(item.dir)) ? "session subagent" : "outside chef";
    };
    await ctx.store.withWatermarkLock(() => {
      const mark = ctx.store.readAgentWatermark();
      if (!mark) {
        ctx.store.writeAgentWatermark(initialMark(ctx, home, transcript));
        return;
      }
      // A running build's meters own the logs; whatever was left unread is swept after it ends.
      const state = active(ctx);
      if (state && ctx.store.liveBuildClaim(state.taskId)) return;
      const repos = repoPathForms(ctx.git.repoRoot);
      const notes: string[] = [];
      for (const { reader, name } of AGENTS) {
        const byReason = new Map<SweepReason, AgentLedgerEntry[]>();
        for (const [file, size] of logsOf(reader, home, repos, transcript)) {
          const known = mark.files[file];
          if (known && size <= known.offset) continue;
          const read = readAgentLog(reader, file, { offset: known?.offset ?? 0, since: mark.since, repos });
          if (!read) continue;
          const reason = reasonOf(file);
          byReason.set(reason, [...(byReason.get(reason) ?? []), ...meteredEntries(reader, read.calls)]);
          mark.files[file] = { offset: read.end };
        }
        for (const [reason, entries] of byReason) {
          if (entries.length === 0) continue;
          const records = recordAgentUsage(ctx, { reason, entries, tier: "agent" });
          const known = records.filter((row) => row.actualUsd !== null);
          const usd = known.reduce((sum, row) => sum + (row.actualUsd ?? 0), 0);
          const seen = summary.counted[reason] ?? { records: 0, knownUsd: 0, unknownRecords: 0 };
          summary.counted[reason] = { records: seen.records + records.length, knownUsd: seen.knownUsd + usd, unknownRecords: seen.unknownRecords + records.length - known.length };
          if (reason === "outside chef") notes.push(known.length === records.length && usd > 0 ? `${formatUsd(usd)} of ${name} use` : `${records.length} ${name} call(s) of unknown cost`);
        }
      }
      ctx.store.writeAgentWatermark(mark);
      if (notes.length > 0) {
        summary.line = `Counted ${notes.join(" and ")} in this repo that shepherd did not start (outside chef); it counts toward the budgets.`;
        ctx.progress?.(summary.line);
      }
    });
  } catch {
    /* a sweep never fails its caller */
  }
  return summary;
}
