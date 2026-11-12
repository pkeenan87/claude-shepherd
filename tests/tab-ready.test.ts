import { describe, expect, it } from "vitest";
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
