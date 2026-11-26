import { pathToFileURL } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The panel's pure helpers (herdr/shepherd-config/lib.js); main.js needs herdr's runtime and is checked with `herdr-app check`.
type Helpers = {
  looksSecret(text: string): boolean;
  modelValue(kind: string, parts: Record<string, string>): { value?: string; error?: string };
  agentPick(row: { kind: string; agent?: string }, name: string): Record<string, string>;
  fmtUsd(n: number): string;
  ratio(spend: number, limit: number): number;
  ctxText(n: number): string;
  ticketsText(plan: { ticketsDone: number; ticketsTotal: number; ticketsFailed: number }): string;
  parseResult(r: { stdout: string; stderr: string; code: number }): Record<string, unknown>;
  setArgv(root: string, key: string, value: string, sha?: string): string[];
  numberText(n: unknown): string;
  positive(text: string): number | null;
};
let h: Helpers;
beforeAll(async () => {
  h = (await import(pathToFileURL(path.join(__dirname, "..", "herdr", "shepherd-config", "lib.js")).href)) as Helpers;
});

describe("panel helpers", () => {
  it("changing the agent drops the model text typed for the earlier one; the same agent keeps it", () => {
    const row = { kind: "agent", agent: "claude" };
    expect(h.agentPick(row, "codex")).toEqual({ agent: "codex", agentModel: "" });
    expect(h.agentPick(row, "claude")).toEqual({ agent: "claude" });
    expect(h.agentPick({ kind: "pi" }, "claude")).toEqual({ agent: "claude", agentModel: "" });
  });

  it("builds the models.* value for each kind", () => {
    expect(h.modelValue("pi", { piText: "  anthropic/claude-sonnet-5-5:high " })).toEqual({ value: "anthropic/claude-sonnet-5-5:high" });
    expect(h.modelValue("local", { localId: "Qwen3.8-27B" })).toEqual({ value: "local/Qwen3.8-27B" });
    expect(h.modelValue("agent", { agent: "claude", agentModel: "" })).toEqual({ value: "agent:claude" });
    expect(h.modelValue("agent", { agent: "codex", agentModel: " gpt-6 " })).toEqual({ value: "agent:codex/gpt-6" });
  });

  it("explains an input that cannot be a model", () => {
    for (const parts of [{ piText: "" }, { piText: "grok" }, { piText: "a b/c" }, { piText: "x/" }, { piText: "/x" }]) expect(h.modelValue("pi", parts).error, JSON.stringify(parts)).toBeTruthy();
    expect(h.modelValue("local", { localId: "" }).error).toContain("Pick");
    expect(h.modelValue("agent", { agent: "" }).error).toContain("Pick");
    expect(h.modelValue("agent", { agent: "claude", agentModel: "a b" }).error).toContain("spaces");
  });

  it("never lets a secret reach an argv", () => {
    expect(h.modelValue("pi", { piText: "openai/sk-proj-abcdefghijklmnopqrstu" }).error).toContain("secret");
    expect(h.modelValue("agent", { agent: "claude", agentModel: "ghp_abcdefghijklmnopqrstuvwxyz" }).error).toContain("secret");
    expect(h.looksSecret("Bearer abcdefghijkl")).toBe(true);
    expect(h.looksSecret("anthropic/claude-opus-5-5")).toBe(false);
    expect(h.looksSecret("local/Qwen3.8-27B-Q4_K_M-00001-of-00002")).toBe(false);
  });

  it("formats money, context sizes, ratios and tickets", () => {
    expect([h.fmtUsd(0), h.fmtUsd(4.049), h.fmtUsd(0.0042), h.fmtUsd(123.4), h.fmtUsd(NaN)]).toEqual(["$0", "$4.05", "$0.0042", "$123", "—"]);
    expect([h.ctxText(131072), h.ctxText(4096), h.ctxText(800), h.ctxText(NaN)]).toEqual(["128k", "4k", "800", "?"]);
    expect([h.ratio(5, 20), h.ratio(30, 20), h.ratio(0, 20), h.ratio(5, 0)]).toEqual([0.25, 1, 0, 0]);
    expect(h.ticketsText({ ticketsDone: 1, ticketsTotal: 3, ticketsFailed: 0 })).toBe("1/3 tickets");
    expect(h.ticketsText({ ticketsDone: 1, ticketsTotal: 3, ticketsFailed: 2 })).toBe("1/3 tickets, 2 failed");
  });

  it("reads the CLI's answer, or says what it printed instead", () => {
    expect(h.parseResult({ stdout: '{"ok":true,"plans":[]}\n', stderr: "", code: 0 })).toEqual({ ok: true, plans: [] });
    const bad = h.parseResult({ stdout: "", stderr: "node: not found", code: 127 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("exit 127");
    expect(bad.error).toContain("node: not found");
  });

  it("builds the set argv with the stale-write guard, and reads numbers", () => {
    expect(h.setArgv("/p", "models.low", "local/a", "abc")).toEqual(["set", "--cwd", "/p", "--key", "models.low", "--value", "local/a", "--expect", "abc"]);
    expect(h.setArgv("/p", "budgets.taskUsd", "7")).toEqual(["set", "--cwd", "/p", "--key", "budgets.taskUsd", "--value", "7"]);
    expect([h.positive("7.5"), h.positive(" 3 "), h.positive("0"), h.positive("-1"), h.positive("x"), h.positive("")]).toEqual([7.5, 3, null, null, null, null]);
    expect([h.numberText(20), h.numberText(0.30000000000000004), h.numberText(undefined)]).toEqual(["20", "0.3", ""]);
  });
});

describe("panel descriptor and target fallbacks", () => {
  it("parses the descriptor out of login-profile noise in the shell output", () => {
    const noise = "Last login: Sun Sep  7 12:00:00 2026 from host\n" + JSON.stringify({ version: 1, plugin: "0.1.0", cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"] }) + "\n";
    expect((h as ExtendedHelpers).parseCliDescriptor(noise)).toEqual({ cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"], plugin: "0.1.0" });
    // herdr-install --remote writes the file pretty-printed: noise before a multi-line descriptor still parses.
    const pretty = "Last login: Thu\nWelcome {friend}\n" + JSON.stringify({ version: 1, plugin: "0.1.0", cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"] }, null, 2) + "\n";
    expect((h as ExtendedHelpers).parseCliDescriptor(pretty)).toEqual({ cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"], plugin: "0.1.0" });
  });

  it("treats an empty folder ('home') as no folder, falling back to the previous folder and to localHome", () => {
    const spaces = [{ id: "s1", machine: null, folder: "" }];
    const noCwd = (h as ExtendedHelpers).resolveTarget({ focused: { space: "s1" }, spaces, forcedFolder: null, previous: { machine: null, folder: "/prev/local" }, localHome: "/home/me" });
    expect(noCwd).toEqual({ machine: null, folder: "/prev/local" });
    const noPrevious = (h as ExtendedHelpers).resolveTarget({ focused: { space: "s1" }, spaces, forcedFolder: null, previous: null, localHome: "/home/me" });
    expect(noPrevious).toEqual({ machine: null, folder: "/home/me" });
    const noPreviousHome = (h as ExtendedHelpers).resolveTarget({ focused: { space: "s1" }, spaces: [], forcedFolder: null, previous: null, localHome: null });
    expect(noPreviousHome).toEqual({ machine: null, folder: null });
  });
});

describe("panel model picker with a Cursor model", () => {
  it("builds agent:cursor-agent/auto and the auto-smart settings, brackets and equals sign intact, and does not call them secrets", () => {
    expect(h.modelValue("agent", { agent: "cursor-agent", agentModel: "auto" })).toEqual({ value: "agent:cursor-agent/auto" });
    for (const setting of ["cost", "balanced", "intelligence"]) {
      expect(h.modelValue("agent", { agent: "cursor-agent", agentModel: `auto-smart[optimize_for=${setting}]` })).toEqual({ value: `agent:cursor-agent/auto-smart[optimize_for=${setting}]` });
    }
    expect(h.modelValue("agent", { agent: "cursor-agent", agentModel: "auto-smart [optimize_for=cost]" }).error).toMatch(/no spaces/);
  });
});

type Target = { machine: string | null; folder: string | null };
type Descriptor = { cli?: string[]; plugin?: string; error?: string };
type ExtendedHelpers = Helpers & {
  resolveTarget(args: { focused?: { cwd?: string; space?: string; terminal?: string }; spaces?: Array<{ id: string; machine?: string | null; folder?: string }>; forcedFolder?: string | null; previous?: { machine: string | null; folder: string | null } | null; localHome?: string | null }): Target;
  targetKey(machine: string | null, root: string): string;
  parseCliDescriptor(raw: string): Descriptor;
  remoteCliMissing(machine: string): string;
  machineOfAddress(addr: string): string | null;
  termInTarget(term: { address?: string; cwd?: string }, machine: string | null, root?: string | null): boolean;
  findSpace(spaces: Array<{ id: string; machine?: string | null; folder?: string }>, machine: string | null, folder: string | null): { id: string } | null;
};

describe("machine-aware panel targets", () => {
  it("resolves a remote machine from the focused space, or the terminal address prefix, and never falls back to local paths", () => {
    const spaces = [{ id: "omarchy/s1", machine: "omarchy", folder: "/remote/repo" }, { id: "l1", machine: null, folder: "/local/repo" }];
    const remote = (h as ExtendedHelpers).resolveTarget({ focused: { space: "omarchy/s1" }, spaces, forcedFolder: "/forced", previous: { machine: null, folder: "/prev" }, localHome: "/home/me" });
    expect(remote).toEqual({ machine: "omarchy", folder: "/remote/repo" });
    const fromAddress = (h as ExtendedHelpers).resolveTarget({ focused: { space: "unknown", terminal: "omarchy/t7" }, spaces, forcedFolder: "/forced", previous: null, localHome: "/home/me" });
    expect(fromAddress.machine).toBe("omarchy");
    expect(fromAddress.folder).toBeNull();
    const remoteCwd = (h as ExtendedHelpers).resolveTarget({ focused: { space: "omarchy/s1", cwd: "/remote/repo/sub" }, spaces, forcedFolder: "/forced", previous: { machine: "omarchy", folder: "/prev" }, localHome: "/home/me" });
    expect(remoteCwd).toEqual({ machine: "omarchy", folder: "/remote/repo/sub" });
  });

  it("reuses the previous folder only on the same machine, and local targets fall back to home", () => {
    const spaces = [{ id: "s1", machine: null, folder: "/local/repo" }, { id: "omarchy/s2", machine: "omarchy", folder: "/remote/repo" }];
    const same = (h as ExtendedHelpers).resolveTarget({ focused: { space: "s1" }, spaces, forcedFolder: null, previous: { machine: null, folder: "/prev/local" }, localHome: "/home/me" });
    expect(same.folder).toBe("/local/repo");
    const noSpaces = (h as ExtendedHelpers).resolveTarget({ focused: { space: "gone" }, spaces: [], forcedFolder: null, previous: { machine: null, folder: "/prev/local" }, localHome: "/home/me" });
    expect(noSpaces).toEqual({ machine: null, folder: "/prev/local" });
    const wrongMachine = (h as ExtendedHelpers).resolveTarget({ focused: { space: "omarchy/s2" }, spaces, forcedFolder: null, previous: { machine: null, folder: "/prev/local" }, localHome: "/home/me" });
    expect(wrongMachine).toEqual({ machine: "omarchy", folder: "/remote/repo" });
    const remoteNoPrevious = (h as ExtendedHelpers).resolveTarget({ focused: { space: "omarchy/s2", cwd: undefined }, spaces, forcedFolder: "/forced", previous: { machine: "other", folder: "/prev/remote" }, localHome: "/home/me" });
    expect(remoteNoPrevious.folder).toBe("/remote/repo");
    const remoteNoFolder = (h as ExtendedHelpers).resolveTarget({ focused: { space: "omarchy/s2" }, spaces: [{ id: "omarchy/s2", machine: "omarchy" }], forcedFolder: "/forced", previous: null, localHome: "/home/me" });
    expect(remoteNoFolder).toEqual({ machine: "omarchy", folder: null });
  });

  it("keys state per machine and root", () => {
    expect((h as ExtendedHelpers).targetKey(null, "/repo")).toBe(":/repo");
    expect((h as ExtendedHelpers).targetKey("omarchy", "/repo")).not.toBe((h as ExtendedHelpers).targetKey(null, "/repo"));
    expect((h as ExtendedHelpers).targetKey("omarchy", "/repo")).toBe("omarchy:/repo");
  });

  it("parses addresses, terminals and spaces per machine", () => {
    expect((h as ExtendedHelpers).machineOfAddress("t7")).toBeNull();
    expect((h as ExtendedHelpers).machineOfAddress("omarchy/t7")).toBe("omarchy");
    expect((h as ExtendedHelpers).machineOfAddress("")).toBeNull();
    const term = { address: "omarchy/t7", cwd: "/remote/repo" };
    expect((h as ExtendedHelpers).termInTarget(term, "omarchy", "/remote/repo")).toBe(true);
    expect((h as ExtendedHelpers).termInTarget(term, "omarchy", "/remote/repo/sub")).toBe(false);
    expect((h as ExtendedHelpers).termInTarget(term, "omarchy", null)).toBe(true);
    expect((h as ExtendedHelpers).termInTarget(term, null, "/remote/repo")).toBe(false);
    expect((h as ExtendedHelpers).termInTarget({ address: "t7", cwd: "/remote/repo" }, null, "/remote/repo")).toBe(true);
    expect((h as ExtendedHelpers).termInTarget({ address: "t7", cwd: "/remote/repo" }, "omarchy", "/remote/repo")).toBe(false);
    expect((h as ExtendedHelpers).findSpace([{ id: "a", machine: "omarchy", folder: "/repo" }, { id: "b", machine: null, folder: "/repo" }], "omarchy", "/repo")?.id).toBe("a");
    expect((h as ExtendedHelpers).findSpace([{ id: "a", machine: "omarchy", folder: "/repo" }, { id: "b", machine: null, folder: "/repo" }], null, "/repo")?.id).toBe("b");
  });

  it("validates a remote descriptor and names the machine in the missing message", () => {
    expect((h as ExtendedHelpers).parseCliDescriptor(JSON.stringify({ version: 1, plugin: "0.1.0", cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"] }))).toEqual({ cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"], plugin: "0.1.0" });
    expect((h as ExtendedHelpers).parseCliDescriptor("{not json").error).toBeTruthy();
    expect((h as ExtendedHelpers).parseCliDescriptor(JSON.stringify({ cli: [] })).error).toBeTruthy();
    expect((h as ExtendedHelpers).parseCliDescriptor(JSON.stringify({ cli: ["node"] })).error).toBeTruthy();
    expect((h as ExtendedHelpers).parseCliDescriptor(JSON.stringify({ cli: ["/usr/bin/node", 7] })).error).toBeTruthy();
    expect((h as ExtendedHelpers).parseCliDescriptor(JSON.stringify({ cli: "/usr/bin/node" })).error).toBeTruthy();
    expect((h as ExtendedHelpers).parseCliDescriptor(JSON.stringify([1, 2])).error).toBeTruthy();
    expect((h as ExtendedHelpers).remoteCliMissing("omarchy")).toContain("omarchy");
    expect((h as ExtendedHelpers).remoteCliMissing("omarchy")).toContain("shepherd herdr-install --remote");
  });
});

type PanelHelpers = ExtendedHelpers & {
  stripInTarget(term: { address?: string; cwd?: string }, machine: string | null, root?: string | null): boolean;
  remoteCliOutcome(machine: string, res: { code: number; stdout: string; stderr?: string } | null, opts?: { throwDetail?: string; machineLayout?: string }): { error?: string; descriptor?: { cli: string[]; plugin?: string | null } };
  clickedWriteTarget(machine: string | null, root: string | null, entry: unknown): { machine: string | null; root: string | null; entry: unknown; key: string };
  writeStillLands(machine: string | null, root: string | null, clickedKey: string): boolean;
  loadResultStale(args: { capturedKey: string; current: { machine: string | null; folder: string | null } | null; mine: number; seq: number; pendingWrites: number }): boolean;
};

describe("panel click-time writes and stale loads (ticket 03)", () => {
  const H = () => h as PanelHelpers;

  it("captures the machine/root/CLI at click time and refuses a write that survives a space switch", () => {
    const entry = { cli: ["/usr/bin/node", "/x/shepherd-config.mjs"], resolvedNode: null, plugin: "0.1.0" };
    const clicked = H().clickedWriteTarget("omarchy", "/repo", entry);
    expect(clicked).toMatchObject({ machine: "omarchy", root: "/repo", entry, key: "omarchy:/repo" });
    expect(H().clickedWriteTarget(null, "/repo", entry).key).toBe(":/repo");
    // Same target: the write lands.
    expect(H().writeStillLands("omarchy", "/repo", clicked.key)).toBe(true);
    // A space switch mid-write moves machine/root: the write must not land on the new target.
    expect(H().writeStillLands(null, "/repo", clicked.key)).toBe(false);
    expect(H().writeStillLands("omarchy", "/other", clicked.key)).toBe(false);
    expect(H().writeStillLands("omarchy", null, clicked.key)).toBe(false);
    expect(H().writeStillLands("omarchy", "", clicked.key)).toBe(false);
  });

  it("discards a load whose target moved, whose queue moved, or whose seq moved under it", () => {
    const base = { capturedKey: "omarchy:/repo", current: { machine: "omarchy", folder: "/repo" }, mine: 1, seq: 1, pendingWrites: 0 };
    expect(H().loadResultStale(base)).toBe(false);
    expect(H().loadResultStale({ ...base, current: { machine: "local", folder: "/repo" } })).toBe(true);
    expect(H().loadResultStale({ ...base, current: { machine: "omarchy", folder: "/repo2" } })).toBe(true);
    expect(H().loadResultStale({ ...base, current: null })).toBe(true);
    expect(H().loadResultStale({ ...base, mine: 0, seq: 1 })).toBe(true);
    expect(H().loadResultStale({ ...base, pendingWrites: 1 })).toBe(true);
  });

  it("reports a remote cliFor error for unreachable, missing and invalid descriptors", () => {
    // Unreachable: every shell threw. Nothing was read; the machine is named with its layout and the detail.
    const unreachable = H().remoteCliOutcome("omarchy", null, { throwDetail: "connection refused", machineLayout: "docked" });
    expect(unreachable.error).toContain("omarchy is unreachable");
    expect(unreachable.error).toContain("(docked)");
    expect(unreachable.error).toContain("connection refused");
    expect(unreachable.descriptor).toBeUndefined();
    const unreachableNoLayout = H().remoteCliOutcome("omarchy", null, { throwDetail: "" });
    expect(unreachableNoLayout.error).not.toContain("(");
    // Missing descriptor: the command failed or printed nothing.
    expect(H().remoteCliOutcome("omarchy", { code: 127, stdout: "", stderr: "cat: no such file" }).error).toContain("not installed");
    expect(H().remoteCliOutcome("omarchy", { code: 0, stdout: "   ", stderr: "" }).error).toContain("not installed");
    // Invalid descriptor: parsed by the same rules as the rest of the panel.
    const invalid = H().remoteCliOutcome("omarchy", { code: 0, stdout: "{not json", stderr: "" });
    expect(invalid.error).toContain("omarchy:");
    expect(invalid.error).toContain("not valid JSON");
    // Valid descriptor.
    const ok = H().remoteCliOutcome("omarchy", {
      code: 0,
      stdout: JSON.stringify({ version: 1, plugin: "0.1.0", cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"] }),
      stderr: "",
    });
    expect(ok.error).toBeUndefined();
    expect(ok.descriptor?.cli[0]).toBe("/usr/bin/node");
    expect(ok.descriptor?.plugin).toBe("0.1.0");
  });

  it("keeps a sub-agent with no reported cwd in the strip, but machine-scopes it regardless", () => {
    // termInTarget (sendToSession) stays strict: no cwd, no match.
    expect((h as PanelHelpers).termInTarget({ address: "t7" }, null, "/repo")).toBe(false);
    // The strip restores the pre-machine-change behaviour: a sub-agent whose cwd herdr has not reported
    // yet stays in the strip, on the same machine.
    expect(H().stripInTarget({ address: "t7" }, null, "/repo")).toBe(true);
    expect(H().stripInTarget({ address: "omarchy/t7" }, "omarchy", "/repo")).toBe(true);
    expect(H().stripInTarget({ address: "t7", cwd: "" }, null, "/repo")).toBe(true);
    // cwd-bearing terminals are still machine- and root-scoped.
    expect(H().stripInTarget({ address: "omarchy/t7", cwd: "/other" }, "omarchy", "/repo")).toBe(false);
    expect(H().stripInTarget({ address: "t7", cwd: "/repo" }, "omarchy", "/repo")).toBe(false);
    expect(H().stripInTarget({ address: "t7", cwd: "/repo/sub" }, null, "/repo")).toBe(true);
    // No root: only the machine is enforced.
    expect(H().stripInTarget({ address: "omarchy/t7" }, "omarchy", null)).toBe(true);
    expect(H().stripInTarget({ address: "t7" }, "omarchy", null)).toBe(false);
  });
});
