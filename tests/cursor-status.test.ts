import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_SILENT_HINT, CURSOR_STATUS_FILE, CURSOR_STATUS_SCRIPT, ensureCursorStatusHook } from "../src/runner/cursor-status.js";
import { openTab, READY_NUDGE_MS } from "../src/runner/tab.js";
import { fakeHerdrClient } from "./herdr-fake.js";

const home = () => mkdtempSync(path.join(tmpdir(), "cursor-home-"));
const hooksFile = (h: string) => path.join(h, ".cursor", "hooks.json");
const scriptFile = (h: string) => path.join(h, ".cursor", CURSOR_STATUS_FILE);
const read = (file: string) => readFileSync(file, "utf8");
const seed = (h: string, text: string) => {
  mkdirSync(path.join(h, ".cursor"), { recursive: true });
  writeFileSync(hooksFile(h), text);
};

describe("ensureCursorStatusHook", () => {
  it("creates the script (executable) and hooks.json when neither exists", () => {
    const h = home();
    expect(ensureCursorStatusHook(h)).toEqual({ changed: true });
    expect(read(scriptFile(h))).toBe(CURSOR_STATUS_SCRIPT);
    expect(statSync(scriptFile(h)).mode & 0o111).not.toBe(0);
    const s = scriptFile(h);
    expect(JSON.parse(read(hooksFile(h)))).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command: `sh '${s}' idle` }],
        beforeSubmitPrompt: [{ command: `sh '${s}' working` }],
        stop: [{ command: `sh '${s}' idle` }],
      },
    });
  });

  it("keeps herdr's own entry and every other key, and a second call changes nothing", () => {
    const h = home();
    seed(h, JSON.stringify({ version: 1, extra: { a: 1 }, hooks: { sessionStart: [{ command: "herdr report" }], preToolUse: [{ command: "x" }] } }));
    expect(ensureCursorStatusHook(h)).toEqual({ changed: true });
    const doc = JSON.parse(read(hooksFile(h)));
    expect(doc.extra).toEqual({ a: 1 });
    expect(doc.hooks.preToolUse).toEqual([{ command: "x" }]);
    expect(doc.hooks.sessionStart).toEqual([{ command: "herdr report" }, { command: `sh '${scriptFile(h)}' idle` }]);
    const [hooks, script] = [read(hooksFile(h)), read(scriptFile(h))];
    expect(ensureCursorStatusHook(h)).toEqual({ changed: false });
    expect(read(hooksFile(h))).toBe(hooks);
    expect(read(scriptFile(h))).toBe(script);
  });

  it("rewrites a script that was edited", () => {
    const h = home();
    ensureCursorStatusHook(h);
    writeFileSync(scriptFile(h), "echo hi\n");
    expect(ensureCursorStatusHook(h)).toEqual({ changed: true });
    expect(read(scriptFile(h))).toBe(CURSOR_STATUS_SCRIPT);
  });

  it("reports a problem and writes nothing for malformed JSON or a wrong shape", () => {
    for (const text of ["{not json", "[]", JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { stop: {} } })]) {
      const h = home();
      seed(h, text);
      const result = ensureCursorStatusHook(h);
      expect(result).toHaveProperty("problem");
      expect(read(hooksFile(h))).toBe(text);
      expect(existsSync(scriptFile(h))).toBe(false);
    }
  });
});

describe("the status script", () => {
  const run = (args: string[], env: Record<string, string>) => {
    const h = home();
    const file = path.join(h, "s.sh");
    writeFileSync(file, CURSOR_STATUS_SCRIPT);
    chmodSync(file, 0o755);
    const clean = { ...process.env, ...env };
    if (!("HC_TERMINAL_ID" in env)) delete clean.HC_TERMINAL_ID;
    return spawnSync("sh", [file, ...args], { input: "{}", encoding: "utf8", env: clean });
  };

  it("does nothing, silently, without HC_TERMINAL_ID", () => {
    const r = run(["idle"], {});
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("exits 0 silently on a state it does not know", () => {
    const r = run(["sleeping"], { HC_TERMINAL_ID: "t1" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  /** A `ps` that says the first ancestor has `tty`, so the real terminals of whoever runs the tests are never written to. */
  const withFakePs = (tty: string, state: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-ps-"));
    writeFileSync(path.join(dir, "ps"), `#!/bin/sh\ncase "$2" in\n  tty=) echo '  ${tty}' ;;\n  ppid=) echo 1 ;;\nesac\n`);
    chmodSync(path.join(dir, "ps"), 0o755);
    return run([state], { HC_TERMINAL_ID: "t1", PATH: `${dir}:${process.env.PATH}` });
  };

  it("writes the OSC 7501 sequence to the first ancestor's terminal, and nothing to stdout", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "fake-tty-")), "tty");
    writeFileSync(out, "");
    const r = withFakePs(`..${out}`, "working");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(read(out)).toBe("\u001b]7501;state=working:app=cursor\u001b\\");
  });

  it("writes nothing when no ancestor has a terminal", () => {
    const r = withFakePs("??", "idle");
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});

describe("openTab silentHint", () => {
  const base = { cwd: "/repo", argv: ["cursor-agent"], name: "shep-t", blockedNotice: "waiting", progress: () => undefined, silentHint: CURSOR_SILENT_HINT };
  const silent = { status: "timeout", exitCode: null, timedOut: true };

  it("throws with the hint when the first wait times out and the tab never reported", async () => {
    const { client } = fakeHerdrClient({ ready: () => silent, reported: () => false });
    await expect(openTab({ ...base, client })).rejects.toThrow(/cursor-agent reported no status to herdr.*hooks\.json/);
  });

  it("keeps waiting when the tab has reported, or when hc cannot say", async () => {
    for (const reported of [true, undefined]) {
      const lines: string[] = [];
      const { client } = fakeHerdrClient({ ready: () => silent, reported: () => reported });
      await openTab({ ...base, client, progress: (t) => lines.push(t) });
      expect(lines).toHaveLength(1);
    }
  });

  it("keeps waiting without a hint (Claude's trust prompt reports nothing at first)", async () => {
    const lines: string[] = [];
    const { client } = fakeHerdrClient({ ready: () => silent, reported: () => false });
    await openTab({ ...base, silentHint: undefined, client, progress: (t) => lines.push(t) });
    expect(lines).toHaveLength(1);
  });

  it("first waits the nudge time", async () => {
    const t: number[] = [];
    const { client } = fakeHerdrClient({ ready: () => silent, reported: () => false });
    const wait = client.waitIdle.bind(client);
    client.waitIdle = async (a, o) => (t.push(o.timeoutMs), wait(a, o));
    await openTab({ ...base, client }).catch(() => undefined);
    expect(t[0]).toBe(READY_NUDGE_MS);
  });
});
