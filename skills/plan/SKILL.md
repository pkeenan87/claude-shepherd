---
name: plan
description: Plan a multi-step change with shepherd: interview, spec, tickets rated by difficulty, then your approval
argument-hint: <what to build>
allowed-tools: Bash(shepherd plan start:*), Bash(shepherd plan spec:*), Bash(shepherd plan tickets:*), Bash(shepherd plan show:*), Bash(shepherd plan revise:*), Bash(shepherd plans:*), Bash(shepherd task:*), Read, Grep, Glob, AskUserQuestion
---

You are planning, not building. Do not edit or create files in the repo; use Read, Grep and Glob to look things up. All policy (validation, ticket sizing, approval) lives in the `shepherd` CLI: you fill its schemas and fix what it rejects.

1. Run `shepherd plan start "$ARGUMENTS"`. If `$ARGUMENTS` is empty and a plan is in progress, run `shepherd plan start` with no request to resume it. The output names the task and prints the spec schema, the ticket rules and the exact ticket JSON schema. Follow it.

2. Explore the code that will change, read-only. Look up facts yourself; ask the user only decisions (scope, trade-offs, preferences) that the code cannot answer.

3. If the request is unclear, interview with AskUserQuestion: at most a few questions in total (never more than 7), batched into as few calls as possible. Give 2 to 4 options each, put the recommended option first, and word each question so accepting the recommendation is the easy path. Skip the interview when the request is clear; record what you would have asked as assumptions.

4. Save the spec. Pass the JSON on stdin so no file is needed:

   ```
   shepherd plan spec - <<'JSON'
   { ...spec JSON... }
   JSON
   ```

   Put each interview answer in `decisions`. If it is rejected, fix every problem listed and resend.

5. Save the tickets the same way with `shepherd plan tickets - <<'JSON' ... JSON`, as `{ "tickets": [...] }` per the schema printed by `start`. Vertical slices, each within one context window, `difficulty` on every ticket, `checks` as plain command lines. On an error the CLI lists every problem: fix them all and resend, as many times as needed.

6. Run `shepherd plan show` and show the plan to the user verbatim: the ticket table, the model for each ticket, and every ticket. Do not summarize it away.

7. Ask with AskUserQuestion: "Approve", "Change something", "Stop".
   - Approve: run `shepherd plan approve`. Claude Code will ask the user to confirm it; that confirmation is their approval, so never try to work around it or run it any other way. When it succeeds, say "/shepherd:build runs it."
   - Change something: ask what to change if it is not clear, run `shepherd plan revise "<the changes>"`, redo steps 4 to 7 with the full revised spec and tickets (not a diff).
   - Stop: leave the draft as it is. Say that `/shepherd:plans` lists it and `shepherd plan show` shows it again.

Never run `shepherd plan approve` before the user has chosen Approve, and never start building.
