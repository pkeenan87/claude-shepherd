# claude-shepherd: migration plan

claude-shepherd is pi-chef rebuilt as a **Claude Code plugin**. Claude Code (Opus 5.5) is the main session. Tickets and reviews run as herdr sub-agents (`hc run`), as the Herdr app describes in `~/.config/herdr-app/AGENTS.md`. Pi stays only to run local-model tickets. Everything runs on the developer's machine; there is no server and no shared state.

Source: pi-chef `main` at `318af03`, after PR #34: Fix all in a tab, outside-chef sweep, idle warning.

## Status

Phases 1 to 5 are done. One stacked PR each, in order: #1 skeleton and cost, #2 plan, #3 build, #4 review, #5 panel, `migrate-config`, docs and the removal of the Pi extension. Each keeps tests, typecheck and the bundle green, and `claude plugin validate .` passing.

- Pi is gone from the main session: no extension, commands, plan tools, web tools or one-shot model calls. It remains only as the worker for Pi-model and local-model tickets, reviews and fixes (`src/ticket-mode.ts`, bundled to `dist/ticket-mode.mjs`).
- Added beyond the plan: a build-in-progress marker so the `PreToolUse` guard also holds between `shepherd build --once` runs, and Cursor's `auto` and `auto-smart[optimize_for=...]` models in the panel.
- Not yet verified live: see [COMPATIBILITY.md](COMPATIBILITY.md#unverified-live).

The first two open points below are settled: `dist/` is committed (a plugin install runs it without `npm install`), and the main session's transcript has the shape the Claude parser reads.

## What stays the same

- `/plan` → `/build` → `/review` → `/cost`.
- A model per ticket difficulty (`models.low/medium/high`), escalation on failure, and a per-ticket review gate.
- Every model call ledgered, priced from `pricing`. Unknown cost is never $0.
- Budgets per task and per day. Hard stops, soft warning, idle-cache warning.
- One branch per build, and the tool owns every commit. It never pushes or opens a PR.
- The herdr config panel (`shepherd-config`, was `chef-config`) and `npm run herdr:install`.

## What changes

| pi-chef | claude-shepherd |
|---|---|
| Pi extension (`extension.ts`) is the main session | Claude Code plugin: skills, hooks, and a `bin/shepherd` CLI |
| Workflow logic called in-process by Pi commands | Same logic behind `shepherd <cmd> --json`. Opus runs it with Bash. Policy stays in code, and the model only fills validated input. |
| `/plan` drafts with Pi plan tools and a review screen | Opus drafts the plan and spec, then calls `shepherd plan save` to validate them. Approval is asked with AskUserQuestion and recorded by `shepherd plan approve`. The CLI refuses `build` without a recorded approval. |
| Per-ticket review and the `/review` model pass call models through Pi's registry | Both run in a herdr tab: `models.review` as an agent (Claude/Codex) or a Pi child. This builds on `agent-review.ts`. |
| Main-session turns ledgered by Pi `message_end` | A `Stop` hook runs `shepherd hook stop`, which reads new lines of the Claude transcript (`transcript_path`) through the existing Claude log parser. It shares the agent-log watermark, so the outside-chef sweep never counts the same call twice. |
| Idle warning as a Pi "Send anyway" menu | A `UserPromptSubmit` hook blocks with the reason and estimated cost. Sending the same prompt again within 2 minutes goes through. Hooks can't show a menu. |
| Budget stop before a Pi prompt | `UserPromptSubmit` blocks at the limit. A `PreToolUse` hook denies `shepherd build`/`fix` and `hc run` when over budget. |
| `tool_call` guard in the Pi main session (none existed) | `PreToolUse` on Bash denies `git push`, branch switches and worktree changes while a build is running. |
| Config `~/.pi/agent/chef.yaml` | `~/.claude/shepherd.yaml`, with the same schema minus Pi-only keys. The project file stays `.shepherd/config.yaml`. `shepherd migrate-config` copies the old file across. |
| Workspace `.pi-workflows/` | `.shepherd/` per repo (gitignored). |
| Daily budget read from the repo's own ledger | A user-wide daily ledger in `~/.claude/shepherd/ledger/` as well, so "today" covers all repos. |
| `local` provider registered in the main Pi | Lives only in the Pi ticket-worker extension. |
| Web search/fetch tools | Dropped; Claude Code has its own. |

Live cost in the status line: a plugin can't set the status line. The README gives a `statusLine` snippet that runs `shepherd status`, for anyone who wants it.

## Repo layout

```
claude-shepherd/
  .claude-plugin/plugin.json     # plugin manifest
  .claude-plugin/marketplace.json # so `/plugin marketplace add pkeenan87/claude-shepherd` works
  skills/plan, build, review, cost, plans/   # slash commands; tell Opus which CLI calls to make
  hooks/hooks.json               # Stop, UserPromptSubmit, PreToolUse, SessionStart
  bin/shepherd                   # CLI entry, runs dist/cli.js
  src/
    core/        # from pi-chef: domain, config, cost/ledger, storage, git, routing, tickets, risk, redact, sandbox
    orchestrator/# from pi-chef, minus Pi: machine, build, review, review-fix, agent-sweep, budget, reports
    runner/      # from pi-chef: tab, ticket, agent-ticket, pi-ticket, agent-usage, herdr client
    cli/         # shepherd commands (one per workflow step, all --json) and hook handlers
  pi-worker/     # ticket-mode.ts + local provider: the extension a Pi ticket child loads
  herdr/         # the config panel mod (from pi-chef), pointed at shepherd.yaml
  tests/         # vitest, fakes only, ported from pi-chef
```

Plain TypeScript, Node 22, built to `dist/` and committed for plugin installs, or built in a `SessionStart` setup step. To be decided in PR 1, depending on what plugin installs allow.

## CLI surface (draft)

All commands are deterministic and print JSON with `--json`. The skills read that JSON.

- `shepherd task new <name>` / `list` / `close`
- `shepherd plan save <plan.md> <tickets.json>`: validates tickets (difficulty, checks, context size), redacts, and stores. `plan show`; `plan approve`.
- `shepherd build [--once]`: runs tickets in herdr tabs until done or stopped, streaming one-line progress. Opus runs it in the background and relays the lines.
- `shepherd review`: setup, checks, static scan, then the model pass in a tab. Writes the numbered report. `shepherd fix --tab`: Fix all in a tab.
- `shepherd cost [--today]`, `shepherd status`
- `shepherd hook stop|prompt|pretool|session-start`: hook entry points. They read hook JSON on stdin and never throw.

## Phases (one PR each)

1. **Skeleton and cost.** Repo, plugin manifest, core and ledger ported with their tests, config at `~/.claude/shepherd.yaml`. Hooks for Stop ledgering, the budget block and the idle warning, plus `/cost`. Done when installing the plugin and chatting shows correct costs in `/cost`, and a budget stops a prompt.
2. **Plan.** `/plan` skill, `plan save/show/approve`, task state, approval gating.
3. **Build.** Runner, herdr tabs, agent and Pi tickets, escalation, per-ticket review in a tab, commits, build guards. `pi-worker/` for local models.
4. **Review.** `/review` with the model pass in a tab, Fix all in a tab, and the outside-chef sweep.
5. **Panel and docs.** herdr panel on `shepherd.yaml`, `migrate-config`, README, install guide, compatibility notes. pi-chef's README points to claude-shepherd.

Each phase keeps tests and typecheck green and is checked live once on a scratch repo with real herdr.

## Open points to settle while building

- Whether plugin installs can run a build step, or `dist/` must be committed.
- The exact transcript fields for usage in Claude Code's JSONL. pi-chef's Claude parser already reads them, live-verified with Haiku. Confirm the main session's file is the same shape.
- `Stop` sees the transcript slightly late (Claude Code writes it asynchronously). A turn missed at Stop is caught by the next Stop or by `/cost`, using the same watermark.
