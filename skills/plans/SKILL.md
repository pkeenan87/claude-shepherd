---
name: plans
description: List shepherd plans for this repo, switch to one, or close one
argument-hint: [<name> | close <name> | --all]
allowed-tools: Bash(shepherd plans:*), Bash(shepherd task:*), Bash(shepherd plan show:*)
---

Run `shepherd plans $ARGUMENTS` with the Bash tool and show its output to the user verbatim.

- No argument lists the open tasks (`--all` includes closed ones). A name switches to that task and shows its plan. `close <name>` closes one.
- If closing is declined because tickets are not built, tell the user and ask whether to close anyway; only then run `shepherd task close <name> --force`.

Keep every table as printed. Add a sentence of your own only if the command fails, and then quote its error.
