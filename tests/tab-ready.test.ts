import { describe, expect, it } from "vitest";
import { TRUST_PROMPTS } from "../src/agents.js";
import { openTab, READY_NUDGE_MS, withPath } from "../src/runner/tab.js";
import { fakeHerdrClient } from "./herdr-fake.js";

const base = { cwd: "/repo", argv: ["claude"], name: "chef-t-01-1-abcd", blockedNotice: "Ticket 01 is waiting for you in herdr sub-agent chef-t-01-1-abcd" };

describe("openTab ready wait", () => {
  it("tells the person when the program has not reported ready (a first-run prompt), then keeps waiting; nothing is typed meanwhile", async () => {
    const lines: string[] = [];
    const timeouts: number[] = [];
    const { client, tabs } = fakeHerdrClient({ ready: () => ({ status: "timeout", exitCode: null, timedOut: true }) });
    const waitIdle = client.waitIdle.bind(client);
    client.waitIdle = async (terminal, options) => {
      timeouts.push(options.timeoutMs);
      return waitIdle(terminal, options);
    };
    const tab = await openTab({ ...base, client, progress: (text) => lines.push(text), turnTimeoutMs: 60 * 60_000 });
    expect(timeouts[0]).toBe(READY_NUDGE_MS);
    expect(timeouts[1]).toBeGreaterThan(5 * 60_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/waiting for you in herdr sub-agent chef-t-01-1-abcd.*first-run prompt/);
    expect(tabs[0].sends).toHaveLength(0);
    expect(tab.address).toBeTruthy();
  });

  it("says nothing when the program is ready at once", async () => {
    const lines: string[] = [];
    await openTab({ ...base, client: fakeHerdrClient().client, progress: (text) => lines.push(text) });
    expect(lines).toEqual([]);
  });
});

// The prompts as hc read showed them live (2026-11-12), in a folder neither agent had seen.
const AGY_SCREEN = `Accessing workspace:
/tmp/x/tr-agy
Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute files here.
> Yes, I trust this folder
  No, exit
  ↑/↓ Navigate · enter Confirm`;
const GROK_SCREEN = `Do you trust the contents of this directory?
/tmp/x/tr-grok
Grok Build may run or modify contents in this directory,
posing security risks.
Yes, proceed                 y
No, quit                     n`;

describe("trust prompts", () => {
  it("match each agent's live prompt, and not one where 'yes' is not the selected option", () => {
    expect(TRUST_PROMPTS.agy!.screen.test(AGY_SCREEN)).toBe(true);
    expect(TRUST_PROMPTS.grok!.screen.test(GROK_SCREEN)).toBe(true);
    expect(TRUST_PROMPTS.agy!.screen.test(AGY_SCREEN.replace("> Yes", "  Yes").replace("  No, exit", "> No, exit"))).toBe(false);
    expect(TRUST_PROMPTS.agy!.screen.test(GROK_SCREEN)).toBe(false);
    expect(TRUST_PROMPTS).not.toHaveProperty("claude"); // its default is "No, exit"; the main session already trusts the repo
  });

  it("openTab answers a matching prompt once, says so, then waits for ready; it types nothing else", async () => {
    const lines: string[] = [];
    const { client, tabs } = fakeHerdrClient({ read: (tab) => (tab.keys.length ? "ready" : AGY_SCREEN) });
    const waitIdle = client.waitIdle.bind(client);
    client.waitIdle = async (terminal, options) => (tabs[0]!.keys.length === 0 ? { status: "timeout", exitCode: null, timedOut: true } : waitIdle(terminal, options));
    await openTab({ ...base, argv: ["agy", "--mode", "auto"], trust: TRUST_PROMPTS.agy, client, progress: (text) => lines.push(text) });
    expect(tabs[0]!.keys).toEqual(["enter"]);
    expect(tabs[0]!.sends).toEqual([]);
    expect(lines).toEqual([`${base.name}: answered its "trust this folder" prompt for /repo`]);
  });

  it("also answers a prompt that herdr shows as blocked (agy, live)", async () => {
    const { client, tabs } = fakeHerdrClient({ read: (tab) => (tab.keys.length ? "ready" : GROK_SCREEN) });
    const waitIdle = client.waitIdle.bind(client);
    client.waitIdle = async (terminal, options) => (tabs[0]!.keys.length === 0 ? { status: "blocked", exitCode: null, timedOut: false } : waitIdle(terminal, options));
    await openTab({ ...base, argv: ["grok"], trust: TRUST_PROMPTS.grok, client, progress: () => {} });
    expect(tabs[0]!.keys).toEqual(["y"]);
  });

  it("presses nothing when the screen does not match, and falls back to telling the person", async () => {
    const lines: string[] = [];
    let clock = 0;
    const { client, tabs } = fakeHerdrClient({ read: () => "Some other dialog\n> No, exit" });
    client.waitIdle = async (_terminal, options) => {
      clock += options.timeoutMs;
      return clock > READY_NUDGE_MS * 3 ? { status: "idle", exitCode: null, timedOut: false } : { status: "timeout", exitCode: null, timedOut: true };
    };
    await openTab({ ...base, argv: ["agy"], trust: TRUST_PROMPTS.agy, client, now: () => clock, progress: (text) => lines.push(text), turnTimeoutMs: 60 * 60_000 });
    expect(tabs[0]!.keys).toEqual([]);
    expect(lines.join("\n")).toMatch(/first-run prompt/);
  });
});

describe("openTab labels", () => {
  const labelled = ["herdr.space", "herdr.tab"];

  it("passes no herdr.space or herdr.tab label by default: the child is a paneless sub-agent of the terminal that ran hc", async () => {
    const { client, tabs } = fakeHerdrClient();
    await openTab({ ...base, client, progress: () => {}, labels: { "shepherd.ticket": "01" } });
    expect(tabs[0].options.labels).toEqual({ "shepherd.ticket": "01" });
    for (const key of labelled) expect(tabs[0].options.labels).not.toHaveProperty(key);
  });

  it("with a space (build.visibleTabs) opens a labelled tab beside the terminal's own", async () => {
    const { client, tabs } = fakeHerdrClient();
    await openTab({ ...base, space: "s1", client, progress: () => {}, labels: { "shepherd.ticket": "01" } });
    expect(tabs[0].options.labels).toEqual({ "herdr.space": "s1", "herdr.tab": base.name, "shepherd.ticket": "01" });
  });
});

describe("withPath", () => {
  it("starts the program with shepherd's PATH (a launchd herdr server has only the system dirs)", async () => {
    const { client, tabs } = fakeHerdrClient();
    await openTab({ ...base, argv: ["codex", "-m", "x"], client, progress: () => {}, path: "/home/me/.fnm/bin:/usr/bin" });
    expect(tabs[0].options.argv).toEqual(["env", "PATH=/home/me/.fnm/bin:/usr/bin", "codex", "-m", "x"]);
  });

  it("joins an existing env wrapper, and leaves argv alone without a PATH", () => {
    expect(withPath(["env", "A=1", "pi"], "/p")).toEqual(["env", "PATH=/p", "A=1", "pi"]);
    expect(withPath(["claude"], undefined)).toEqual(["claude"]);
  });
});
