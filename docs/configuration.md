# Configuration

Two YAML files, both optional:

| File | Scope |
|---|---|
| `~/.claude/shepherd.yaml` (or `.yml`) | Yours, for every project. Start from the commented template `templates/shepherd.yaml`, or `shepherd migrate-config` from a pi-chef config. |
| `.shepherd/config.yaml` (or `.yml`) | The project's, committed. Sample: `templates/project-config.yaml`. |

- The user file is the base. A section the project file sets **replaces** your whole section; there are no per-key rules.
- `local`, `agents`, `pricing` and `workspaceDir` are read from the user file only. A project value is ignored with a warning.
- If both `.yaml` and `.yml` exist, `.yaml` wins and a warning names the other.
- Changes apply to the next command. An invalid value, a secret, or unreadable YAML rejects the whole file, and the command says which file and why.
- Never put a key or token in either file; a value that looks like a secret is refused.
- A key this version does not read (including settings from pi-chef) is ignored, and one warning lists it (the herdr panel and `shepherd migrate-config` show it). **`review.maxDiffChars` and `review.maxChunks` are now such keys**: they sized the one-shot calls of pi-chef's Pi extension, and a review now runs in a sub-agent that reads the diff itself. `shepherd migrate-config` drops them.
- A YAML value with `[` or `]` in it needs quotes inside a `{ ... }` mapping, and is safest quoted everywhere: `medium: "agent:cursor-agent/auto-smart[optimize_for=balanced]"`.

## models

Which model builds a ticket of each difficulty, and which reviews. The session you chat with (and that plans, with `/shepherd:plan`) is whatever Claude Code runs.

| Key | Default | Meaning |
|---|---|---|
| `low` | `xai/grok-4.7` | Builds `low` tickets (mechanical, well specified). |
| `medium` | `anthropic/claude-sonnet-5-5` | Builds `medium` tickets (typical feature work). |
| `high` | `openai/gpt-6.1-sol` | Builds `high` tickets (cross-cutting, tricky, risky). |
| `review` | `anthropic/claude-opus-5-5` | Reviews each ticket in `/shepherd:build` and runs the model pass of `/shepherd:review`. |

A value is one of:

- `agent:<name>` or `agent:<name>/<model>`, an external coding agent run in a herdr sub-agent (see [agents](#agents)). The `/<model>` part needs the agent to have a `modelFlag` and is everything after the first `/`, passed to the agent as one argument: `agent:cursor-agent/auto-smart[optimize_for=balanced]` runs `cursor-agent --auto-review --model 'auto-smart[optimize_for=balanced]'`. Whitespace is refused.
- `provider/id`, a model run by a `pi` worker (Pi's own login, or the `local` server: `local/<id>`). A trailing `:high`, `:low`, ... sets Pi's thinking level when it is one of Pi's levels. Needs `pi` on `PATH`; see [providers.md](providers.md).

A failed ticket climbs `low`, `medium`, `high` (a rung naming the same model as the one before is skipped), then the build stops. `review` is an agent or a Pi model, and runs in its own sub-agent that reads the repository.

## local

One OpenAI-compatible server, registered with the `pi` worker as provider `local` (the main Claude Code session never sees it). User file only. Setup: [providers.md](providers.md#local-server).

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | required | `https://...`, or `http://` for localhost / 127.x.x.x / `[::1]` only. |
| `apiKeyEnv` | none | Name of an environment variable holding the server's key. Pi reads it per request. |
| `models` | required, non-empty | List of `{ id, contextWindow, maxTokens? }`. |

`models[]`: `id` has no spaces and is unique; `contextWindow` is an integer >= 4096 and must equal what the server runs; `maxTokens` is an integer >= 1024. The planner keeps tickets for a local model to half its `contextWindow`. A local model without a `pricing` row costs $0.

## agents

External coding agents run in herdr sub-agents. User file only. Each entry overrides a built-in key by key, or adds a new agent.

| Key | Meaning |
|---|---|
| `run` | Argv list that starts the agent. Replaces the built-in command entirely, flags included. |
| `modelFlag` | Flag that selects its model for `agent:<name>/<model>`; must start with `-`. |

Names are letters, digits, `-` and `_`, starting with a letter. Built in (from `src/agents.ts`):

| Agent | Default `run` | `modelFlag` |
|---|---|---|
| `claude` | `claude --permission-mode auto` | `--model` |
| `codex` | `codex --no-daemon --approve-for-me` | `-m` |
| `cursor-agent` | `cursor-agent --auto-review --trust` | `--model` |
| `grok` | `grok --permission-mode auto` | `-m` |
| `agy` | `agy --mode auto` | `--model` |
| `gemini` | `gemini --approval-mode auto_edit` | `-m` |
| `opencode` | `opencode` | `--model` |

**Permissions.** Each agent starts in its auto mode: a classifier (or, for agy, a sandbox) runs safe tool calls such as the ticket's checks, tests and builds without asking, and stops risky ones. A ticket no longer waits at its first shell command, as it did in "accept edits" modes. Checked live on 2026-11-12 as herdr sub-agents for Claude Code, Grok and agy (a safe command ran unasked; `rm -rf .git` was stopped). None uses a "skip all permissions" flag.

- **Codex is the most permissive.** `--approve-for-me` runs commands in Codex's workspace-write sandbox, and a request to leave the sandbox goes to Codex's automatic review instead of to you. Live, a destructive command inside the repo (`rm -rf .git`) ran unasked, as it also did with the old `-s workspace-write -a on-request`. A write outside the repo (`touch ~/x`, explicitly asked for) was approved by the review, where the old flags asked. To be asked again, set `agents.codex.run: [codex, --no-daemon, -s, workspace-write, -a, on-request]`.

- **gemini and opencode have no auto mode**, only approve-everything (`--approval-mode yolo`, `opencode --auto`). They keep their defaults, so they still ask before a shell command: the build prints which sub-agent is waiting. Set `agents.<name>.run` yourself if you want approve-everything.
- **An account without Claude Code's auto mode** sets `agents.claude.run: [claude, --permission-mode, acceptEdits]`.

**Folder trust.** An agent's first run in a folder may ask "trust this folder?". shepherd builds in the repo you run it from, so it trusts that folder for the agent: cursor-agent through `--trust`; agy, grok and codex, which have no such flag, by answering their prompt (only when it shows with "yes" selected; the build prints a line when it does). Claude Code needs nothing: its sub-agents run in the repo your Claude Code session already trusts. Its prompt is never answered for you, since its default is "No, exit".

**Cursor.** `agent:cursor-agent/auto` uses Cursor's `auto` model. When `cursor-agent --list-models` lists `auto-smart`, it also takes `agent:cursor-agent/auto-smart[optimize_for=cost]`, `[optimize_for=balanced]` and `[optimize_for=intelligence]`; the herdr panel offers these. Cursor is **not metered**: its runs count $0 and show as "not metered". The `auto-smart` router needs a Teams or Enterprise plan.

## budgets

Hard stops, in USD. A prompt, ticket or review call does not start at the limit.

Budgets count every priced call: your Claude Code session, Pi-worker models (including subscription logins) and metered agents (Claude Code, Codex) are priced from `pricing`, so with API rates there they count as API-equivalent spend. Raise the budgets, or give a subscription model a row of 0, if that spend should not stop a build. "Not metered" agents count as $0. Claude Code and Codex sessions in the repo that shepherd did not start count too ("outside chef"), from the repo's first sweep on. The Claude Code session you chat in counts through the `Stop` hook.

| Key | Default | Meaning |
|---|---|---|
| `taskUsd` | `20` | One task's spend (> 0). |
| `dailyUsd` | `75` | All spend today (> 0). |
| `softWarningRatio` | `0.8` | Warn at this share of a budget (0 to 1). |
| `unknownCallUsd` | `0.05` | What a call of unknown cost counts as in budget math only (>= 0). The ledger still stores it as unknown. |
| `idleWarnMinutes` | `60` | Idle minutes after the last assistant turn before a message is held back, because the prompt cache has probably expired and the whole context is re-sent; send the same message again within 2 minutes to send it (integer >= 0). `0` turns the warning off. |
| `idleWarnTokens` | `100000` | The idle warning applies only when the context holds at least this many tokens (integer >= 0). `0` turns the warning off. |

## routing

| Key | Default | Meaning |
|---|---|---|
| `maxEscalations` | `2` | Rungs a failed ticket may climb from its difficulty's (integer >= 0). `2` is low to medium to high; a rung skipped because it names the same model still counts. |
| `maxTicketTurns` | `100` | Assistant turns one Pi-worker ticket attempt may take before it is told to wrap up; a few turns later it is stopped and counts as failed (integer >= 5). Agents have no turn limit here. |

## review

| Key | Default | Meaning |
|---|---|---|
| `tickets` | `true` | `false` turns off the per-ticket review in `/shepherd:build`. |
| `model` | `true` | `false` makes `/shepherd:review` run only setup, checks and the static scan. |
| `timeoutMs` | `300000` | How long one per-ticket review turn may take (>= 1000), but never less than 15 minutes. The `/shepherd:review` model pass and a fix run have no limit of their own beyond herdr's turn cap. |

## checks and setup

Lists of `{ name, command, args? }`. Each entry is one command run without a shell (`&&`, pipes, redirects, quotes, `$VARS` and globs do not work; use two entries). Destructive commands (`rm -rf`, force push, `reset --hard`, piping a download into a shell) are refused.

| Key | Meaning |
|---|---|
| `checks` | Default `[]`. Run after each `shepherd build` ticket (a ticket's own `checks` win) and by `shepherd review`. With none configured, `/shepherd:review` uses the distinct checks of the plan's tickets; with neither it fails ("no checks ran"). |
| `setup` | Default `[]`. Runs once per build, and before the checks of every `/shepherd:review`. For an install. |

```yaml
setup:
  - { name: install, command: npm, args: [ci] }
checks:
  - { name: test, command: npm, args: [test] }
```

## pricing

User file only. A list of rows, USD per million tokens. A model with no row has an unknown cost, which budgets count as spend (never as $0); `local/` models are a known $0.

| Field | Meaning |
|---|---|
| `provider`, `model` | Non-empty strings. |
| `effectiveFrom` | `YYYY-MM-DD`. The newest row not after the call's date applies. |
| `inputPerMillionUsd`, `outputPerMillionUsd` | Numbers >= 0. |
| `cacheReadPerMillionUsd`, `cacheWritePerMillionUsd` | Optional, >= 0. |

Two rows for the same provider, model and date are an error. Subscription logins have no per-token cost, so rows for them are 0 ("placeholder"); a key bills per token, so use the provider's rate card. Add a row for every model you use.

## Other keys

| Key | Default | Meaning |
|---|---|---|
| `branchPrefix` | `shepherd` | `shepherd build` names its branch `<branchPrefix>/<task name>` (`-2`, `-3` when taken). Letters, digits, `.`, `_`, `-`, `/`; no trailing `/`, no `..`. |
| `build.visibleTabs` | `false` | `shepherd build`, a review and a fix run each ticket and review as a paneless herdr sub-agent of the terminal they were started from (it shows in herdr's agents list). `true` opens each in its own labelled tab (`herdr.space`, `herdr.tab`) beside that terminal; the terminal then needs a `herdr.space` label. |
| `workspaceDir` | `.shepherd` | Where task state, the ledger and reports live in each project. User file only. |
