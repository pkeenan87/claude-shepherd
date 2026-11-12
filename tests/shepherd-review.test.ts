import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CostRecord } from "../src/domain.js";
import { main, type CliOptions } from "../src/cli/shepherd.js";
import { fakeHerdrClient, type FakeHerdrClientOptions, type FakeTab } from "./herdr-fake.js";
import { checkRunner, tempRepo } from "./helpers.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
});

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const FINDINGS = [
  { likelihood: 8, severity: 7, category: "bug", file: "src/ingest.ts", message: "ingest drops the last record." },
  { likelihood: 1, severity: 2, category: "style", message: "naming nit" },
];

interface Doc {
  ok: boolean;
  code?: string;
  text: string;
  data?: { report: string | null; findings: { n: number; title: string; file: string | null; line: number | null; risk: string }[]; passed: boolean; fixTab: string | null };
}

const outFileOf = (prompt: string) => /findings to (\S+) \(no prose/.exec(prompt)![1]!;

/** A repo with an uncommitted file holding an eval (a static finding); a fake herdr whose reviewer writes FINDINGS and whose fixer does what `onFix` says. */
async function setup(options: { config?: string; eval?: boolean; fake?: FakeHerdrClientOptions; piAvailable?: boolean; onFix?: (tab: FakeTab) => void } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "review-home-"));
  process.env.HOME = home;
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "shepherd.yaml"), `checks:\n  - { name: unit, command: npm, args: ["test"] }\n${options.config ?? "models: { low: agent:claude, medium: agent:gemini, high: agent:claude, review: agent:claude }\n"}`);
  const repo = await tempRepo();
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "ingest.ts"), options.eval ? "export const ingest = (s: string) => eval(s);\n" : "export const ingest = 1;\n");
  const prompts: string[] = [];
  const fake = fakeHerdrClient({
    onSend: (tab, text) => {
      prompts.push(text);
      if (/findings to \S+ \(no prose/.test(text)) {
        writeFileSync(outFileOf(text), JSON.stringify(FINDINGS));
        if (tab.sessionDir) {
          const [provider, ...rest] = tab.model.replace(/:.*$/, "").split("/");
          const sm = SessionManager.create("/work", tab.sessionDir);
          sm.appendMessage({ role: "user", content: "t", timestamp: Date.now() } as never);
          sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "x", provider, model: rest.join("/"), usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 2200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
        }
      } else options.onFix?.(tab);
    },
    ...options.fake,
  });
  const cli = async (args: string[], extra: Partial<CliOptions> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      args,
      { out: (text) => out.push(text), err: (text) => err.push(text) },
      {
        env: { SHEPHERD_HOME: path.join(home, "shepherd-home") },
        now: () => new Date("2026-10-14T12:00:00.000Z"),
        home,
        cwd: repo,
        herdr: fake.client,
        runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })),
        herdrTimings: { sleep: async () => undefined },
        piAvailable: () => options.piAvailable ?? true,
        ticketModePath: "/shepherd/dist/ticket-mode.mjs",
        ...extra,
      },
    );
    const text = out.join("");
    let json: Doc | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { code, out: text, err: err.join(""), json };
  };
  const ledger = (): CostRecord[] => !existsSync(path.join(repo, ".shepherd", "cost", "ledger.jsonl")) ? [] : readFileSync(path.join(repo, ".shepherd", "cost", "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CostRecord);
  return { repo, home, cli, fake, prompts, ledger };
}

describe("shepherd review", () => {
  it("runs the model pass in a herdr sub-agent, numbers the findings, saves the report and ledgers 'model review'", async () => {
    const t = await setup();
    const run = await t.cli(["review", "--json"]);
    expect(run.err).toBe("");
    expect(run.json?.text).toContain("### ");
    expect(run.json?.text).toContain("ingest drops the last record.");
    expect(run.json?.data?.passed).toBe(true);
    expect(run.code).toBe(0);
    const { findings, report, fixTab } = run.json!.data!;
    expect(findings).toEqual([{ n: 1, title: "ingest drops the last record.", file: "src/ingest.ts", line: null, risk: "L8×S7=56" }]);
    expect(run.json?.text).toContain("| 1 | L8×S7=56 | src/ingest.ts | ingest drops the last record. |");
    expect(run.json?.text).toContain(".shepherd/reports/review-20261014-120000.md");
    expect(fixTab).toBe("agent:gemini");
    expect(path.isAbsolute(report!)).toBe(true);
    expect(existsSync(report!)).toBe(true);
    expect(readFileSync(report!, "utf8")).toContain("ingest drops the last record.");
    // One sub-agent, the claude agent, in the repo; closed once the findings were read.
    expect(t.fake.tabs).toHaveLength(1);
    expect(t.fake.tabs[0]!.options.cwd).toBe(t.repo);
    expect(t.fake.tabs[0]!.killed).toBe(true);
    const rows = t.ledger().filter((row) => row.reason === "model review");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "agent", model: "claude", tier: "review", phase: "REVIEWING", meter: "not-metered" });
  });

  it("runs a Pi model reviewer as a pi child in a tab and ledgers its session files as 'model review'", async () => {
    const t = await setup();
    const run = await t.cli(["review", "--with", "openai/gpt-6.1-sol", "--json"]);
    expect(run.json?.ok, run.out + run.err).toBe(true);
    expect(run.json?.data?.findings.map((finding) => finding.n)).toEqual([1]);
    const tab = t.fake.tabs[0]!;
    expect(tab.options.argv.slice(0, 1)).toEqual(["env"]);
    expect(tab.options.argv).toContain("/shepherd/dist/ticket-mode.mjs");
    expect(tab.model).toBe("openai/gpt-6.1-sol");
    expect(tab.killed).toBe(true);
    const rows = t.ledger().filter((row) => row.reason === "model review");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "openai", model: "gpt-6.1-sol", inputTokens: 2000, outputTokens: 200, phase: "REVIEWING", tier: "review", taskId: "session" });
  });

  it("without herdr still runs the checks and the static scan, and says the model pass needs herdr", async () => {
    const t = await setup({ fake: { self: { problem: "HC_TERMINAL_ID is not set" } as never } });
    const run = await t.cli(["review", "--json"]);
    expect(run.code).toBe(0);
    expect(run.json?.ok).toBe(true);
    expect(run.json?.text).toContain("the model pass needs herdr");
    expect(run.json?.data?.findings).toEqual([]);
    expect(run.json?.data?.fixTab).toBeNull();
    expect(t.fake.tabs).toEqual([]);
    expect(t.ledger().filter((row) => row.reason === "model review")).toEqual([]);
  });

  it("numbers static findings first, and a blocking one fails the review (the model pass stays advisory)", async () => {
    const t = await setup({ eval: true });
    const run = await t.cli(["review", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ ok: false, code: "REVIEW_BLOCKING", data: { passed: false, fixTab: "agent:gemini" } });
    expect(run.json?.data?.findings.map((finding) => [finding.n, finding.risk])).toEqual([[1, "BLOCKING"], [2, "L8×S7=56"]]);
    expect(run.json?.text).toContain("then /shepherd:review again");
  });

  it("says a Pi reviewer needs pi on PATH, and rejects stray arguments", async () => {
    const t = await setup({ piAvailable: false });
    const run = await t.cli(["review", "--with", "openai/gpt-6.1-sol", "--json"]);
    expect(run.json?.ok).toBe(true);
    expect(run.json?.text).toContain("`pi` is not on PATH");
    expect(t.fake.tabs).toEqual([]);
    const bad = await t.cli(["review", "--bogus"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Usage: shepherd review");
  });

  it("prints the plain report without --json and reports nothing-to-review", async () => {
    const t = await setup();
    const run = await t.cli(["review"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("ingest drops the last record.");
    gitIn(t.repo, "add", "-A");
    gitIn(t.repo, "commit", "-m", "x");
    const empty = await t.cli(["review", "--json"]);
    expect(empty.json).toMatchObject({ ok: true, data: { report: null, findings: [], passed: true, fixTab: null } });
    expect(empty.json?.text).toContain("Nothing to review");
  });
});

describe("shepherd fix", () => {
  it("--list prints the numbered findings and the rules of the latest report, without opening a tab", async () => {
    const t = await setup();
    await t.cli(["review", "--json"]);
    const tabs = t.fake.tabs.length;
    const list = await t.cli(["fix", "--list", "--json"]);
    expect(list.code).toBe(0);
    expect(list.json?.text).toContain("Fix all 1 finding(s) from the review.");
    expect(list.json?.text).toContain("1. L8×S7 src/ingest.ts: ingest drops the last record.");
    expect(list.json?.text).toContain("Do not commit, push, or switch branches.");
    expect(list.json?.text).toContain("/shepherd:review again");
    expect(t.fake.tabs).toHaveLength(tabs);
  });

  it("--tab fixes in a sub-agent on models.medium, ledgers 'review fix', never commits", async () => {
    const t = await setup({
      onFix: (tab) => {
        writeFileSync(path.join(tab.options.cwd!, "src", "ingest.ts"), "export const ingest = (s: string) => s;\n");
        gitIn(tab.options.cwd!, "add", "-A");
        gitIn(tab.options.cwd!, "commit", "-m", "agent commit");
      },
      fake: { read: () => "Addressed 1." },
    });
    const head = gitIn(t.repo, "rev-parse", "HEAD");
    await t.cli(["review", "--json"]);
    const fix = await t.cli(["fix", "--tab", "--json"]);
    expect(fix.json?.ok, fix.out + fix.err).toBe(true);
    expect(fix.json?.text).toContain("Fixed in tab");
    expect(fix.json?.text).toContain("nothing committed");
    expect(fix.json?.text).toContain("Run /shepherd:review to check.");
    expect(fix.json?.text).toContain("git reset --soft");
    expect(gitIn(t.repo, "rev-parse", "HEAD")).toBe(head);
    expect(gitIn(t.repo, "status", "--porcelain")).toContain("src/ingest.ts");
    const tab = t.fake.tabs[1]!;
    expect(tab.options.argv).toContain("gemini");
    expect(tab.sends[0]).toContain("Fix all 1 finding(s)");
    expect(tab.sends[0]).not.toContain("Run /review again");
    const rows = t.ledger().filter((row) => row.reason === "review fix");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "agent", model: "gemini", tier: "medium", phase: "REVIEWING" });
  });

  it("--tab on a Pi models.medium launches a pi child and needs pi on PATH instead of a registry", async () => {
    const config = "models: { low: agent:claude, medium: openai/gpt-6.1-sol, high: agent:claude, review: agent:claude }\n";
    const ok = await setup({ config, fake: { read: () => "" } });
    await ok.cli(["review", "--json"]);
    const fixed = await ok.cli(["fix", "--tab", "--json"], {});
    expect(fixed.json?.ok, fixed.out + fixed.err).toBe(true);
    expect(ok.fake.tabs[1]!.model).toBe("openai/gpt-6.1-sol");
    const no = await setup({ config, piAvailable: false });
    await no.cli(["review", "--json"]);
    const refused = await no.cli(["fix", "--tab", "--json"]);
    expect(refused.json).toMatchObject({ ok: false, code: "REVIEW_FIX_FAILED" });
    expect(refused.json?.text).toContain("`pi` is not on PATH");
    expect(no.fake.tabs).toHaveLength(1);
  });

  it("--tab needs herdr and a review; --list needs a review; bad flags print usage", async () => {
    const t = await setup({ eval: true, fake: { self: { problem: "HC_TERMINAL_ID is not set" } as never } });
    const none = await t.cli(["fix", "--tab", "--json"]);
    expect(none.json).toMatchObject({ ok: false, code: "NO_REVIEW" });
    expect((await t.cli(["fix", "--list", "--json"])).json).toMatchObject({ ok: false, code: "NO_REVIEW" });
    await t.cli(["review", "--json"]);
    const outside = await t.cli(["fix", "--tab", "--json"]);
    expect(outside.json).toMatchObject({ ok: false, code: "NEEDS_HERDR" });
    expect(outside.json?.text).toContain("needs herdr");
    expect(t.fake.tabs).toEqual([]);
    const usage = await t.cli(["fix"]);
    expect(usage.code).toBe(1);
    expect(usage.err).toContain("Usage: shepherd fix");
  });
});
