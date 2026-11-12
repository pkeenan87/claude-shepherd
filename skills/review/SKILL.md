---
name: review
description: Review the changes on this branch (checks, static scan, a model review in a herdr sub-agent) and offer to fix the findings
allowed-tools: Bash(shepherd review:*), Bash(shepherd fix:*), Bash(shepherd cost:*), AskUserQuestion
---

You are running a review, not doing it. `shepherd review` runs the setup commands and checks, the static scan, and then the model review in a herdr sub-agent, and writes a numbered report. All policy (which model reviews, budget, risk scores, what passes) lives in the CLI. The model review is advisory: only the checks and the static scan decide `passed`.

1. Run `shepherd review --json` with the Bash tool and `run_in_background: true` (add `--with <provider/id | agent:name[/model]>` only if the user asked for a specific reviewer). A review can take longer than the Bash tool's 10-minute foreground limit. Wait for the notification; do not poll, sleep, or touch the repo meanwhile.
2. Read the JSON: `ok`, `code`, `text`, and `data` (`report`, `findings`, `passed`, `fixTab`). Show `text` to the user verbatim: it is the numbered report. `ok: false` with `REVIEW_BLOCKING` is a review that ran and found blocking problems, not a failed command; any other code (`BUDGET`, `NO_REPO`, `CONFIG`) means it did not run, so show `text` and stop. If the report says the model pass needs herdr, say so briefly: the checks and static scan still ran.
3. If `data.findings` is empty, stop. If `passed` is true, remind the user that pushing and opening the PR are theirs; shepherd never does either.
4. Otherwise ask with AskUserQuestion what to do with the findings:
   - "Fix all in a tab (<data.fixTab>)": the recommended option, and cheaper than this chat because `models.medium` does the work in a sub-agent. Offer it only when `data.fixTab` is not null.
   - "Fix in this chat": you fix them in this session.
   - "Leave them".
5. Tab: run `shepherd fix --tab --json` with `run_in_background: true`, wait for the notification, relay `text` to the user, and suggest running `/shepherd:review` again to check. The fix never commits.
6. Chat: run `shepherd fix --list` and read its output, a numbered list of the findings with the rules. Fix them yourself in this session, in this working tree, scoped to what is listed, and run the checks it names. Never commit, push, or switch branches. Finish with one line per finding addressed (and any you left, with why), then suggest `/shepherd:review` again.

Never push, open a PR, or commit: shepherd and the user own that. `shepherd cost` shows what the review and the fix spent.
