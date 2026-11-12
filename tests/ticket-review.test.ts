import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Ticket, TokenUsage } from "../src/domain.js";
import { runBuild, type BuildDriver, type ModelRef } from "../src/orchestrator/build.js";
import { carriedFindings, reviewTicket } from "../src/orchestrator/ticket-review.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fakeHerdrClient, type FakeTab } from "./herdr-fake.js";
import { checkRunner, contextOf, sampleTicket, tempRepo, tieredConfig, ticketWorkflow } from "./helpers.js";

const OPUS = "claude-opus-5-5";
const pass = (extra: object = {}) => JSON.stringify({ summary: "Looks right.", findings: [], ...extra });
/** The review model's answer with these findings; the verdict is the code's rule over their scores. */
const scored = (findings: object[], extra: object = {}) => JSON.stringify({ summary: "Reviewed.", findings, ...extra });
const fail = (issue = "retry loop never stops", extra: object = {}) => scored([{ likelihood: 8, severity: 8, file: "f.txt", issue }], extra);

interface Send {
  ticket: string;
  model: ModelRef;
  text: string;
  turn: number;
}

/** A driver whose sessions run a script that may write files, like a model would. */
function fakeDriver(cwd: string, script: (send: Send) => { lastText?: string; aborted?: boolean } | void) {
  const sends: Send[] = [];
  const driver: BuildDriver = {
    async fresh(model, run) {
      let current = "";
      let turn = 0;
      await run({
        async send(text) {
          current = text.match(/^# Ticket (\d+):/m)?.[1] ?? current;
          const send: Send = { ticket: current, model, text, turn: turn++ };
          sends.push(send);
          const reply = script(send) ?? {};
          return { lastText: reply.lastText ?? "Done.\n- [x] retry works\nFiles changed: x", aborted: reply.aborted ?? false };
        },
      });
    },
  };
  const write = (name: string, body = "x\n") => writeFileSync(path.join(cwd, name), body);
  return { driver, sends, write };
}

/** What a review tab was asked: the model it ran as, and the prompt (the ticket, the rules and where to write the findings). */
interface FakeCall {
  provider: string;
  model: string;
  prompt: string;
  /** The prompt again: the rules are in it. */
  system: string;
  user: string;
}

/**
 * A fake herdr that plays the review tab: a review prompt is answered by writing `answer(call)` to the findings file it names
 * and the reply's usage to a Pi session file (the tab is a Pi child). An answer that throws is a turn that failed; one that
 * returns undefined writes no file.
 */
function reviewHerdr(answer: Answer) {
  const calls: FakeCall[] = [];
  const fake = fakeHerdrClient({
    onSend: async (tab: FakeTab, text: string) => {
      const out = /Write ONLY a JSON object to (\S+\.json)/.exec(text)?.[1];
      if (!out) return;
      const [provider = "", ...rest] = tab.model.split("/");
      const call: FakeCall = { provider, model: rest.join("/").replace(/:(off|minimal|low|medium|high|xhigh)$/, ""), prompt: text, system: text, user: text };
      calls.push(call);
      const reply = await answer(call);
      if (reply === undefined) return;
      const body = typeof reply === "string" ? reply : reply.text;
      const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, requests: 1, ...(typeof reply === "string" ? {} : reply.usage) };
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, body);
      const sm = SessionManager.create("/work", tab.sessionDir);
      sm.appendMessage({ role: "user", content: "review", timestamp: Date.now() } as never);
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "x", provider: call.provider, model: call.model, usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: (usage.input ?? 0) + (usage.output ?? 0), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
    },
  });
  return { client: fake.client, calls };
}

type Answer = (call: FakeCall) => string | undefined | { text: string; usage?: Partial<TokenUsage> } | Promise<string | undefined | { text: string; usage?: Partial<TokenUsage> }>;

/** Answers the review model's call. */
function roles(handlers: { review?: Answer }): Answer {
  return (call) => (handlers.review ?? (() => pass()))(call);
}

async function setup(options: { tickets?: Ticket[]; answer?: Answer; mutate?: (config: ReturnType<typeof tieredConfig>) => void; herdr?: boolean } = {}) {
  const cwd = await tempRepo();
  const config = tieredConfig();
  options.mutate?.(config);
  const progress: string[] = [];
  const reports: string[] = [];
  const passing = { ok: true };
  const fake = reviewHerdr(options.answer ?? roles({}));
  const { app, taskId } = await ticketWorkflow(
    options.tickets ?? [sampleTicket("01", { difficulty: "low" })],
    {
      config,
      herdr: options.herdr === false ? undefined : fake.client,
      herdrTimings: { sleep: async () => undefined },
      ticketModePath: "/shepherd/dist/ticket-mode.mjs",
      progress: (line) => void progress.push(line),
      report: (markdown) => void reports.push(markdown),
      runner: checkRunner(async () => (passing.ok ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "AssertionError: expected 1" })),
    },
    { cwd },
  );
  const load = () => app.store.load(taskId)!;
  const ctx = contextOf(app);
  const logPath = path.join(app.store.root, "metrics", "tickets.jsonl");
  const log = () => readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  return { cwd, app, taskId, load, progress, reports, passing, calls: fake.calls, ctx, logPath, log, run: (driver: BuildDriver) => runBuild(() => app, driver) };
}

describe("per-ticket review in /build", () => {
  it("reviews a ticket once with the review model and commits on a pass", async () => {
    const t = await setup();
    const d = fakeDriver(t.cwd, () => d.write("f.txt", "export const x = 1;\n"));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.model).toBe(OPUS);
    // The reviewer is told the ticket and how to see its own change (it reads the checkout itself); it is not sent the diff.
    expect(t.calls[0]!.user).toContain("# Ticket 01: Ticket 01");
    expect(t.calls[0]!.user).toContain("Build part 01.");
    expect(t.calls[0]!.user).toContain("git diff HEAD");
    const run = t.load().ticketRuns!["01"]!;
    expect(run).toMatchObject({ status: "done", difficulty: "low" });
    expect(run.reviews).toHaveLength(1);
    expect(run.reviews![0]).toMatchObject({ attempt: 1, round: 1, tier: "low", implementer: "xai/grok-4.7", verdict: "pass" });
    expect(t.app.store.readLedger().filter((row) => row.reason.startsWith("ticket review")).map((row) => [row.reason, row.model, row.tier])).toEqual([["ticket review · ticket 01", OPUS, "review"]]);
  });

  it("retries once in the same session on a failed review, then commits when the second review passes", async () => {
    let reviews = 0;
    const t = await setup({ answer: roles({ review: () => (++reviews === 1 ? fail() : pass()) }) });
    const d = fakeDriver(t.cwd, (send) => d.write("f.txt", `export const v = ${send.turn};\n`));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(d.sends.map((item) => item.turn)).toEqual([0, 1]);
    expect(d.sends[1]!.text).toContain("retry loop never stops");
    expect(t.calls).toHaveLength(2);
    expect(t.load().ticketRuns!["01"]!.reviews!.map((item) => [item.round, item.verdict])).toEqual([[1, "fail"], [2, "pass"]]);
    expect(t.progress.find((line) => line.startsWith("Ticket 01 ·"))).toContain("review pass (2nd)");
  });

  it("keeps the check retry and the review retry separate", async () => {
    let reviews = 0;
    const t = await setup({ answer: roles({ review: () => (++reviews === 1 ? fail() : pass()) }) });
    let checks = 0;
    t.ctx.checkRunner.run = async () => (++checks === 1 ? { code: 1, stdout: "", stderr: "AssertionError: first run" } : { code: 0, stdout: "ok", stderr: "" });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    // checks fail -> retry 1; checks pass, review fails -> retry 2; checks pass, review passes -> commit.
    expect(d.sends.map((item) => item.turn)).toEqual([0, 1, 2]);
    expect(d.sends[1]!.text).toContain("The checks failed");
    expect(d.sends[2]!.text).toContain("retry loop never stops");
  });

  it("fails the ticket on a second failed review, strikes the implementer, and escalates on the next /build", async () => {
    const t = await setup({ answer: roles({ review: () => fail() }) });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("REVIEW_FAILED");
    expect(d.sends).toHaveLength(2);
    const run = t.load().ticketRuns!["01"]!;
    expect(run).toMatchObject({ status: "failed", failedBy: "review" });
    expect(run.attemptLog![0]).toMatchObject({ outcome: "failure", failedBy: "review", provider: "xai" });
    expect(await gitLog(t.cwd)).toBe("base");
    // The tree still passes its checks, but the review failed: no commit without a model turn. It goes one tier up.
    const next = fakeDriver(t.cwd, () => next.write("g.txt"));
    await t.run(next.driver);
    expect(next.sends[0]!.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(next.sends[0]!.text).toContain("retry loop never stops");
    expect(t.load().ticketRuns!["01"]!.attempts).toBe(2);
  });

  it("commits with a warning when the review turn fails, and the report says so", async () => {
    const t = await setup({
      answer: () => {
        throw new Error("overloaded");
      },
    });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(t.calls).toHaveLength(1);
    const review = t.load().ticketRuns!["01"]!.reviews![0]!;
    expect(review.verdict).toBe("unavailable");
    expect(review.rationale).toContain("overloaded");
    expect(t.progress.some((line) => line.includes("Ticket 01 was committed without its review (unavailable:"))).toBe(true);
    expect(t.reports[0]).toContain("was committed without its review");
    expect(t.reports[0]).toContain("| unavailable |");
    expect(await gitLog(t.cwd)).toBe("01: Ticket 01\nbase");
  });

  it("an answer that is not the JSON asked for is an unavailable review, not a pass", async () => {
    const t = await setup({ answer: () => "looks fine to me" });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(t.calls.map((call) => call.model)).toEqual([OPUS]);
    expect(t.load().ticketRuns!["01"]!.reviews![0]).toMatchObject({ verdict: "unavailable" });
    expect(t.load().ticketRuns!["01"]!.reviews![0]!.rationale).toContain("not the JSON asked for");
  });

  it("does not review when review.tickets is false or there is no herdr client", async () => {
    for (const options of [{ mutate: (config: ReturnType<typeof tieredConfig>) => void (config.review.tickets = false) }, { herdr: false }]) {
      const t = await setup(options);
      const d = fakeDriver(t.cwd, () => d.write("f.txt"));
      expect((await t.run(d.driver)).ok).toBe(true);
      expect(t.calls).toHaveLength(0);
      expect(t.load().ticketRuns!["01"]!.reviews).toBeUndefined();
    }
  });
});

describe("ticket review scoring", () => {
  const run = async (answer: string) => {
    const t = await setup({ answer: roles({ review: () => answer }) });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    return { t, d, result };
  };

  it("fails a ticket with a finding at risk 20 (4x5), whatever the model writes as a verdict", async () => {
    const { t, d, result } = await run(scored([{ likelihood: 4, severity: 5, file: "f.txt", issue: "cap is off by one" }], { verdict: "pass" }));
    expect(result.code).toBe("REVIEW_FAILED");
    expect(d.sends[1]!.text).toContain("L4×S5 f.txt: cap is off by one");
    expect(t.load().ticketRuns!["01"]!.reviews!.map((item) => item.verdict)).toEqual(["fail", "fail"]);
    expect(t.progress.some((line) => line.includes("review: fail · 1 finding(s)"))).toBe(true);
  });

  it("passes a ticket whose findings score below 20 (3x5) and keeps them on the record to be carried", async () => {
    const { t, d, result } = await run(scored([{ likelihood: 3, severity: 5, file: "f.txt", issue: "no test for the empty case" }, { likelihood: 2, severity: 2, issue: "naming nit" }, { severity: 9, issue: "no likelihood" }], { verdict: "fail" }));
    expect(result.ok, result.text).toBe(true);
    expect(d.sends).toHaveLength(1);
    const review = t.load().ticketRuns!["01"]!.reviews![0]!;
    expect(review).toMatchObject({ verdict: "pass", findings: [{ likelihood: 3, severity: 5, file: "f.txt", issue: "no test for the empty case" }] });
    expect(review.findings).toHaveLength(1);
    expect(t.progress.some((line) => line.includes("review: pass · 1 finding(s) (2 below the risk threshold dropped)"))).toBe(true);
    const carried = carriedFindings(t.load());
    expect(carried).toEqual([{ ticket: "01", likelihood: 3, severity: 5, file: "f.txt", issue: "no test for the empty case" }]);
    // The model pass already reported it: listed once.
    expect(carriedFindings(t.load(), [{ file: "f.txt", message: "No test for the empty case!" }])).toEqual([]);
  });

  it("does not carry a record from before scores, or a ticket whose last review failed", async () => {
    const { t } = await run(scored([{ likelihood: 3, severity: 5, issue: "carried" }]));
    const state = t.load();
    state.ticketRuns!["01"]!.reviews![0]!.findings.push({ likelihood: 9, severity: "high" as never, issue: "old record" });
    expect(carriedFindings(state).map((item) => item.issue)).toEqual(["carried"]);
    state.ticketRuns!["01"]!.reviews![0]!.verdict = "fail";
    expect(carriedFindings(state)).toEqual([]);
  });

  it("asks for both scores and names the failing score", async () => {
    const { t } = await run(pass());
    expect(t.calls[0]!.system).toContain('"likelihood": 1-10, "severity": 1-10');
    expect(t.calls[0]!.system).toContain("below 5 combined");
    expect(t.calls[0]!.system).not.toContain('"verdict"');
  });
});

describe("routing.maxEscalations", () => {
  it("stops a ticket that is still failing after climbing the allowed tiers", async () => {
    const t = await setup({ mutate: (config) => void (config.routing.maxEscalations = 1) });
    t.passing.ok = false;
    const models: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const d = fakeDriver(t.cwd, () => d.write(`f${pass}.txt`));
      await t.run(d.driver);
      models.push(d.sends[0]!.model.id);
    }
    expect(models).toEqual(["grok-4.7", "claude-sonnet-5-5"]);
    const third = fakeDriver(t.cwd, () => third.write("f3.txt"));
    const result = await t.run(third.driver);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MAX_ESCALATIONS");
    expect(result.text).toContain("routing.maxEscalations (1)");
    expect(third.sends).toHaveLength(0);
    expect(t.load().ticketRuns!["01"]!.status).toBe("failed");
  });

  it("does not climb at all when it is 0", async () => {
    const t = await setup({ mutate: (config) => void (config.routing.maxEscalations = 0) });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    const second = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(second.driver);
    expect(result.code).toBe("MAX_ESCALATIONS");
    expect(second.sends).toHaveLength(0);
  });

  it("counts from the difficulty rung, so a medium ticket still has its allowance", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "medium" })], mutate: (config) => void (config.routing.maxEscalations = 1) });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    const second = fakeDriver(t.cwd, () => second.write("g.txt"));
    await t.run(second.driver);
    expect(second.sends[0]!.model.id).toBe("gpt-6.1-sol");
    const third = fakeDriver(t.cwd, () => undefined);
    expect((await t.run(third.driver)).code).toBe("MAX_ESCALATIONS");
  });
});

describe("routing.maxEscalations with rungs that name the same model", () => {
  const sameLowAndMedium = (limit: number) => (config: ReturnType<typeof tieredConfig>) => {
    config.models.medium = config.models.low;
    config.routing.maxEscalations = limit;
  };

  it("counts the skipped rung as climbed: low to high is two rungs, so a limit of 1 stops at low", async () => {
    const t = await setup({ mutate: sameLowAndMedium(1) });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    expect(first.sends[0]!.model.id).toBe("grok-4.7");
    const second = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(second.driver);
    expect(result.code).toBe("MAX_ESCALATIONS");
    expect(result.text).toContain("high");
    expect(result.text).toContain("routing.maxEscalations (1)");
    expect(second.sends).toHaveLength(0);
  });

  it("climbs past the skipped rung when the limit allows two", async () => {
    const t = await setup({ mutate: sameLowAndMedium(2) });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    const second = fakeDriver(t.cwd, () => second.write("g.txt"));
    await t.run(second.driver);
    expect(second.sends[0]!.model.id).toBe("gpt-6.1-sol");
  });
});

describe("the per-ticket log, costs and status", () => {
  it("appends one line per finished ticket to metrics/tickets.jsonl and never truncates it", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "medium" }), sampleTicket("02", { difficulty: "low", blockedBy: ["01"] })] });
    mkdirSync(path.dirname(t.logPath), { recursive: true });
    // An older line without a trailing newline stays intact and the next line starts fresh.
    writeFileSync(t.logPath, '{"older":true}');
    const d = fakeDriver(t.cwd, (send) => {
      d.write(`f${send.ticket}.txt`);
      t.app.observeUsage({ provider: send.model.provider, model: send.model.id, usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    });
    expect((await t.run(d.driver)).ok).toBe(true);
    const lines = readFileSync(t.logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ older: true });
    const [, one, two] = t.log();
    expect(Object.keys(one!)).toEqual(["at", "taskId", "ticket", "title", "difficulty", "implementers", "review", "costUsd", "elapsedMs"]);
    expect(one).toMatchObject({
      taskId: t.taskId,
      ticket: "01",
      title: "Ticket 01",
      difficulty: "medium",
      implementers: [{ tier: "medium", provider: "anthropic", model: "claude-sonnet-5-5", outcome: "success" }],
      review: { passes: 1, fails: 0, unavailable: 0, finalVerdict: "pass", rationale: "Looks right." },
    });
    expect(typeof one!.elapsedMs).toBe("number");
    expect(two).toMatchObject({ ticket: "02", difficulty: "low", review: { finalVerdict: "pass" } });
    // A later append keeps everything before it.
    appendFileSync(t.logPath, '{"later":true}\n');
    t.app.store.appendTicketLog({ more: 1 });
    expect(readFileSync(t.logPath, "utf8").startsWith(lines.join("\n"))).toBe(true);
  });

  it("logs a failed ticket too, with the failure and the review counts", async () => {
    const t = await setup({ answer: roles({ review: () => fail() }) });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    await t.run(d.driver);
    const [line] = t.log();
    expect(line).toMatchObject({ ticket: "01", implementers: [{ outcome: "failure", failedBy: "review" }], review: { passes: 0, fails: 2, finalVerdict: "fail" } });
  });

  it("splits the cost into implementer and review and ledgers each under its reason", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })] });
    const d = fakeDriver(t.cwd, (send) => {
      d.write("f.txt");
      t.app.observeUsage({ provider: send.model.provider, model: send.model.id, usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, requests: 1 } }, { ticketId: "01" });
    });
    expect((await t.run(d.driver)).ok).toBe(true);
    const run = t.load().ticketRuns!["01"]!;
    // Sol 1000 in / 1000 out at $10 / $50 per million = $0.06 for the turn. Opus: 1000/500 at $15 / $75 = $0.0525 for the one review call.
    expect(run.costSplit).toEqual({ implementer: 0.06, review: 0.0525 });
    expect(run.costUsd).toBe(0.1125);
    const reasons = t.app.store.readLedger().map((row) => row.reason).filter((reason) => /ticket 01$/.test(reason));
    expect(reasons.sort()).toEqual(["observed assistant usage · ticket 01", "ticket review · ticket 01"].sort());
    expect(t.progress.find((line) => line.startsWith("Ticket 01 ·"))).toContain("$0.1125 (impl $0.0600 · review $0.0525) · checks passed · review pass · committed");
    expect(t.reports[0]).toContain("| 01 | Ticket 01 | high | openai/gpt-6.1-sol | pass |");
    expect(t.reports[0]).toContain("$0.1125 (impl $0.0600 · review $0.0525)");
  });
});

async function gitLog(cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return (await promisify(execFile)("git", ["log", "--format=%s"], { cwd })).stdout.trim();
}

describe("a hand fix is reviewed before its commit", () => {
  it("records the review without an implementer and strikes no model when it passes", async () => {
    const t = await setup();
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    expect((await t.run(first.driver)).ok).toBe(false);
    const reviewsBefore = t.calls.filter((call) => call.model === OPUS).length;
    t.passing.ok = true;
    writeFileSync(path.join(t.cwd, "hand-fix.txt"), "fixed\n");
    const second = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(second.driver);
    expect(result.ok, result.text).toBe(true);
    expect(second.sends).toHaveLength(0);
    expect(t.calls.filter((call) => call.model === OPUS).length).toBe(reviewsBefore + 1);
    const run = t.load().ticketRuns!["01"]!;
    expect(run.status).toBe("done");
    expect(run.reviews!.at(-1)).toMatchObject({ verdict: "pass", implementer: "unknown" });
    expect(run.attemptLog!.at(-1)).toMatchObject({ outcome: "success", model: "hand fix" });
  });

  it("a failed review leaves the ticket failed, and the next model attempt gets the findings", async () => {
    let reviews = 0;
    const t = await setup({ answer: roles({ review: () => (reviews++ === 0 ? fail("hand fix ignores the cap") : pass()) }) });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    expect((await t.run(first.driver)).ok).toBe(false);
    t.passing.ok = true;
    writeFileSync(path.join(t.cwd, "hand-fix.txt"), "fixed\n");
    const second = fakeDriver(t.cwd, () => second.write("g.txt"));
    const result = await t.run(second.driver);
    expect(result.ok, result.text).toBe(true);
    expect(await gitLog(t.cwd)).toContain("01: Ticket 01");
    // The review failed the hand fix, so a model got another go, one tier up, with the findings.
    expect(second.sends[0]!.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(second.sends[0]!.text).toContain("hand fix ignores the cap");
    const run = t.load().ticketRuns!["01"]!;
    expect(run.reviews![0]).toMatchObject({ verdict: "fail", implementer: "unknown" });
    expect(run.attemptLog!.map((item) => `${item.model}:${item.outcome}`)).toContain("hand fix:failure");
  });
});

describe("aborting and resuming", () => {
  it("resumes on the escalated tier, and repeated aborts never climb or exceed maxEscalations", async () => {
    const t = await setup({ mutate: (config) => void (config.routing.maxEscalations = 1) });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    const aborted = (name: string) => {
      const d = fakeDriver(t.cwd, () => ({ aborted: true }));
      return t.run(d.driver).then(() => d);
    };
    // Escalated to the second tier, then aborted; resuming stays there, however often.
    for (let i = 0; i < 3; i++) {
      const d = await aborted(`abort ${i}`);
      expect(d.sends.map((item) => item.model.id)).toEqual(["claude-sonnet-5-5"]);
      expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "in-progress", tier: "medium" });
    }
    const resumed = fakeDriver(t.cwd, () => resumed.write("g.txt"));
    await t.run(resumed.driver);
    expect(resumed.sends[0]!.model.id).toBe("claude-sonnet-5-5");
    // Still failing there: maxEscalations (1) is used up.
    const last = fakeDriver(t.cwd, () => undefined);
    expect((await t.run(last.driver)).code).toBe("MAX_ESCALATIONS");
  });

  it("keeps the review fail count per tier: abort and resume cannot buy more review rounds", async () => {
    const t = await setup({ answer: roles({ review: () => fail() }) });
    const first = fakeDriver(t.cwd, (send) => (send.turn === 0 ? d1.write("f.txt") : { aborted: true }));
    const d1 = first;
    const aborted = await t.run(first.driver);
    expect(aborted.ok).toBe(false);
    expect(first.sends).toHaveLength(2);
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "in-progress", tier: "low" });
    const second = fakeDriver(t.cwd, () => second.write("g.txt"));
    const result = await t.run(second.driver);
    expect(result.code).toBe("REVIEW_FAILED");
    // One review already failed at this tier, so the next failure is final: no retry turn.
    expect(second.sends).toHaveLength(1);
    expect(t.load().ticketRuns!["01"]!.reviews!.map((item) => item.round)).toEqual([1, 2]);
  });
});

describe("reviewTicket never throws", () => {
  it("returns unavailable when the diff blows up, and keeps the verdict when only the ledger does", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })] });
    const state = t.load();
    const ticket = state.plan!.tickets![0]!;
    const run = { status: "in-progress", attempts: 1, tier: "high", provider: "openai", model: "gpt-6.1-sol" } as never;
    vi.spyOn(t.ctx.git, "workingDiff").mockRejectedValueOnce(new Error("git exploded"));
    const outcome = await reviewTicket(t.ctx, state, ticket, run);
    expect(outcome).toMatchObject({ kind: "unavailable", record: { verdict: "unavailable" } });
    expect(outcome!.record.rationale).toContain("git exploded");
    const ledger = vi.spyOn(t.ctx.store, "appendLedger").mockImplementation(() => {
      throw new Error("disk full");
    });
    const second = await reviewTicket(t.ctx, state, ticket, run);
    // A ledger that cannot be written does not hide the verdict; the review's cost is unknown, never zero.
    expect(second).toMatchObject({ kind: "pass", record: { costUsd: { review: null } } });
    expect(t.progress.some((line) => line.includes("could not ledger the review's usage: disk full"))).toBe(true);
    ledger.mockRestore();
  });
});
