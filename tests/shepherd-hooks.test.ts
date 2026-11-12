import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/shepherd.js";
import { parseConfig } from "../src/config.js";
import { claudeProjectSlug, createAgentMeter } from "../src/runner/agent-usage.js";
import { TaskStore } from "../src/storage/store.js";
import { addTask, contextOf, tempRepo, workflow } from "./helpers.js";

const START = new Date("2026-10-14T12:00:00.000Z").getTime();
const MIN = 60_000;
const OPUS = "claude-opus-5-5";
const AFTER = "2026-10-14T12:30:00.000Z";
const BEFORE = "2026-10-14T11:00:00.000Z";

const usage = (input: number, output = 0, cacheRead = 0, cacheCreation = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation });
const line = (id: string, use: Record<string, number>, timestamp = AFTER, model = OPUS) => JSON.stringify({ type: "assistant", timestamp, message: { id, model, usage: use } }) + "\n";

const CONFIG = (budgets = "") => `
budgets: { taskUsd: 20, dailyUsd: 75, idleWarnMinutes: 60, idleWarnTokens: 100000${budgets} }
pricing:
  - { provider: anthropic, model: ${OPUS}, effectiveFrom: "2026-01-01", inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheWritePerMillionUsd: 6.25 }
`;

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
});

/** A fake HOME with a user config, a temp git repo, a temp SHEPHERD_HOME and a clock the test moves. */
async function setup(config = CONFIG(), sessionId = "sess1") {
  const home = mkdtempSync(path.join(tmpdir(), "hook-home-"));
  process.env.HOME = home; // loadConfig reads ~/.claude/shepherd.yaml
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "shepherd.yaml"), config);
  const shepherd = path.join(home, "shepherd-home");
  const repo = await tempRepo();
  const clock = { at: START };
  const store = new TaskStore(path.join(repo, ".shepherd"));
  const project = path.join(home, ".claude", "projects", claudeProjectSlug(repo));
  mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${sessionId}.jsonl`);
  const cli = async (args: string[], input?: object | string, where = repo) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (text) => out.push(text), err: (text) => err.push(text) }, { stdin: typeof input === "string" ? input : JSON.stringify(input ?? {}), env: { SHEPHERD_HOME: shepherd }, now: () => new Date(clock.at), home, cwd: where });
    const text = out.join("");
    let json: Record<string, any> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text output */
    }
    return { code, out: text, err: err.join(""), json };
  };
  const payload = (extra: object = {}) => ({ session_id: sessionId, transcript_path: transcript, cwd: repo, ...extra });
  const stop = () => cli(["hook", "stop"], payload({ hook_event_name: "Stop" }));
  const prompt = (text: string) => cli(["hook", "prompt"], payload({ hook_event_name: "UserPromptSubmit", prompt: text }));
  const pretool = (command: string, tool = "Bash") => cli(["hook", "pretool"], payload({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } }));
  const ledger = () => store.readLedger();
  const rows = (reason: string) => ledger().filter((row) => row.reason === reason);
  /** Records the first sweep (nothing counted), so later lines are counted. */
  const begin = async () => {
    writeFileSync(transcript, line("old", usage(1000, 1000), BEFORE));
    await stop();
  };
  /** Spend in a repo through its own workflow, at the test config's price. */
  const spend = (cwd: string, inputTokens: number) => workflow(cwd, { config: parseConfig(config), now: () => new Date(clock.at) }).observeUsage({ provider: "anthropic", model: OPUS, usage: { input: inputTokens, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } });
  return { home, shepherd, repo, clock, store, project, transcript, cli, payload, stop, prompt, pretool, ledger, rows, begin, spend };
}

describe("hook stop", () => {
  it("makes the workspace ignore itself, so a chat never leaves untracked files in the repo", async () => {
    const t = await setup();
    await t.stop();
    expect(readFileSync(path.join(t.repo, ".shepherd", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("ledgers the session's turns once, as reason session, and records the context for the idle check", async () => {
    const t = await setup();
    await t.begin();
    expect(t.ledger()).toHaveLength(0);
    appendFileSync(t.transcript, line("m1", usage(100, 10, 250_000, 40)));
    const first = await t.stop();
    expect(first).toMatchObject({ code: 0, out: "", err: "" });
    expect(t.rows("session")).toHaveLength(1);
    expect(t.rows("session")[0]).toMatchObject({ provider: "anthropic", model: OPUS, meter: "agent-log", inputTokens: 100, outputTokens: 10 });
    await t.stop();
    expect(t.rows("session")).toHaveLength(1);
    const note = JSON.parse(readFileSync(path.join(t.shepherd, "sessions", "sess1.json"), "utf8"));
    expect(note).toEqual({ lastTurnEnd: new Date(START).toISOString(), contextTokens: 250_140, model: OPUS, transcriptPath: t.transcript, sessionId: "sess1" });
    // A half-written last line is skipped, and counted only when whole.
    const whole = line("m2", usage(7, 7));
    appendFileSync(t.transcript, whole.slice(0, 25));
    await t.stop();
    expect(t.rows("session")).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(t.shepherd, "sessions", "sess1.json"), "utf8")).contextTokens).toBe(250_140);
    appendFileSync(t.transcript, whole.slice(25));
    await t.stop();
    expect(t.rows("session")).toHaveLength(2);
  });

  it("ledgers the session's subagent logs as session subagent and other logs as outside chef", async () => {
    const t = await setup();
    await t.begin();
    const sub = path.join(t.project, "sess1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "agent-1.jsonl"), line("s1", usage(20, 2)));
    writeFileSync(path.join(t.project, "other.jsonl"), line("o1", usage(30, 3)));
    appendFileSync(t.transcript, line("m1", usage(10, 1)));
    await t.stop();
    expect(t.rows("session")).toHaveLength(1);
    expect(t.rows("session subagent")).toHaveLength(1);
    expect(t.rows("outside chef")).toHaveLength(1);
    expect(t.rows("session subagent")[0]).toMatchObject({ inputTokens: 20 });
    expect(t.rows("outside chef")[0]).toMatchObject({ inputTokens: 30 });
  });

  it("ledgers to the active task, or to the session pseudo-task without one", async () => {
    const t = await setup();
    await t.begin();
    appendFileSync(t.transcript, line("m1", usage(10, 1)));
    await t.stop();
    expect(t.rows("session")[0]).toMatchObject({ taskId: "session", phase: "IDLE" });
    const task = await addTask(workflow(t.repo), "fix");
    appendFileSync(t.transcript, line("m2", usage(10, 1)));
    await t.stop();
    expect(t.rows("session")[1]).toMatchObject({ taskId: task.taskId, phase: "PLANNING" });
  });

  it("does not count what a ticket meter ledgered", async () => {
    const t = await setup();
    await t.begin();
    const meter = createAgentMeter("claude", { cwd: t.repo, home: t.home, onConsumed: (file, offset) => void t.store.advanceAgentLog(file, offset) })!;
    appendFileSync(t.transcript, line("ticket", usage(300, 30)));
    expect(meter.collect()).toHaveLength(1);
    await t.stop();
    expect(t.rows("session")).toHaveLength(0);
    appendFileSync(t.transcript, line("mine", usage(4, 4)));
    await t.stop();
    expect(t.rows("session")).toHaveLength(1);
    expect(t.rows("session")[0]).toMatchObject({ inputTokens: 4 });
  });

  it("is skipped over a live build, and counts the rest afterwards", async () => {
    const t = await setup();
    await t.begin();
    const task = await addTask(workflow(t.repo), "fix");
    appendFileSync(t.transcript, line("m1", usage(50, 5)));
    expect(t.store.claimBuild(task.taskId, t.repo, BEFORE)).toBeUndefined();
    await t.stop();
    expect(t.rows("session")).toHaveLength(0);
    t.store.releaseBuild(task.taskId);
    await t.stop();
    expect(t.rows("session")).toHaveLength(1);
  });

  it("never throws: bad input, a missing transcript, not a repo, an invalid config", async () => {
    const t = await setup();
    expect(await t.cli(["hook", "stop"], "not json")).toMatchObject({ code: 0, out: "", err: "" });
    expect(await t.cli(["hook", "stop"], t.payload({ transcript_path: path.join(t.home, "none.jsonl") }))).toMatchObject({ code: 0, out: "" });
    const bare = mkdtempSync(path.join(tmpdir(), "not-a-repo-"));
    expect(await t.cli(["hook", "prompt"], { session_id: "x", cwd: bare, prompt: "hi" }, bare)).toMatchObject({ code: 0, out: "", err: "" });
    writeFileSync(path.join(t.home, ".claude", "shepherd.yaml"), "budgets: [oops");
    expect(await t.prompt("hi")).toMatchObject({ code: 0, out: "", err: "" });
  });
});

describe("hook prompt: budgets", () => {
  it("blocks at the hard limit with the spend, and lets slash commands through", async () => {
    const t = await setup(CONFIG().replace("dailyUsd: 75", "dailyUsd: 1"));
    await t.begin();
    appendFileSync(t.transcript, line("big", usage(1_000_000)));
    const blocked = await t.prompt("keep going");
    expect(blocked.code).toBe(0);
    expect(blocked.json).toMatchObject({ decision: "block" });
    expect(blocked.json?.reason).toContain("today $5.00 of $1");
    expect(blocked.json?.reason).toContain("~/.claude/shepherd.yaml");
    expect(blocked.json?.reason).toContain("tomorrow");
    expect((await t.prompt("/cost")).out).toBe("");
    expect((await t.prompt("  /plan x")).out).toBe("");
  });

  it("blocks at the task limit and names the task", async () => {
    const t = await setup(CONFIG().replace("taskUsd: 20", "taskUsd: 1"));
    await addTask(workflow(t.repo), "fix");
    await t.begin();
    appendFileSync(t.transcript, line("big", usage(1_000_000)));
    const blocked = await t.prompt("go");
    expect(blocked.json?.decision).toBe("block");
    expect(blocked.json?.reason).toContain("task fix $5.00 of $1");
  });

  it("warns once per task per day at the soft limit", async () => {
    const t = await setup(CONFIG().replace("dailyUsd: 75", "dailyUsd: 10"));
    await t.begin();
    appendFileSync(t.transcript, line("big", usage(1_700_000))); // $8.50 of $10
    const first = await t.prompt("go");
    expect(first.json?.systemMessage).toContain("Budget warning: today $8.50 of $10");
    expect(first.json?.decision).toBeUndefined();
    expect((await t.prompt("go again")).out).toBe("");
    t.clock.at += 24 * 60 * MIN; // the next day: the spend no longer counts, so no warning either
    expect((await t.prompt("go")).out).toBe("");
  });

  it("counts the daily budget across every registered repo", async () => {
    const t = await setup();
    const other = await tempRepo();
    await t.spend(t.repo, 2_000_000); // $10
    await t.spend(other, 3_000_000); // $15
    // A repo counts once shepherd has run in it.
    expect((await t.cli(["status"], {}, other)).out).toContain("today $15.00/$75");
    expect((await t.cli(["status"], {}, t.repo)).out).toContain("today $25.00/$75");
    expect((await t.cli(["status"], {}, other)).out).toContain("today $25.00/$75");
  });
});

describe("hook prompt: idle warning", () => {
  async function idle(config = CONFIG()) {
    const t = await setup(config);
    await t.begin();
    appendFileSync(t.transcript, line("m1", usage(10, 10, 250_000)));
    await t.stop();
    t.clock.at += 125 * MIN;
    return t;
  }

  it("blocks over both thresholds, with tokens, idle time and the cache-write price", async () => {
    const t = await idle();
    const blocked = await t.prompt("hello");
    expect(blocked.json?.decision).toBe("block");
    const reason = String(blocked.json?.reason);
    expect(reason).toContain("250k tokens");
    expect(reason).toContain("idle 2h 5m");
    expect(reason).toContain("probably expired");
    expect(reason).toContain("≈$1.56 at claude-opus-5-5 rates");
    expect(reason).toContain("Send the same message again within 2 minutes to send anyway, or run /clear");
  });

  it("lets the same prompt through within 2 minutes, once, and blocks a different one", async () => {
    const t = await idle();
    expect((await t.prompt("hello")).json?.decision).toBe("block");
    t.clock.at += 1 * MIN;
    expect((await t.prompt("hello")).out).toBe("");
    expect(existsSync(path.join(t.shepherd, "sessions", "sess1.pending.json"))).toBe(false);
    expect((await t.prompt("hello")).json?.decision).toBe("block"); // the pass was used up
    expect((await t.prompt("something else")).json?.decision).toBe("block");
    t.clock.at += 1 * MIN;
    expect((await t.prompt("hello")).json?.decision).toBe("block"); // the pending one is for another prompt
    t.clock.at += 3 * MIN;
    expect((await t.prompt("something else")).json?.decision).toBe("block"); // older than 2 minutes
  });

  it("stays quiet after the next turn ends, for commands, below either threshold and when disabled", async () => {
    const t = await idle();
    expect((await t.prompt("/cost")).out).toBe("");
    await t.stop(); // a turn ended just now
    expect((await t.prompt("hello")).out).toBe("");

    const small = await setup();
    await small.begin();
    appendFileSync(small.transcript, line("m1", usage(10, 10, 50_000)));
    await small.stop();
    small.clock.at += 125 * MIN;
    expect((await small.prompt("hello")).out).toBe("");

    const off = await idle(CONFIG().replace("idleWarnMinutes: 60", "idleWarnMinutes: 0"));
    expect((await off.prompt("hello")).out).toBe("");
    const noTokens = await idle(CONFIG().replace("idleWarnTokens: 100000", "idleWarnTokens: 0"));
    expect((await noTokens.prompt("hello")).out).toBe("");
  });

  it("omits the dollar figure with no pricing row", async () => {
    const t = await idle(CONFIG().replace(OPUS, "claude-other"));
    const reason = String((await t.prompt("hello")).json?.reason);
    expect(reason).toContain("250k tokens");
    expect(reason).not.toContain("$");
  });
});

describe("hook pretool", () => {
  async function building() {
    const t = await setup();
    const task = await addTask(workflow(t.repo), "fix");
    expect(t.store.claimBuild(task.taskId, t.repo, BEFORE)).toBeUndefined();
    return t;
  }
  const denied = (result: { json?: Record<string, any> }) => result.json?.hookSpecificOutput;

  it("denies push, branch changes and worktrees during a live build", async () => {
    const t = await building();
    for (const command of ["git push origin main", "git push", "git -C . push --force", "git checkout -b other", "git checkout main", "git switch main", "git checkout -", "git worktree add ../x", "git status && git push", "FOO=1 git push", 'bash -c "git push"', "echo hi | git push"]) {
      const result = await t.pretool(command);
      expect(result.code, command).toBe(0);
      expect(denied(result), command).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(denied(result).permissionDecisionReason, command).toContain("fix");
    }
  });

  it("denies the same while the build-in-progress marker is set, with no live claim, and stops denying when it is cleared", async () => {
    const t = await setup();
    const task = await addTask(workflow(t.repo), "fix");
    expect(t.store.liveBuildClaim(task.taskId)).toBeUndefined();
    expect((await t.pretool("git push")).out).toBe("");
    t.store.markBuilding(task.taskId, BEFORE);
    expect(t.store.buildInProgress(task.taskId)).toBe(true);
    for (const command of ["git push origin main", "git checkout main", "git switch -c other", "git worktree add ../x"]) {
      expect(denied(await t.pretool(command)), command).toMatchObject({ permissionDecision: "deny" });
    }
    expect((await t.pretool("git status")).out).toBe("");
    t.store.clearBuilding(task.taskId);
    expect(t.store.buildInProgress(task.taskId)).toBe(false);
    expect((await t.pretool("git push")).out).toBe("");
  });

  it("does not apply a marker left on a closed task", async () => {
    const t = await setup();
    const task = await addTask(workflow(t.repo), "fix", { phase: "COMPLETE" });
    t.store.markBuilding(task.taskId, BEFORE);
    expect((await t.pretool("git push")).out).toBe("");
  });

  it("allows everything else during a build", async () => {
    const t = await building();
    for (const command of ["git checkout -- file.ts", "git checkout main -- file.ts", "git checkout .", "git status", "git commit -m 'git push later'", "git log --oneline", "ls ; echo git push", "npm test"]) {
      expect((await t.pretool(command)).out, command).toBe("");
    }
    expect((await t.pretool("git push", "Read")).out).toBe("");
  });

  it("allows push and branch changes when no build runs", async () => {
    const t = await setup();
    await addTask(workflow(t.repo), "fix");
    expect((await t.pretool("git push")).out).toBe("");
    expect((await t.pretool("git checkout -b x")).out).toBe("");
  });

  it("denies shepherd build/review/fix and hc run over budget, and allows them under it", async () => {
    const t = await setup(CONFIG().replace("dailyUsd: 75", "dailyUsd: 1"));
    expect((await t.pretool("hc run claude 'do it'")).out).toBe("");
    expect((await t.pretool("shepherd build")).out).toBe("");
    await t.spend(t.repo, 1_000_000);
    for (const command of ["hc run claude 'do it'", "shepherd build", "shepherd fix --tab", "node dist/shepherd.mjs review", "cd x && hc run codex hi"]) {
      const result = await t.pretool(command);
      expect(denied(result), command).toMatchObject({ permissionDecision: "deny" });
      expect(denied(result).permissionDecisionReason, command).toContain("today $5.00 of $1");
    }
    expect((await t.pretool("shepherd cost")).out).toBe("");
    expect((await t.pretool("hc list")).out).toBe("");
    expect((await t.pretool("git push")).out).toBe("");
  });
});

describe("shepherd status and cost", () => {
  it("prints one status line, for a task, none, and a directory that is not a repo", async () => {
    const t = await setup();
    expect((await t.cli(["status"])).out).toBe("shepherd · no task · task $0.00/$20 · today $0.00/$75\n");
    await addTask(workflow(t.repo), "fix");
    await t.spend(t.repo, 1_000_000);
    expect((await t.cli(["status"])).out).toBe("shepherd · fix · task $5.00/$20 · today $5.00/$75\n");
    const bare = mkdtempSync(path.join(tmpdir(), "not-a-repo-"));
    expect(await t.cli(["status"], {}, bare)).toMatchObject({ code: 0, out: "shepherd · no repo\n" });
  });

  it("cost sweeps, then prints the report with the session row; --json gives text and budget", async () => {
    const t = await setup();
    await t.begin(); // a Stop: the session is known
    appendFileSync(t.transcript, line("m1", usage(1_000_000)));
    const result = await t.cli(["cost"]); // mid-turn: no transcript of its own, but the session's log is labelled from its note
    expect(result.code).toBe(0);
    expect(result.out).toContain("## Cost");
    expect(result.out).toContain("### By job");
    expect(result.out).toMatch(/\| session \|/);
    expect(result.out).not.toContain("outside chef");
    expect(t.rows("session")).toHaveLength(1);
    expect(t.rows("outside chef")).toHaveLength(0);
    expect(result.out).toContain("$5.0000");
    const json = await t.cli(["cost", "--json"]);
    expect(json.json?.text).toContain("## Cost");
    expect(json.json?.budget.daily.knownUsd).toBe(5);
  });

  it("a session's first prompt is enough for cost to label its log as session", async () => {
    const t = await setup();
    writeFileSync(t.transcript, line("old", usage(1000, 1000), BEFORE));
    await t.prompt("hello"); // first sweep; remembers the transcript
    appendFileSync(t.transcript, line("m1", usage(10, 1)));
    await t.cli(["cost"]);
    expect(t.rows("session")).toHaveLength(1);
    expect(t.rows("outside chef")).toHaveLength(0);
  });

  it("cost explains itself outside a repo and with an invalid config, and exits 1", async () => {
    const t = await setup();
    const bare = mkdtempSync(path.join(tmpdir(), "not-a-repo-"));
    expect(await t.cli(["cost"], {}, bare)).toMatchObject({ code: 1 });
    expect((await t.cli(["cost"], {}, bare)).err).toContain("not inside a git repository");
    writeFileSync(path.join(t.home, ".claude", "shepherd.yaml"), "budgets: [oops");
    const bad = await t.cli(["cost"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("shepherd.yaml");
  });

  it("registers each repo it works in, once", async () => {
    const t = await setup();
    await t.cli(["status"]);
    await t.cli(["status"]);
    const repos = JSON.parse(readFileSync(path.join(t.shepherd, "repos.json"), "utf8"));
    expect(repos).toEqual([path.join(contextOf(workflow(t.repo)).git.repoRoot, ".shepherd")]);
  });
});
