---
name: cleanup
description: Preview and clean up stale git worktrees, merged local/remote branches, closed plan files, and expired session notes
allowed-tools: Bash(shepherd cleanup:*), AskUserQuestion
---

You are helping the user tidy up stale git worktrees, merged branches, closed plan mirrors, and ephemeral shepherd files.

1. First run `shepherd cleanup --dry-run --json` (add `--remote` ONLY if the user specifically asked to clean remote branches too).
2. Show the user the exact preview (`text`): what would be cleaned and what is being kept (unmerged branches, dirty worktrees, active builds).
3. If there is nothing to clean, say so and stop.
4. Ask with AskUserQuestion before deleting anything:
   - "Clean local items now" (runs `shepherd cleanup`)
   - "Clean local + merged remote branches" (runs `shepherd cleanup --remote`, which Claude Code will confirm with you before touching origin)
   - "Cancel"
5. Run the chosen command and report the summary. Never pass `--force` unless the user explicitly asks to discard dirty worktree changes.
