import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardHits } from "../src/cli/bash-guard.js";
import { main } from "../src/cli/shepherd.js";
import { sampleSpec, tempRepo } from "./helpers.js";

const CONFIG = `
models: { low: anthropic/claude-haiku, medium: anthropic/claude-sonnet, high: anthropic/claude-opus, review: anthropic/claude-opus }
`;

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
});

const ticket = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  slug: `step-${id}`,
  title: `Step ${id}`,
  whatToBuild: `Build part ${id}.`,
  implementation: "Edit src/ingest.ts.",
  acceptanceCriteria: ["retry works"],
  blockedBy: [],
  difficulty: "medium",
  files: [`src/f${id}.ts`],
  estimatedContextTokens: 30_000,
  checks: ["npm test"],
  ...extra,
});

async function setup() {
  const home = mkdtempSync(path.join(tmpdir(), "plan-home-"));
  process.env.HOME = home;
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "shepherd.yaml"), CONFIG);
  const repo = await tempRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "plan-inputs-"));
  const cli = async (args: string[], stdin = "") => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (text) => out.push(text), err: (text) => err.push(text) }, { stdin, env: { SHEPHERD_HOME: path.join(home, "shepherd-home") }, now: () => new Date("2026-10-14T12:00:00.000Z"), home, cwd: repo });
    const text = out.join("");
    let json: { ok: boolean; code?: string; text: string; data?: any } | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { code, out: text, err: err.join(""), json };
  };
  const file = (name: string, value: unknown) => {
    const where = path.join(dir, name);
    writeFileSync(where, typeof value === "string" ? value : JSON.stringify(value));
    return where;
  };
  const pretool = (command: string) =>
    cli(["hook", "pretool"], JSON.stringify({ session_id: "s", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
  return { repo, cli, file, pretool };
}

describe("shepherd plan", () => {
  it("runs start, spec, bad tickets, good tickets, show and approve", async () => {
    const t = await setup();

    const start = await t.cli(["plan", "start", "Add retry to the ingest parser", "--json"]);
    expect(start.code).toBe(0);
    expect(start.json?.ok).toBe(true);
    expect(start.json?.data.name).toBe("retry-ingest-parser");
    expect(start.json?.text).toContain("shepherd plan spec");
    expect(start.json?.text).toContain('"classificationReason"'); // the spec schema is printed
    expect(start.json?.text).not.toContain('"estimatedContextTokens"'); // the ticket schema comes once, when the spec is saved

    // Approving before there are tickets fails.
    const early = await t.cli(["plan", "approve", "--json"]);
    expect(early.code).toBe(1);
    expect(early.json).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });

    // Tickets before the spec are refused, in the CLI's words.
    const wrong = await t.cli(["plan", "tickets", t.file("early.json", { tickets: [ticket("01")] }), "--json"]);
    expect(wrong.json?.ok).toBe(false);
    expect(wrong.json?.text).toContain("shepherd plan spec");
    expect(wrong.json?.text).not.toContain("plan_spec");

    const badSpec = await t.cli(["plan", "spec", t.file("bad-spec.json", { summary: "x" }), "--json"]);
    expect(badSpec.json).toMatchObject({ ok: false, code: "SPEC_INVALID" });

    const spec = await t.cli(["plan", "spec", t.file("spec.json", sampleSpec), "--json"]);
    expect(spec.code).toBe(0);
    expect(spec.json?.text).toContain("Tickets JSON");

    // Every problem is listed at once.
    const bad = await t.cli(
      ["plan", "tickets", t.file("bad.json", { tickets: [ticket("01", { difficulty: "huge" }), ticket("02", { checks: ["no-such-command-xyz"] }), ticket("x4")] }), "--json"],
    );
    expect(bad.code).toBe(1);
    expect(bad.json?.code).toBe("TICKETS_INVALID");
    expect(bad.json?.text).toContain('difficulty "huge"');
    expect(bad.json?.text).toContain("no-such-command-xyz");
    expect(bad.json?.text).toContain("id must be");
    expect(bad.json?.text).not.toContain("plan_tickets");

    // Sizing is checked once the rest is valid.
    const big = await t.cli(["plan", "tickets", t.file("big.json", { tickets: [ticket("01", { estimatedContextTokens: 9_000_000 })] }), "--json"]);
    expect(big.json?.text).toContain("above the");
    expect(big.json?.text).toContain("`shepherd plan tickets` again");

    // Still not approvable.
    expect((await t.cli(["plan", "approve"])).code).toBe(1);

    // Good tickets, read from stdin as a bare array.
    const good = await t.cli(["plan", "tickets", "-", "--json"], JSON.stringify([ticket("01", { difficulty: "low" }), ticket("02", { difficulty: "high", blockedBy: ["01"] })]));
    expect(good.code).toBe(0);
    expect(good.json?.data).toMatchObject({ version: 1, tickets: 2, planFile: "_plans/retry-ingest-parser.md" });
    expect(good.json?.text).toContain("Plan file: _plans/retry-ingest-parser.md");
    // The plan is written for the user to read, and its folder keeps it out of git (so out of ticket commits and reviews).
    const planFile = path.join(t.repo, "_plans", "retry-ingest-parser.md");
    expect(readFileSync(planFile, "utf8")).toContain("| 02 | Step 02 | high | anthropic/claude-opus | 01 |");
    expect(readFileSync(path.join(t.repo, "_plans", ".gitignore"), "utf8")).toMatch(/^\*$/m);
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: t.repo, encoding: "utf8" })).not.toContain("_plans");

    const show = await t.cli(["plan", "show"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("retry-ingest-parser");
    expect(show.out).toContain("| 01 | Step 01 | low | anthropic/claude-haiku |");
    expect(show.out).toContain("| 02 | Step 02 | high | anthropic/claude-opus | 01 |");
    expect(show.out).toContain("~30K tokens");
    expect(show.out.split("\n")[0]).toBe("Plan file: _plans/retry-ingest-parser.md (open it in herdr's Files panel).");

    const approve = await t.cli(["plan", "approve", "--json"]);
    expect(approve.code).toBe(0);
    expect(approve.json?.text).toContain("Approved plan v1");
    expect(approve.json?.text).toContain("/shepherd:build");
    expect(readFileSync(planFile, "utf8")).toContain("approved");
    expect(existsSync(planFile)).toBe(true);
    expect((await t.cli(["plan", "approve", "--json"])).json?.text).toContain("already approved");
  });

  it("sends a draft back with plan revise and takes a new spec and tickets", async () => {
    const t = await setup();
    await t.cli(["plan", "start", "Add retry to the ingest parser"]);
    await t.cli(["plan", "spec", t.file("spec.json", sampleSpec)]);
    await t.cli(["plan", "tickets", t.file("t.json", { tickets: [ticket("01")] })]);
    const revise = await t.cli(["plan", "revise", "Split it in two", "--json"]);
    expect(revise.json?.ok).toBe(true);
    expect((await t.cli(["plan", "approve"])).code).toBe(1);
    expect((await t.cli(["plan", "spec", t.file("spec2.json", sampleSpec)])).code).toBe(0);
    const again = await t.cli(["plan", "tickets", t.file("t2.json", { tickets: [ticket("01"), ticket("02")] }), "--json"]);
    expect(again.json?.data).toMatchObject({ tickets: 2 }); // an unapproved draft keeps its version
    expect((await t.cli(["plan", "approve"])).code).toBe(0);
  });

  it("fails cleanly on bad input and never throws", async () => {
    const t = await setup();
    expect((await t.cli(["plan", "start", "--json"])).json).toMatchObject({ ok: false, code: "USAGE" });
    await t.cli(["plan", "start", "Add retry"]);
    expect((await t.cli(["plan", "spec", "/nonexistent/spec.json", "--json"])).json).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect((await t.cli(["plan", "spec", "-", "--json"], "{not json")).json).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect((await t.cli(["plan", "spec", "--json"])).json).toMatchObject({ ok: false, code: "USAGE" });
    expect((await t.cli(["plan", "nope"])).code).toBe(1);
    expect((await t.cli(["plan", "show"])).code).toBe(1); // no plan yet
  });

  it("lists, switches and closes tasks with plans and task", async () => {
    const t = await setup();
    await t.cli(["plan", "start", "Add retry to the ingest parser"]);
    await t.cli(["plan", "start", "Rename the config loader"]);
    const list = await t.cli(["plans", "--json"]);
    expect(list.json?.text).toContain("retry-ingest-parser");
    expect(list.json?.text).toContain("rename-config-loader");
    expect((await t.cli(["task", "list"])).out).toContain("rename-config-loader");
    const use = await t.cli(["task", "use", "retry-ingest-parser", "--json"]);
    expect(use.json?.text).toContain("Switched to retry-ingest-parser");
    expect((await t.cli(["task", "close", "rename-config-loader"])).out).toContain("Closed rename-config-loader");
    expect((await t.cli(["task", "list"])).out).not.toContain("rename-config-loader");
    expect((await t.cli(["task", "close", "--json"])).json?.text).toContain("Closed retry-ingest-parser");
  });
});

describe("hook pretool plan approve", () => {
  it("asks the user, naming the task, tickets and models, and passes read-only plan commands", async () => {
    const t = await setup();
    await t.cli(["plan", "start", "Add retry to the ingest parser"]);
    await t.cli(["plan", "spec", t.file("spec.json", sampleSpec)]);
    await t.cli(["plan", "tickets", t.file("t.json", { tickets: [ticket("01", { difficulty: "low" }), ticket("02"), ticket("03", { difficulty: "low" })] })]);

    const ask = await t.pretool("shepherd plan approve");
    const out = JSON.parse(ask.out).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toBe("Approve the plan for retry-ingest-parser? 3 tickets, models 2 low (anthropic/claude-haiku), 1 medium (anthropic/claude-sonnet). Approving lets /shepherd:build run it.");

    expect((await t.pretool("shepherd plan show")).out).toBe("");
    expect((await t.pretool("shepherd plan tickets /tmp/t.json")).out).toBe("");
    expect((await t.pretool("echo hi")).out).toBe("");
    // The approve in a chain or wrapper is still caught; a mention is not.
    for (const command of ["shepherd plan show && shepherd plan approve", "sh -c 'shepherd plan approve'", "shepherd --json plan approve", "node dist/shepherd.mjs plan approve", "/x/bin/shepherd plan approve --json"]) {
      expect(JSON.parse((await t.pretool(command)).out).hookSpecificOutput.permissionDecision, command).toBe("ask");
    }
    expect((await t.pretool("echo shepherd plan approve")).out).toBe("");
    expect(guardHits("shepherd plan approve")).toEqual(["plan approve"]);
  });

  it("still asks when there is no draft, and says so", async () => {
    const t = await setup();
    const out = JSON.parse((await t.pretool("shepherd plan approve")).out).hookSpecificOutput;
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toContain("no drafted plan");
  });
});
