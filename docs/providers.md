# Providers

How the models named in `models` are set up. Which model does which job: [configuration.md](configuration.md#models). Your Claude Code session needs none of this: it uses your Claude Code login. The sections below are for the models that build and review tickets.

There are two kinds of model value, and the first is the default: an **external agent** (`agent:claude`, `agent:codex`, `agent:cursor-agent/auto`, ...), a coding agent CLI opened in a herdr sub-agent with its own login; and a **Pi-worker model** (`provider/id`, `local/<id>`), which runs as a `pi` process in the sub-agent. Pi is only the worker for those: it is not the main session and has no commands or tools of shepherd's.

## External agents

`models.*` can name a coding agent: `agent:claude`, or `agent:claude/opus` to pick the agent's own model. Built in: `claude`, `codex`, `cursor-agent`, `grok`, `agy`, `gemini`, `opencode` ([defaults](configuration.md#agents)). Override or add one under `agents` in your user config.

An agent runs in a herdr sub-agent in the repo with its own login; shepherd never sees its credentials. Claude Code must run inside herdr. Agents start in an "accept edits" mode, so a shell command can stop for your approval; `shepherd build` prints which sub-agent is waiting. Claude Code and Codex are metered from their session logs; the others, Cursor included, show as "not metered" and count $0.

**Cursor.** `agent:cursor-agent/auto`, and when `cursor-agent --list-models` lists `auto-smart`, `agent:cursor-agent/auto-smart[optimize_for=cost|balanced|intelligence]`. The router needs a Teams or Enterprise plan. Quote values with brackets in YAML. Not metered.

## Pi-worker models

A model written `provider/id` runs as `pi -ne -e <plugin>/dist/ticket-mode.mjs --model provider/id --session-dir …` in a sub-agent. Install [Pi](https://github.com/earendil-works/pi) so that `pi` is on `PATH`; a build whose next ticket needs it and cannot find it stops (`NEEDS_PI`) before making a branch. Pi owns the sign-in:

| Provider | Run in `pi` once |
|---|---|
| OpenAI | `/login openai`, then Sign in with ChatGPT |
| Anthropic | `/login anthropic` (Claude Pro/Max) |
| xAI | `/login xai`, then Sign in with SuperGrok or X Premium |
| Any other | Whatever Pi's `/login` says |

- shepherd never reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `XAI_API_KEY`. Whether Pi knows a model and holds a login for it is for the Pi child to say; if it cannot start, the ticket fails with the child's reason (for example `run /login anthropic`).
- A subscription login has no per-token cost; a key stored in Pi does. Add a [`pricing`](configuration.md#pricing) row, or the cost is unknown and counts against budgets.
- An expired login fails the call. Run `/login` again, then rebuild; the plan and earlier commits are kept.
- The child's usage is read from its session files and ledgered after each turn.

## Local server

One OpenAI-compatible server (llama.cpp's `llama-server`, Ollama, LM Studio) is registered with the `pi` worker as provider `local`. Describe it in your user config and use its models as `local/<id>`:

```yaml
# ~/.claude/shepherd.yaml
models:
  low: local/Qwen3.8-27B
local:
  baseUrl: http://127.0.0.1:8081/v1
  apiKeyEnv: LOCAL_API_KEY        # only if the server needs a key
  models:
    - { id: Qwen3.8-27B, contextWindow: 131072, maxTokens: 16384 }
```

- You start the server; shepherd does not.
- `contextWindow` must equal what the server runs. The planner keeps tickets for a local model to half of it. The herdr panel's Detect asks the server (`/props` on llama-server, `/api/ps` on Ollama) and flags a mismatch; a build does not check.
- A local model with no `pricing` row costs $0.
- Choose a model that calls tools well: tickets use Pi's read, edit and bash tools.
- LM Studio is `http://127.0.0.1:1234/v1`.

**llama.cpp.** `id` is the server's `--alias`; `contextWindow` equals `--ctx-size`; tool calls need `--jinja`:

```bash
llama-server --model <gguf> --alias Qwen3.8-27B --host 127.0.0.1 --port 8081 --ctx-size 131072 --jinja -ngl 999
```

Qwen 3.8 27B is a known model: shepherd fills reasoning on, 32768 output tokens and no developer role (a field you set on the entry wins). With one slot (`--parallel 1`) a ticket and other work on the same server wait for each other.

**Ollama.** Its default context is too small and truncates silently, so set it:

```bash
ollama pull qwen3.5:9b
OLLAMA_CONTEXT_LENGTH=65536 ollama serve
```

```yaml
models:
  low: local/qwen3.5:9b
local:
  baseUrl: http://127.0.0.1:11434/v1
  models:
    - { id: "qwen3.5:9b", contextWindow: 65536 }   # equal to OLLAMA_CONTEXT_LENGTH
```

Use the tag `ollama list` shows. A colon in the id is fine; a `:thinking` suffix counts only when it is one of Pi's thinking levels.

The `local` section is read from your user file only: a project file ships with a cloned repo and must not choose a server. A remote `baseUrl` must be `https`; only loopback may be `http`.
