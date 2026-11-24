---
name: build
description: Build the approved shepherd plan one ticket at a time in herdr sub-agents
allowed-tools: Bash(shepherd build:*), Bash(shepherd plan show:*), Bash(shepherd cost:*)
---

You are running a build, not doing it. Each ticket is built by a herdr sub-agent that `shepherd` starts, checks, reviews and commits itself. All policy (model per ticket, escalation, budget, review gate, commits, branch) lives in the `shepherd` CLI.

A ticket can take longer than the Bash tool's 10-minute foreground limit, so build one ticket per command, in the background:

1. Run `shepherd build --once --json` with the Bash tool and `run_in_background: true`. If the plan is not approved or nothing is planned, `shepherd plan show` shows where it stands; send the user to `/shepherd:plan`.
2. Wait for it to finish; you are notified. Do not poll, sleep, or run anything else against the repo meanwhile.
3. Read the JSON: `ok`, `code`, `text`, and `data` (`ticket`, `outcome`, `done`, `ticketsDone`, `ticketsTotal`, `ticketsFailed`, `branch`, `taskSpentUsd`, `dailySpentUsd`, `stopped`, `next`, `report`). Relay `text` to the user verbatim and briefly, always showing progress (`ticketsDone`/`ticketsTotal` done) and running task spend (`taskSpentUsd`).
4. If `data.done` is true, show `data.report` (the build table) and stop. Suggest `/shepherd:review` (and `/shepherd:ship` once review passes).
5. If `ok` is true and `data.done` is false, go back to step 1 for the next ticket (`data.next`).
6. If `ok` is false (`data.outcome` is `stopped`), show `data.stopped` and `data.report`, then stop. Do not fix the code yourself and do not start another run unless the user asks. Recovery options to suggest when a ticket fails review (especially on `high`):
   - Retry once on another model without editing config: `shepherd build --once --with <model> --json` (or swap `models.high` in `~/.claude/shepherd.yaml` and run `/shepherd:build`).
   - Fix the remaining review findings in the working tree, then run `/shepherd:build` (shepherd detects the changed diff and re-runs checks + review).
   - If the user inspected the remaining findings and judges them non-blocking, commit once checks pass with `shepherd build --once --override-review --json` (prompts the user for confirmation; findings carry to `/shepherd:review`).
   - Edit the ticket or plan (`/shepherd:plan`).
   `NEEDS_HERDR` means this Claude Code session is not inside a herdr terminal; `NEEDS_PI` means a Pi-model ticket needs `pi` installed.

While a build is running, never commit, push, switch branches or change worktrees: shepherd owns the branch and every commit. `shepherd cost` shows what the build has spent so far.
