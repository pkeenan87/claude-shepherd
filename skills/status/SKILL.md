---
name: status
description: Show a concise dashboard of the active shepherd plan, ticket progress, build/review state, spend, and prompt-cache warmth
allowed-tools: Bash(shepherd status:*), Bash(shepherd plans:*)
---

Run `shepherd status --json` and `shepherd plans` (if there are multiple open tasks) and present a concise status summary:

- **Active task**: name, phase, branch/worktree, and ticket progress (`ticketsDone`/`ticketsTotal` done, any failed or currently running ticket).
- **Review & build state**: whether a build is actively running, or if review passed / has open findings.
- **Spend & budget**: task spend vs limit, today's spend across all repos vs limit, API-equivalent savings if subscription-billed agents were used, and soft/hard budget warnings.
- **Session context**: token count and prompt-cache warmth (`warm` vs `cold`) when available.
- **Suggested next command**: `/shepherd:plan`, `/shepherd:build`, `/shepherd:review`, `/shepherd:ship`, or `/shepherd:cleanup`.
