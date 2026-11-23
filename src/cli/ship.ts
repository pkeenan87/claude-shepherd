/**
 * `shepherd ship`: CLI adapter for branch preflight, PR body generation, and confirmation-gated `--push` / `--pr`.
 */
import type { CommandResult } from "../domain.js";
import { done, fail } from "../orchestrator/context.js";
import { runShip, type ShipOptions } from "../orchestrator/ship.js";
import { redact } from "../redact.js";
import type { Workflow } from "../orchestrator/service.js";
import type { CliIo } from "./shepherd.js";

export const SHIP_USAGE = `Usage:
  shepherd ship [--base <branch>] [--remote <name>] [--json]                (read-only preflight + PR title/body preview)
  shepherd ship --push [--base <branch>] [--remote <name>] [--json]         (push branch to remote; confirmation-gated)
  shepherd ship --pr [--draft] [--base <branch>] [--remote <name>] [--json] (push branch and open a PR with gh; confirmation-gated)`;

export async function shipRemoteReason(workflow: Workflow, command: string): Promise<string> {
  const branch = await workflow.git.currentBranch().catch(() => "current branch");
  const wantsPr = /\s--pr\b/.test(command);
  const remoteMatch = /\s--remote\s+(\S+)/.exec(command);
  const remote = remoteMatch?.[1]?.replace(/^['"]|['"]$/g, "") || "origin";
  return wantsPr
    ? `Push branch \`${branch}\` to ${remote} and open a GitHub PR (\`${command.trim()}\`)?`
    : `Push branch \`${branch}\` to ${remote} (\`${command.trim()}\`)?`;
}

export async function shipCommand(
  rest: string[],
  io: CliIo,
  open: () => Promise<{ workflow: Workflow } | { problem: string; code?: string }>,
  execPr?: ShipOptions["execPr"],
): Promise<number> {
  const json = rest.includes("--json");
  const emit = (result: CommandResult): number => {
    if (json) {
      io.out(`${JSON.stringify({ ok: result.ok, ...(result.code ? { code: result.code } : {}), text: result.text, ...(result.data !== undefined ? { data: result.data } : {}) }, null, 2)}\n`);
    } else {
      (result.ok ? io.out : io.err)(`${result.text}\n`);
    }
    return result.ok ? 0 : 1;
  };
  if (rest.includes("--help") || rest.includes("-h")) return emit(done(SHIP_USAGE));
  let base: string | undefined;
  let remote: string | undefined;
  const known = new Set(["--push", "--pr", "--draft", "--json"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (known.has(arg)) continue;
    if (arg === "--base" && rest[i + 1] && !rest[i + 1]!.startsWith("--")) {
      base = rest[++i];
      continue;
    }
    if (arg === "--remote" && rest[i + 1] && !rest[i + 1]!.startsWith("--")) {
      remote = rest[++i];
      continue;
    }
    return emit(fail("USAGE", SHIP_USAGE));
  }
  const opened = await open();
  if ("problem" in opened) return emit(fail(opened.code ?? "NO_REPO", opened.problem));
  try {
    return emit(
      await opened.workflow.ship({
        push: rest.includes("--push"),
        pr: rest.includes("--pr"),
        draft: rest.includes("--draft"),
        ...(base ? { base } : {}),
        ...(remote ? { remote } : {}),
        ...(execPr ? { execPr } : {}),
      }),
    );
  } catch (error) {
    return emit(fail("ERROR", redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!)));
  }
}

export { runShip };
