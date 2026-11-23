---
name: ship
description: Verify the branch is ready, generate the PR summary, and optionally push and open a PR after your confirmation
allowed-tools: Bash(shepherd ship:*), AskUserQuestion
---

You are helping the user ship their finished branch cleanly and safely.

1. First run `shepherd ship --json` (read-only preflight). It checks branch state, commits ahead of base, dirty tree, ticket completion, review status, and generates a PR title and markdown body.
2. Relay the preflight summary (`text`) to the user. If `data.ready` is false, list `data.blockers` and stop (suggest fixing them or running `/shepherd:review`).
3. Ask with AskUserQuestion how to proceed:
   - "Push & open PR" (runs `shepherd ship --pr`)
   - "Push & open Draft PR" (runs `shepherd ship --pr --draft`)
   - "Push branch only" (runs `shepherd ship --push`)
   - "Stop here (don't push)"
4. Run the chosen command. Claude Code will ask the user to confirm before pushing or opening a PR; never bypass that confirmation.
5. When done, share the PR URL (if created) and mention `/shepherd:cleanup` to tidy up after the PR merges.
