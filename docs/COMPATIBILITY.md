# Compatibility

What claude-shepherd depends on outside this repo, and what has been run live. "Verified live" means a person ran it against the real service; everything else is covered only by tests with fakes. Nothing is listed as verified that was not.

## Verified live

Run on a scratch repo with real herdr and Claude Code:

- The `/shepherd:plan` flow with the approval question.
- `/shepherd:build` with an agent ticket and the per-ticket review sub-agent.
- `/shepherd:review`.
- Fix all in a tab, with `agent:claude`: the sub-agent opened, a Bash approval showed it as blocked until answered, the fix finished, one "review fix" row was ledgered from Claude Code's log, the tab closed, nothing was committed.
- A budget block.
- Session ledgering from the `Stop` hook.

## Unverified live

Unit tests cover the code around these with fakes; none ran against a live service.

- The idle warning in a live Claude Code session (the held-back prompt, the same-message resend within 2 minutes).
- The `PreToolUse` denies in a live session (`git push`, branch switches, `git worktree` during a build; `shepherd build|review|fix` and `hc run` over budget).
- Pi-model tickets and reviews: `pi -ne -e dist/ticket-mode.mjs` as a herdr sub-agent, its session files, the turn limit and the steer at it, and the `local` registration (Qwen 3.8 27B preset) against a live llama-server.
- Codex as a ticket builder or reviewer: its default command, the rollout files as the meter reads them, and that they are flushed when the agent reports idle.
- Cursor: `cursor-agent --auto-review` as a ticket builder or reviewer, `--model 'auto-smart[optimize_for=balanced]'` accepted by a real `cursor-agent` and passed through `hc run` as one argument, and `auto-smart` appearing in `--list-models` (the router needs a Teams or Enterprise plan; the machine this was written on does not list it). Not metered either way.

Also not yet run live, from the phases after the ones above: the build-in-progress marker held between `shepherd build --once` runs, `shepherd migrate-config` on a real pi-chef config, and the herdr panel's rendering (including the Cursor buttons) and layout docking in a live herdr app. The panel's mod passes `herdr-app check`, and `shepherd herdr-install` was run against a scratch app home, not a real one.

## Claude Code plugin

| Need | What | Where |
|---|---|---|
| Plugin | `.claude-plugin/plugin.json`, `marketplace.json` (the plugin name must not start with `claude-`), `skills/<name>/SKILL.md`, `hooks/hooks.json`; `claude plugin validate .` | repo root |
| Commands | the skills `plan`, `build`, `review`, `cost`, `plans`, namespaced as `/shepherd:<name>` | `skills/` |
| Hooks | `Stop`, `UserPromptSubmit`, `PreToolUse` (Bash), each running `node ${CLAUDE_PLUGIN_ROOT}/dist/shepherd.mjs hook <kind>`; JSON on stdin, JSON on stdout to block | `hooks/hooks.json`, `src/cli/shepherd.ts` |
| CLI | `bin/shepherd` (on `PATH` in Claude Code's Bash tool) imports the committed bundle `dist/shepherd.mjs` | `bin/`, `dist/` |
| Transcript | `transcript_path` in the hook JSON; `type: "assistant"` lines carry `message.id`, `message.model`, `message.usage` | `src/runner/agent-usage.ts` |
| Status line | not settable by a plugin; the README gives a `statusLine` snippet running `shepherd status` | README |

Claude Code writes its transcript asynchronously, so `Stop` can miss the last turn; the next `Stop`, or `/shepherd:cost`, reads it from the same watermark and counts it once.

## Pi worker

Pi is only the worker for Pi-model and local-model tickets, reviews and fixes. `src/ticket-mode.ts` is the one extension Pi loads (`pi -ne -e <plugin>/dist/ticket-mode.mjs --model provider/id[:thinking] --session-dir <dir>`); it is bundled with `yaml` inlined and Pi's own `@earendil-works/*` packages and `typebox` left external. Read from the published `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.2.0 packages (`dist/*.d.ts` and `docs/`); they are dev dependencies for types and for the ticket-mode tests.

| Need | API | Where |
|---|---|---|
| Local provider | `pi.registerProvider("local", { name, baseUrl, api: "openai-completions", apiKey, models })` at load | `src/providers/runtime.ts` |
| Block a tool | `pi.on("tool_call")` returning `{ block, reason }` (destructive bash; `git push`, branch switches and worktree changes); `user_bash` for commands typed in the child | `src/ticket-mode.ts`, `src/sandbox.ts` |
| Turn budget | `agent_start`, `message_end`/turn events, `pi.sendMessage` to steer once, `ctx.abort()` after the grace turns | `src/ticket-mode.ts`, `src/orchestrator/turn-budget.ts` |
| Status | writes `{turns, turnLimit, aborted}` to `PI_CHEF_STATUS` after each assistant turn | `src/ticket-mode.ts` |

Environment of the child: `PI_CHEF_MAX_TURNS`, `PI_CHEF_STATUS`, `PI_CHEF_TICKET` (the names are kept from pi-chef). From `ProviderConfig` and Pi's `docs/models.md`: `apiKey` is a literal, `$ENV_VAR`, or `!command`, and is required when defining models; shepherd passes `$<apiKeyEnv>` when named, else the placeholder `local`. Pi 1.2.0 declares `node >= 22.19.0`.

### Pi session files

`src/herdr/session-file.ts` reads the files a Pi child writes in its `--session-dir` (Pi 1.2.0 `SessionManager`):

- One `<timestamp>_<sessionId>.jsonl` per session, appended; the file appears once the session holds a message, so a reader can meet a missing file or a half-written last line.
- Line 1 is `{type: "session", version: 3, id, timestamp, cwd}`. Other entries have `type`, `id`, `parentId`, `timestamp`.
- `{type: "message", message}`: an assistant message has `provider`, `model`, `usage` `{input, output, cacheRead, cacheWrite, totalTokens, cost: {...}}` and `stopReason`.
- `{type: "usage", kind, provider, model, usage}` records Pi's own calls (cache warming); `compaction` and `branch_summary` entries are Pi's own calls too.
- The ledger id is `pi-<sessionId>-<entryId>`; entry ids repeat across sessions, so the session id is part of the key. This is why `usage-message.ts` and `recordPiUsage` stay: the Pi child's rows are ledgered from these files.

## herdr (`hc`)

`src/herdr/client.ts` runs `hc` with argv arrays, never a shell: `run --bg --json --no-notify [--name] [--cwd] [--label k=v] -- argv`, `send --json --wait --timeout <s> <t> -- text`, `wait <t> --json --timeout`, `read <t> --json --lines N`, `get <t> --json` (to find its own space), `kill`. Claude Code must itself run in herdr (the client asks herdr which terminal it is in). A child started from there is recorded with that terminal as its parent and, with no `herdr.space` or `herdr.tab` label, has no pane.

Facts about `hc` checked live (2026-11-08 and 2026-11-09, with Claude Code on Haiku in a herdr sub-agent, from pi-chef's checks):

- `hc send --wait --json` prints `{started, status, turn, wait: {status, turn, reason, ended, exit_code}}`. The top-level `status` is the terminal's state before the send; the turn's outcome is `wait`. The client reads `wait`; an answer with no status is a check-in, followed by `hc wait`.
- `hc send --if idle` refuses a tab that reads `done` (an agent finished a turn and nobody looked), so sends do not use it. Before a send the runner waits until the tab is neither `working` nor `blocked`; `idle` and `done` both count as finished, `blocked` is waited for, `error` or a dead tab stops the ticket.
- Claude Code's first-run "trust this folder?" dialog reports no status at all (not `blocked`). The runner never types before a ready report, and after 20 s tells the person the tab needs them. A new folder asks even when its parent is trusted.
- Herdr's server on macOS runs under launchd with only the system PATH, so every sub-agent is started as `env PATH=<shepherd's PATH> …`.
- `.shepherd` must be in the repo's `.gitignore` for a ticket's commit to work; shepherd makes its workspace ignore itself.

## External agent logs

`src/runner/agent-usage.ts` snapshots the agent's log directory before its sub-agent opens and reads only new or grown files afterwards.

- **Claude Code:** `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<session>.jsonl` (sub-agents in `<session>/subagents/*.jsonl`). `type: "assistant"` lines carry `message.id`, `message.model` and `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`). One message repeats per content block, so each id is counted once.
- **Codex:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Line 1 is `session_meta` with `payload.cwd`; `turn_context` carries `payload.model`; `event_msg` lines with `payload.type: "token_count"` carry the session's cumulative `payload.info.total_token_usage`. `output_tokens` includes reasoning and `input_tokens` includes cached.
- Other agents (Cursor, Antigravity, Grok, Gemini, opencode) are recorded as "not metered".
- Default agent commands were chosen from each CLI's `--help` on 2026-11-08 (claude 2.1.319, codex-cli 0.167.0, cursor-agent 2026.10.01, grok 1.0.77, agy 1.5.3, gemini, opencode): the CLI's own "accept edits" mode where it has one, never a "skip all permissions" flag.
- `cursor-agent --list-models` prints `Available models`, a blank line, then one `<id> - <label>` line per model; shepherd looks for the id `auto-smart` in it.
