// The panel's main.js wiring (ticket 03/04): cliFor's shell fallback, call()'s on: machine, watch() skipping
// remote targets, mutate() using the target captured at click time, openOrJumpSpace() passing machine, and
// loadCatalog() dropping a result that was started before a repo switch. The herdr runtime is mocked; the pure
// lib.js helpers are covered by tests/herdr-shepherd-config-panel.test.ts.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("gpui-kit", () => ({
  View: class {},
  div: () => ({}),
  svg: () => ({}),
  image: () => ({}),
}));
vi.mock("gpui-base", () => ({
  v_flex: () => ({}),
  h_flex: () => ({}),
  InputState: { new: () => ({}) },
  Input: class {},
  NumberInput: { new: () => ({}) },
  Select: { new: () => ({}) },
  Popup: { new: () => ({}) },
  Scrollbar: { vertical: () => ({}) },
  ScrollHandle: { new: () => ({}) },
}));
vi.mock("herdr", () => ({
  checking: vi.fn(() => true),
  exec: vi.fn(),
  props: vi.fn(() => null),
  focused: vi.fn(() => null),
  spaces: vi.fn(() => []),
  machines: vi.fn(() => []),
  terminals: vi.fn(() => []),
  knownAgents: vi.fn(async () => []),
  theme: vi.fn(() => ({})),
  appHome: vi.fn(() => "/app"),
  home: vi.fn(() => "/home/me"),
  readTextFile: vi.fn(async () => null),
  watchFolder: vi.fn(() => new Promise(() => {})),
  run: vi.fn(),
  openOverlay: vi.fn(),
  notify: vi.fn(),
  playSound: vi.fn(),
}));

const mainPath = path.join(__dirname, "..", "herdr", "shepherd-config", "main.js");
let Panel: any;
let herdr: any;
beforeAll(async () => {
  Panel = (await import(pathToFileURL(mainPath).href)).default;
  herdr = await import("herdr");
});

function makePanel(): any {
  const panel = Object.create(Panel.prototype);
  panel.machine = null;
  panel.root = null;
  panel.target = null;
  panel.start = null;
  panel.data = null;
  panel.failure = null;
  panel.loading = false;
  panel.pending = false;
  panel.clis = new Map();
  panel.localPlugin = null;
  panel.watches = new Map();
  panel.wanted = new Set();
  panel.notes = {};
  panel.busy = new Set();
  panel.busyCounts = new Map();
  panel.pendingWrites = 0;
  panel.seq = 0;
  panel.writeQueue = Promise.resolve();
  panel.inputs = {};
  panel.draft = {};
  panel.detected = null;
  panel.detectedFor = null;
  panel.detectTargetKey = null;
  panel.catalog = null;
  panel.catalogMachine = undefined;
  panel.agentMeta = new Map();
  panel.agentMetaMachine = undefined;
  panel.scope = "today";
  return panel;
}

const NO_WRITE_NOTIFY = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  herdr.exec.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" });
  herdr.spaces.mockReturnValue([]);
  herdr.machines.mockReturnValue([]);
  herdr.readTextFile.mockResolvedValue(null);
  herdr.watchFolder.mockImplementation(() => new Promise(() => {}));
});

describe("panel main.js wiring", () => {
  it("cliFor falls back across shells and reads the descriptor from the last line of noisy output", async () => {
    const calls: string[] = [];
    herdr.exec.mockImplementation(async (shell: string) => {
      calls.push(shell);
      if (shell === "/bin/zsh") throw new Error("zsh: not found");
      return {
        code: 0,
        // herdr-install --remote writes the descriptor pretty-printed, so the noise is followed by several lines.
        stdout: "Last login: …\nnvm v22.11.0\n" + JSON.stringify({ version: 1, plugin: "0.1.0", cli: ["/usr/bin/node", "/home/me/.claude/shepherd/panel/shepherd-config.mjs"] }, null, 2) + "\n",
        stderr: "",
      };
    });
    const panel = makePanel();
    const res = await panel.cliFor("omarchy");
    expect(calls).toEqual(["/bin/zsh", "/bin/bash"]); // the login-shell fallback order
    expect(res.error).toBeUndefined();
    expect(res.entry.cli[0]).toBe("/usr/bin/node");
    expect(res.entry.cli[1]).toBe("/home/me/.claude/shepherd/panel/shepherd-config.mjs");
    expect(res.entry.plugin).toBe("0.1.0");
  });

  it("cliFor names the machine and the detail when every shell throws", async () => {
    herdr.exec.mockRejectedValue(new Error("connection refused"));
    const panel = makePanel();
    const res = await panel.cliFor("omarchy");
    expect(res.entry).toBeUndefined();
    expect(res.error).toContain("omarchy is unreachable");
    expect(res.error).toContain("connection refused");
  });

  it("cliFor reports a missing local install", async () => {
    const panel = makePanel();
    const res = await panel.cliFor(null);
    expect(res.error).toContain("install.json is missing");
  });

  it("call passes on: machine through to exec for a remote target", async () => {
    const panel = makePanel();
    const entry = { cli: ["/usr/bin/node", "/app/shepherd-config.mjs"], resolvedNode: null, plugin: null };
    const out = await panel.call(["show", "--cwd", "/repo"], { machine: "omarchy", entry });
    expect(out.ok).toBe(true);
    const [cmd, argv, opts] = herdr.exec.mock.calls[0];
    expect(cmd).toBe("/usr/bin/node");
    expect(argv).toEqual(["/app/shepherd-config.mjs", "show", "--cwd", "/repo"]);
    expect(opts).toMatchObject({ on: "omarchy", timeout: 60000 });
  });

  it("call passes no on: for a local target", async () => {
    const panel = makePanel();
    const entry = { cli: ["/usr/bin/node", "/app/shepherd-config.mjs"], resolvedNode: null, plugin: null };
    await panel.call(["show", "--cwd", "/repo"], { machine: null, entry });
    const opts = herdr.exec.mock.calls[0][2];
    expect(opts).not.toHaveProperty("on");
    expect(opts).toMatchObject({ timeout: 60000 });
  });

  it("watch skips remote targets and cancels stale watches", () => {
    const panel = makePanel();
    panel.machine = "omarchy";
    panel.wanted = new Set(["/x"]);
    const handle = { cancel: vi.fn() };
    panel.watches = new Map([["/x", handle]]);
    panel.watch({ spawn: () => {}, notify: NO_WRITE_NOTIFY });
    expect(herdr.watchFolder).not.toHaveBeenCalled();
    expect(handle.cancel).toHaveBeenCalled();
    expect(panel.watches.size).toBe(0);
    expect(panel.wanted.size).toBe(0);
  });

  it("watch starts a watch per local directory", () => {
    const panel = makePanel();
    panel.machine = null;
    panel.data = { files: { user: { path: "/home/me/.claude/shepherd.yaml", sha256: "abc" }, workspace: "/repo/.shepherd" } };
    const cx = { spawn: (fn: any) => { void (async () => { await fn(cx); })(); }, notify: NO_WRITE_NOTIFY };
    panel.watch(cx);
    const dirs = herdr.watchFolder.mock.calls.map((c: any[]) => c[0]);
    expect(dirs.sort()).toEqual(["/home/me/.claude", "/repo/.shepherd", "/repo/.shepherd/cost", "/repo/.shepherd/tasks"].sort());
  });

  it("mutate runs against the target captured at click time and reports success", async () => {
    const panel = makePanel();
    const entry = { cli: ["/usr/bin/node", "/app/shepherd-config.mjs"], resolvedNode: null, plugin: null };
    panel.clis.set("omarchy", entry);
    panel.machine = "omarchy";
    panel.root = "/repo";
    panel.data = { files: { user: { sha256: "abc" } } };
    const spawned: Array<(cx: any) => Promise<void>> = [];
    const cx = { spawn: (fn: any) => { spawned.push(fn); }, notify: NO_WRITE_NOTIFY };
    panel.mutate(
      "test",
      (root: string, sha: string | null) => ["set", "--cwd", root, "--key", "models.low", "--value", "local/a", ...(sha ? ["--expect", sha] : [])],
      cx,
    );
    await spawned[0](cx);
    await panel.writeQueue;
    const argv = herdr.exec.mock.calls[0][1];
    expect(argv).toEqual(["/app/shepherd-config.mjs", "set", "--cwd", "/repo", "--key", "models.low", "--value", "local/a", "--expect", "abc"]);
    expect(herdr.exec.mock.calls[0][2]).toMatchObject({ on: "omarchy" });
    expect(panel.notes.test).toMatchObject({ kind: "ok" });
  });

  it("mutate keeps the clicked target and its --expect guard when the space switches mid-write", async () => {
    const panel = makePanel();
    const entry = { cli: ["/usr/bin/node", "/app/shepherd-config.mjs"], resolvedNode: null, plugin: null };
    panel.clis.set("omarchy", entry);
    panel.machine = "omarchy";
    panel.root = "/repo";
    panel.data = { files: { user: { sha256: "abc" } } };
    let spawned: ((cx: any) => Promise<void>) | undefined;
    const cx = { spawn: (fn: any) => { spawned = fn; }, notify: NO_WRITE_NOTIFY };
    panel.mutate(
      "test",
      (root: string, sha: string | null) => ["set", "--cwd", root, "--key", "k", "--value", "v", ...(sha ? ["--expect", sha] : [])],
      cx,
    );
    // A space switch moves the target before the queued write runs.
    panel.machine = null;
    panel.root = "/other";
    await spawned!(cx);
    await panel.writeQueue;
    const [cmd, argv, opts] = herdr.exec.mock.calls[0];
    expect(cmd).toBe("/usr/bin/node");
    // The write still lands on the clicked target, guarded by the sha seen for that machine.
    expect(argv).toEqual(["/app/shepherd-config.mjs", "set", "--cwd", "/repo", "--key", "k", "--value", "v", "--expect", "abc"]);
    expect(opts).toMatchObject({ on: "omarchy" });
    // and puts no note on the panel's new target.
    expect(panel.notes.test).toBeUndefined();
    expect(herdr.notify).not.toHaveBeenCalled();
  });

  it("a queued write after a space switch uses the sha an earlier write returned, and a failure there is toasted", async () => {
    const panel = makePanel();
    const entry = { cli: ["/usr/bin/node", "/app/shepherd-config.mjs"], resolvedNode: null, plugin: null };
    panel.clis.set("omarchy", entry);
    panel.machine = "omarchy";
    panel.root = "/repo";
    panel.data = { files: { user: { sha256: "abc" } } };
    const spawned: Array<(cx: any) => Promise<void>> = [];
    const cx = { spawn: (fn: any) => { spawned.push(fn); }, notify: NO_WRITE_NOTIFY };
    const argsOf = (root: string, sha: string | null) => ["set", "--cwd", root, "--key", "k", "--value", "v", ...(sha ? ["--expect", sha] : [])];
    panel.mutate("first", argsOf, cx);
    panel.mutate("second", argsOf, cx);
    panel.machine = null;
    panel.root = "/other";
    herdr.exec
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, plans: [], files: { user: { sha256: "def" } } }), stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: JSON.stringify({ ok: false, error: "~/.claude/shepherd.yaml changed since it was read" }), stderr: "" });
    await Promise.all(spawned.map((fn) => fn(cx)));
    await panel.writeQueue;
    expect(herdr.exec.mock.calls[1][1]).toContain("def");
    expect(herdr.notify).toHaveBeenCalledTimes(1);
    expect(herdr.notify.mock.calls[0][0].body).toContain("omarchy: repo");
    expect(panel.notes.second).toBeUndefined();
  });

  it("cliFor reuses a remote descriptor for a minute instead of starting login shells on every refresh", async () => {
    herdr.exec.mockResolvedValue({ code: 0, stdout: JSON.stringify({ version: 1, cli: ["/usr/bin/node", "/x/shepherd-config.mjs"] }), stderr: "" });
    const panel = makePanel();
    const first = await panel.cliFor("omarchy");
    const second = await panel.cliFor("omarchy");
    expect(second.entry).toBe(first.entry);
    expect(herdr.exec).toHaveBeenCalledTimes(1);
    first.entry.readAt -= 61000;
    await panel.cliFor("omarchy");
    expect(herdr.exec).toHaveBeenCalledTimes(2);
  });

  it("openOrJumpSpace passes the machine on a remote space.new and uses space.select for a match", () => {
    const panel = makePanel();
    panel.machine = "omarchy";
    panel.openOrJumpSpace("plan-name", "/remote/wt");
    expect(herdr.run).toHaveBeenCalledWith("space.new", { name: "plan-name", folder: "/remote/wt", machine: "omarchy" });

    herdr.spaces.mockReturnValue([{ id: "omarchy/s1", machine: "omarchy", folder: "/remote/wt" }]);
    panel.openOrJumpSpace("plan-name", "/remote/wt");
    expect(herdr.run).toHaveBeenCalledWith("space.select", { id: "omarchy/s1" });

    const localPanel = makePanel();
    localPanel.openOrJumpSpace("plan-name", "/local/wt");
    expect(herdr.run).toHaveBeenCalledWith("space.new", { name: "plan-name", folder: "/local/wt" });
  });

  it("loadCatalog drops a result started before a repo switch on the same machine", async () => {
    const panel = makePanel();
    const entry = { cli: ["/usr/bin/node", "/app/shepherd-config.mjs"], resolvedNode: null, plugin: null };
    panel.clis.set("omarchy", entry);
    panel.machine = "omarchy";
    panel.root = "/repo";
    let execResolve: (v: unknown) => void = () => {};
    herdr.exec.mockImplementation(
      () =>
        new Promise((resolve) => {
          execResolve = resolve;
        }),
    );
    const spawned: Array<(cx: any) => Promise<void>> = [];
    const cx = { spawn: (fn: any) => { spawned.push(fn); }, notify: NO_WRITE_NOTIFY };
    panel.loadCatalog(cx, false);
    const fnPromise = spawned[0](cx); // let the spawned fn reach the exec await
    await new Promise((r) => setTimeout(r, 0));
    panel.root = "/other"; // a repo switch on the same machine, before the result arrives
    execResolve({ code: 0, stdout: JSON.stringify({ ok: true, agents: { claude: {} }, piModels: [] }), stderr: "" });
    await fnPromise;
    // The stale result does not overwrite the catalog; the new repo's catalog is loaded instead.
    expect(panel.catalog.agents).toEqual({});
    expect(panel.notes.catalog).toBeUndefined();
    expect(spawned).toHaveLength(2);
    herdr.exec.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, agents: { codex: {} }, piModels: [] }), stderr: "" });
    await spawned[1](cx);
    expect(herdr.exec.mock.calls.at(-1)[1]).toEqual(["/app/shepherd-config.mjs", "agent-models", "--cwd", "/other"]);
    expect(panel.catalog.agents).toEqual({ codex: {} });
    expect(panel.busy.has("catalog")).toBe(false);
  });
});
