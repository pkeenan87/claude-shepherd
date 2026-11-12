# claude-shepherd

claude-shepherd is a Claude Code plugin for changes too big for one chat. You describe the work, Claude Code (Opus) plans it and you approve the plan, then every ticket is built by a separate herdr sub-agent on the model that fits its difficulty, checked, reviewed, and committed on its own branch. Every model call is ledgered and priced, and budgets stop spend before it runs away. It never pushes, opens a pull request or merges: that is yours.

It is [pi-chef](https://github.com/pkeenan87/pi-chef) rebuilt as a plugin. Claude Code is the main session; `pi` is only a worker for tickets that run on a Pi model or a local model.

```text
/shepherd:plan <what to build>   interview, spec, tickets rated by difficulty, then your approval
/shepherd:build                  one herdr sub-agent per ticket: checks, review, one commit each
/shepherd:review                 checks, static scan, model review; fix the findings in a tab or here
/shepherd:cost                   spend by model, job and task against the budgets
/shepherd:plans                  list, switch to, or close tasks
```

## Requirements

- [Claude Code](https://claude.com/claude-code), with Node 22 or newer on the machine (the plugin runs `node`).
- [herdr](https://herdr.dev) and its `hc` command. `/shepherd:build`, the model pass of `/shepherd:review` and "Fix all in a tab" start sub-agents with `hc run`, so Claude Code must run in a herdr terminal (`HC_TERMINAL_ID` set, `hc` working). Without herdr, planning, cost and the checks of a review still work; a build stops before it touches git.
- git, and a repository to work in (shepherd's `.shepherd/` workspace in it ignores itself, so it never shows up as untracked files).
- Optional: [`pi`](https://github.com/earendil-works/pi) on `PATH`, for tickets and reviews on a Pi model (`provider/id`) or a local model (`local/<id>`).
- Optional: `codex`, `cursor-agent` (or any other agent in the table in [docs/configuration.md](docs/configuration.md#agents)), installed and signed in, to use them as `agent:<name>` ticket builders or reviewers. Claude Code itself is the default agent (`agent:claude`).

## Install

Inside Claude Code:

```text
/plugin marketplace add pkeenan87/claude-shepherd
/plugin install shepherd@claude-shepherd
```

Or run it from a checkout, for one session:

```bash
git clone https://github.com/pkeenan87/claude-shepherd.git
claude --plugin-dir ./claude-shepherd
```

The plugin ships its built CLI (`dist/shepherd.mjs`, with `yaml` bundled in) and the Pi worker (`dist/ticket-mode.mjs`), so an install needs no `npm install`. Its hooks (`Stop`, `UserPromptSubmit`, `PreToolUse` on Bash) and the `bin/shepherd` command come with it; check with `claude plugin validate .` from the checkout.

## First run

Your settings live in `~/.claude/shepherd.yaml`, for every project. Every setting has a default, so the file is optional. To start from the commented template:

```bash
mkdir -p ~/.claude && cp templates/shepherd.yaml ~/.claude/shepherd.yaml   # from a checkout of this repo
```

`shepherd` is on `PATH` inside Claude Code's Bash tool (the plugin's `bin/`). In your own terminal run it from a checkout (`node dist/shepherd.mjs <command>`, or `npm link` once to get `shepherd`).

Coming from pi-chef? Copy its config instead; it keeps your comments and drops the settings shepherd does not read, and tells you which:

```bash
shepherd migrate-config            # ~/.pi/agent/chef.yaml  ->  ~/.claude/shepherd.yaml (never overwrites)
shepherd migrate-config --force    # replace an existing one; the old file is kept as shepherd.yaml.bak
```

Then add a `pricing` row for every model you use (a model with no row has an unknown cost, never $0), set the models for each difficulty, and the budgets. All of it is described in [docs/configuration.md](docs/configuration.md). Per-project settings go in `.shepherd/config.yaml` (see `templates/project-config.yaml`); that file layers over yours a whole section at a time.

## Commands

| Command | Effect |
|---|---|
| `/shepherd:plan <request>` | Claude Code reads the code, interviews you only on decisions, writes a technical spec and tickets (each rated `low`, `medium` or `high`), and `shepherd` validates them. You approve the plan; Claude Code asks you to confirm, and nothing builds without it. |
| `/shepherd:build` | Builds the approved tickets in dependency order, one commit each, on `<branchPrefix>/<task name>` cut from the default branch. |
| `/shepherd:review` | Runs your setup commands and checks, a static scan, and a model review in a sub-agent; writes a numbered report. Offers to fix the findings: in a tab on `models.medium` (cheaper than this chat), or here. |
| `/shepherd:cost` | Spend by model, job and task, against the budgets. |
| `/shepherd:plans` | List open tasks, switch to one, or close one. |

The same work is available as a CLI (`shepherd plan|build|review|fix|cost|plans|task|status`, mostly with `--json`); the skills call it. Details: [docs/commands.md](docs/commands.md).

## How a build works

A ticket goes to `models.low`, `models.medium` or `models.high` by its difficulty. A failed ticket climbs to the next model (`routing.maxEscalations` rungs) and the build stops when none is left. After a ticket's checks pass, `models.review` reads its diff in a second sub-agent and scores each finding 1 to 10 for likelihood and severity; a finding with risk of 20 or more sends the ticket back once, then fails it. shepherd, not the agent, makes every commit.

**Sub-agents.** Each ticket, review and fix runs as `hc run`, a child of the herdr terminal Claude Code is in. It shows in herdr's agents list and has no pane of its own, so your screen stays yours. Set `build.visibleTabs: true` to open each one in a labelled tab beside you instead (the terminal then needs a `herdr.space` label).

**Permissions.** Claude Code starts in auto mode (`claude --permission-mode auto`): a classifier runs safe tool calls, the ticket's checks included, and blocks risky ones. The other agents start in their "accept edits" mode or nearest equivalent: they edit files freely but may stop to ask for approval of a shell command. If your account has no auto mode, set `agents.claude.run` to `[claude, --permission-mode, acceptEdits]`. When one does, `shepherd build` prints a line such as `Ticket 02 is waiting for you in herdr sub-agent <name> (agents list)`. Open that agent in herdr and answer; the build carries on when it does. No agent runs with a "skip all permissions" flag.

**Guards.** While a build is in progress a `PreToolUse` hook refuses `git push`, branch switches and `git worktree` changes from Claude Code's own Bash tool, and a ticket child cannot do them either. "In progress" holds from the first ticket until the build is done or stopped, also between the `shepherd build --once` runs the skill makes. If a build was killed and left the guard on, run the build again to finish or stop it, or close the task (`shepherd task close <name> --force`). Nothing pushes, opens a PR or merges.

## Cost tracking and budgets

- Every call is ledgered in `.shepherd/` and priced from your `pricing` rows. A cost that cannot be priced is unknown and is counted at an estimate in budget math; it is never $0. Claude Code and Codex are metered from their own logs. Other agents, **Cursor included**, are recorded as "not metered" and count $0.
- The `Stop` hook ledgers the turns of your Claude Code session. Claude Code and Codex use in the repo that shepherd did not start (a second window, `hc run claude` from the chat) is counted too, as "outside chef".
- Budgets: `budgets.taskUsd` (default $20) and `budgets.dailyUsd` (default $75, across every repo shepherd has worked in). At 80% a warning shows once; at the limit a prompt is blocked, and `shepherd build`, `review`, `fix` and `hc run` are refused.
- **Idle warning.** A prompt cache lapses while a chat sits idle, so the first message into a big, idle chat re-sends the whole context at full price. After `budgets.idleWarnMinutes` idle (default 60) with at least `budgets.idleWarnTokens` of context (default 100000), the prompt is held back and says what re-sending costs. Send the same message again within 2 minutes to send it anyway, or `/clear` to start fresh; your task resumes from its branch. Set either to `0` to turn it off.

## Status line

A plugin cannot set Claude Code's status line, so add this to `~/.claude/settings.json` if you want spend in it:

```json
{
  "statusLine": { "type": "command", "command": "shepherd status" }
}
```

`shepherd status` prints `shepherd · <task> · task $1.20/$20 · today $3.40/$75` for the repo it runs in. If `shepherd` is not on your `PATH`, use `node /path/to/claude-shepherd/dist/shepherd.mjs status`.

## Herdr panel

An optional side panel in the herdr app edits `~/.claude/shepherd.yaml` for you (models per difficulty, with Cursor's models offered as buttons; the local server; budgets), lists the project's tasks and shows today's and the task's cost by model. Install it from the plugin, with nothing to build:

```bash
! shepherd herdr-install                     # inside Claude Code: the plugin's bin/ is on its Bash PATH
! shepherd herdr-install --layout mine       # dock into another layout of yours
! shepherd herdr-install --no-dock           # copy the mod only
```

From a plain terminal, run the same with node and the plugin's folder: `node <the plugin's folder>/dist/shepherd.mjs herdr-install`. From a checkout of this repo, `npm run herdr:install` bundles and runs it. Run it again after a plugin update to refresh the panel.

`$HERDR_APP_HOME` overrides `~/.config/herdr-app`. herdr places a mod only the first time it sees it, so the install adds the panel to a layout of its own named `shepherd` (made from the layout in use) as a 340 px column on the right edge; it never edits the layouts herdr ships and rewrites. It is idempotent. Switch to it with `herdr-app do layout.switch '{"name":"shepherd"}'`, and optionally bind a toggle in `~/.config/herdr-app/keys.json`:

```json
"ctrl-shift-g": {"command": "layout.toggle", "args": {"id": "shepherd"}}
```

The install copies the mod and the bundled panel CLI into `<herdr app home>/mods/shepherd-config/` and writes `install.json` naming that copy, so the panel does not depend on where the plugin lives (its folder changes on every update). The panel's CLI (`shepherd-config show|set|local-add|local-remove|local-detect|cursor-models|plan-activate|plan-close`) prints one JSON document per command; `set` refuses a stale file (`--expect <sha256>`) and anything that looks like a secret.

**Cursor.** In the model picker, choose the `cursor-agent` agent to see `auto` (`agent:cursor-agent/auto`) and, when `cursor-agent --list-models` lists `auto-smart`, its three router settings: `auto-smart[optimize_for=cost]`, `[optimize_for=balanced]` and `[optimize_for=intelligence]`. The list is read with a short timeout and cached for an hour. Cursor is not metered (it counts $0 and shows as "not metered"), and the `auto-smart` router needs a Teams or Enterprise plan. In YAML, quote a value with brackets: `medium: "agent:cursor-agent/auto-smart[optimize_for=balanced]"`.

## Documentation

- [docs/commands.md](docs/commands.md): each command and the CLI behind it.
- [docs/configuration.md](docs/configuration.md): every setting and its default.
- [docs/providers.md](docs/providers.md): local models, Pi models, external agents.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md): what is verified live and what is not.
- [docs/PLAN.md](docs/PLAN.md): the migration plan and its status.
- [AGENTS.md](AGENTS.md): for people and agents changing this repo.

## Development

```bash
npm install
npm run typecheck && npm test && npm run bundle     # bundle rebuilds dist/, which is committed
claude plugin validate .
```

Tests use fakes for herdr, Pi, agents and the network; nothing in them calls a real service.
