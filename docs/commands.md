# Commands

Five slash commands, backed by the `shepherd` CLI. A skill tells Claude Code which CLI calls to make; every rule (validation, redaction, ticket sizing, phases, budgets, approval, commits) is in the CLI, and Claude Code only fills the schemas it prints. Nothing here pushes, opens a pull request or merges. Do that yourself.

| Command | Effect |
|---|---|
| `/shepherd:plan <request>` | Interview, spec, tickets, then approve. Edits nothing. |
| `/shepherd:plans [<name> \| close <name> \| --all]` | List, switch to, or close tasks. |
| `/shepherd:build` | Build the approved plan, one ticket at a time, one commit each, in herdr sub-agents. |
| `/shepherd:review [--with <model>]` | Checks, static scan and a model pass on the branch diff; offers to fix findings. |
| `/shepherd:cost` | Spend by model, job and task against the budgets. |

## The CLI

```text
shepherd version
shepherd cost [--json]
shepherd status [--statusline]                    one line: plan, plan spend, today's spend (--statusline reads Claude Code's status line JSON)
shepherd statusline-install [--force]             puts that line in Claude Code's status line (~/.claude/settings.json)
shepherd plan <start|spec|tickets|show|revise|approve> ...
shepherd plans [<name> | close <name> | --all]
shepherd task <list|use <name>|close [<name>] [--force]>
shepherd build [--once] [--json]
shepherd review [--with <model>] [--json]
shepherd fix <--tab|--list> [--json]
shepherd hook <stop|prompt|pretool>               the plugin's hooks; reads hook JSON on stdin
shepherd migrate-config [--force] [--json]
```

`--json` prints one `{ok, code?, text, data?}` document. A failed command exits 1. A hook never fails: any error is one stderr line and exit 0, except where it blocks by its JSON output.

## /shepherd:plan

`plan start "<request>"` opens a task, and prints the spec schema, the ticket rules and the ticket schema. Claude Code then:

1. **Explores** the code that will change, read-only, and looks up facts itself.
2. **Interviews** you with AskUserQuestion, only on decisions the code cannot answer: at most 7 questions in all, 2 to 4 options each, the recommended one first. A clear request skips the interview; what would have been asked becomes assumptions in the spec. Your answers go into the spec's `decisions`.
3. **Saves the spec** with `plan spec`: a technical plan (context, approach, files to change, reuse, decisions, assumptions, risks, verification) with the planner's rating of complexity and risk. Nothing scans the request for keywords; the rating is the planner's.
4. **Saves the tickets** with `plan tickets`: vertical slices, each with a difficulty (`low`, `medium`, `high`), implementation steps, acceptance criteria and `checks`. The CLI rejects, and lists every problem at once: a duplicate id, a missing blocker, a cycle, a ticket without acceptance criteria, a ticket too big for its model's context (150000 tokens, or half the `contextWindow` of a local model), and a check that has shell syntax, is destructive, or is not a command on `PATH`.
5. **Writes and shows** the plan. `plan tickets`, `plan show` and `plan approve` write the whole plan to `_plans/<task>.md` at the repo root, to read in herdr's Files panel or an editor; the folder has its own `.gitignore` (`*`), so plans never land in a ticket's commit or a review. The chat gets the path and the ticket table (`plan show`), then asks Approve, Change something, or Stop. Approving runs `shepherd plan approve`, which Claude Code asks you to confirm whatever a skill allows; that confirmation is the approval. `plan revise "<changes>"` sends the draft back for a full revised spec and tickets. `shepherd build` refuses a plan with no recorded approval.

Every request starts a new task: a finished active task is closed, an unfinished one is parked (`/shepherd:plans <name>` brings it back). `plan start` with no request resumes the plan in progress. Files go under `.shepherd/tasks/<id>/`: `plan.md`, `spec.md`, `interview.json`, `tickets/NN-slug.md`.

## /shepherd:plans

One request is one task, named from the request (`retry-ingest-parser`). The active task is the one whose build branch is checked out; otherwise the last one you created or switched to.

- `shepherd plans` lists open tasks, newest first, with the active one marked. `--all` adds closed ones.
- `shepherd plans <name>` (a name, id or unique prefix) makes it active.
- `shepherd plans close <name>` closes a task; when work is unbuilt it declines, and `shepherd task close <name> --force` closes it anyway. Files and branches are kept, and closing clears the task's build-in-progress marker.

## /shepherd:build

Runs the approved tickets in dependency order. It refuses an unapproved plan, a plan with no tickets, and a spent budget. Run it again to resume: done tickets are skipped. The skill runs `shepherd build --once --json` in the background, one ticket per call (a foreground Bash call is limited to 10 minutes), relays the result and runs it again until `data.done`. `shepherd build` with no `--once` builds every ticket in one process.

**Needs herdr.** Claude Code must run in a [herdr](https://herdr.dev) terminal with `hc` working; otherwise the build stops (`NEEDS_HERDR`) before it touches git. Every ticket and its review run as `hc run` children of that terminal: paneless sub-agents in herdr's agents list, or labelled tabs with `build.visibleTabs`.

**Branch.** A fresh build creates `<branchPrefix>/<task name>` in the current checkout, from the default branch (`origin/HEAD`, else `main` or `master`). Uncommitted changes refuse the build (`DIRTY_TREE`). One build runs a task at a time (`BUILD_RUNNING`).

**Build in progress.** A build sets a marker for the task when it starts and clears it when it is done or stopped (a ticket that stops it, a signal, or closing the task). While the marker is set, or a ticket is running, the `PreToolUse` hook denies `git push`, branch switches and `git worktree` changes from Claude Code's Bash tool. A run that never starts (no herdr, a refused start such as a dirty tree or a spent budget) leaves the marker as it was. If a build was killed hard and left it set, run `shepherd build` again, or `shepherd task close <name> --force`.

**Per ticket:**

1. **Route.** The ticket goes to `models.low`, `models.medium` or `models.high` by its difficulty. A Pi model needs `pi` on `PATH` (`NEEDS_PI`).
2. **Run.** A Pi model runs as a `pi` of its own (with a ticket extension that applies the turn limit, the bash rules and your `local` provider). An agent (`agent:claude`) is that CLI: shepherd types the ticket in with "do not commit" and a file to write its summary and acceptance-criteria checklist to, waits for the turn, and waits while it is blocked on an approval from you (it prints which sub-agent is waiting). shepherd reads the summary file (else the tail of the screen). A commit the agent makes anyway is undone (`git reset --soft`); an agent that switched to another branch stops the ticket, and HEAD is left as it is. New files an agent leaves under `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.opencode/` or `.grok/` are not committed. A passed ticket's sub-agent is closed; a failed one stays to read. A Pi ticket's bash tool blocks `git push`, branch switches and `git worktree` changes.
3. **Checks.** `setup` runs once per build, then the ticket's `checks` (else `config.checks`). A failure sends the output tail back to the same sub-agent for one retry. A check that cannot run fails the ticket without blaming the model.
4. **Review.** With `review.tickets` on, `models.review` runs in its own sub-agent, reads the ticket and its diff (`git diff HEAD`) and writes findings to a file. Each finding is rated 1 to 10 for likelihood and severity; risk is the product, shown as `L7×S8=56`. Risk below 5 is dropped. A finding with risk 20 or more fails the ticket (one fix round, then it fails); lower ones are saved and listed as "carried from build" in the first `/shepherd:review` after the ticket was built. A review that cannot run, or edits the tree, is recorded as unavailable and the ticket is committed with a warning.
5. **Commit.** The whole tree (the `.shepherd/` workspace excepted) is committed as `<id>: <title>` and the ticket file is marked done. A ticket with no checks is committed with a warning.

A failed ticket climbs to the next rung with a different model (a rung naming the same model is skipped but counts as climbed; up to `routing.maxEscalations` rungs) and stops the build when none is left. A hand fix in the chat is re-checked and reviewed on the next build and committed if it passes.

Spend is ledgered per ticket. Claude Code and Codex are metered from their own logs as API-equivalent cost; other agents show as "not metered" in `/shepherd:cost`. One line per finished ticket is appended to `.shepherd/metrics/tickets.jsonl`. The result has a line per ticket and, at the end, a table.

## /shepherd:review

Reviews what differs from the base (the build's recorded base, else the default branch): commits ahead of the merge-base plus uncommitted and untracked changes. Works after `/shepherd:build`, after chat fixes, or with no task (the report goes under `.shepherd/reports/`). With nothing changed it says so and stops. With an active task, Claude Code and Codex use in the repo that shepherd did not start is counted first.

1. `setup`, then the checks (`config.checks`, else the plan's ticket checks).
2. A static scan of the added lines (secrets, auth bypass, `eval`, TODO/FIXME).
3. A model pass (`models.review`, off with `review.model: false`) in a herdr sub-agent that runs `git diff <merge-base>` itself and writes scored findings; those below risk 5 are dropped. Without herdr this stage is skipped and the report says so.

`passed` means at least one check ran, all exited 0, and the scan found nothing blocking; the model pass is advisory and never changes it. A blocking review is `REVIEW_BLOCKING` with exit 1. The report (also saved as `reports/review.md`) has the stage table, checks, numbered findings, and the plan's tickets.

**Fixing.** The skill asks what to do with the findings. `shepherd fix --tab` runs `models.medium` (a Pi model or an agent) in its own sub-agent: it fixes the findings in your working tree, then closes, and the result shows what it reported. Its spend is ledgered as "review fix" (an agent not metered shows as such), so your main session never pays for it. Nothing is committed: a commit the fixer makes anyway is undone with `git reset --soft`, and a branch switch is left alone and reported; a failed fix leaves its sub-agent open. `shepherd fix --list` prints the numbered findings with the rules, for Claude Code to fix in the chat.

`shepherd review --with <provider/id | agent:name[/model]>` reviews with another model for this run (it also runs the model pass when `review.model` is false).

## /shepherd:cost

Spend by model, job and task against the budgets. Claude Code and Codex use in this repo that shepherd did not start (for example `hc run claude` from the chat) is counted first, under the job "outside chef"; it starts counting when the repo is first swept, or when a task is created. A cost that could not be priced shows as unknown, never $0. `shepherd cost --json` prints the same as data.

**Idle warning.** The `UserPromptSubmit` hook holds back a message sent after `budgets.idleWarnMinutes` idle minutes (default 60) into a context of at least `budgets.idleWarnTokens` tokens (default 100000), because the prompt cache has probably expired. It says what re-sending costs at the model's cache-write price when `pricing` has a row for it. Send the same message again within 2 minutes to send it anyway; `/clear` starts fresh and the task resumes from the branch. `/` commands are never held. Set either value to `0` to turn it off.

## Hooks

Installed by the plugin (`hooks/hooks.json`):

- **Stop** ledgers the new turns of the session's transcript and records its context size for the idle check.
- **UserPromptSubmit** blocks a prompt at a hard budget, warns once per task per day at a soft one, and holds back a prompt after a cold, big chat (above).
- **PreToolUse (Bash)** denies `git push`, branch changes and `git worktree` during a build; denies `shepherd build|review|fix` and `hc run` over budget; and asks you to confirm `shepherd plan approve`.

## Other setup commands

- `shepherd migrate-config`: copies `~/.pi/agent/chef.yaml` (or `.yml`) to `~/.claude/shepherd.yaml` when that does not exist, drops the settings shepherd does not read and says which, and checks the result with the config loader before writing. `--force` replaces an existing file after copying it to `shepherd.yaml.bak` (then `.bak.2`, and so on; an older backup is never overwritten). An older pi-chef file that routes with `tiers` has the first model of `ticketLow`, `ticketMedium`, `ticketHigh` and `premium` carried over to `models.low`, `medium`, `high` and `review` (where `models` names none), and `providers.local` with the `local` tier's models to `local`; `localMode` becomes a note, since shepherd has no local mode. When nothing else of the file applies, the result is the commented template with those settings at the end. The pi-chef file is left where it is.
- `node bin/shepherd-config.mjs`: the JSON CLI behind the herdr panel; see the [README](../README.md#herdr-panel).
