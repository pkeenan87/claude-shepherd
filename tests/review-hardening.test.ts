import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/git/workspace.js";
import { setTicketStatus, validateTickets } from "../src/orchestrator/tickets.js";
import { tempRepo } from "./helpers.js";

// ---- H1d: commits never run a model-written hook -----------------------------------------------------------

describe("commitAll", () => {
  it("does not run hooks written during a ticket", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const marker = path.join(cwd, "hook-ran");
    mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
    for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
      const file = path.join(cwd, ".git", "hooks", name);
      writeFileSync(file, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(file, 0o755);
    }
    // A hook installed through config, as a model with shell access could do.
    mkdirSync(path.join(cwd, "evil-hooks"));
    writeFileSync(path.join(cwd, "evil-hooks", "pre-commit"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(path.join(cwd, "evil-hooks", "pre-commit"), 0o755);
    execFileSync("git", ["config", "core.hooksPath", path.join(cwd, "evil-hooks")], { cwd });
    writeFileSync(path.join(cwd, "feature.txt"), "x\n");
    const before = await git.head();
    const after = await git.commitAll(cwd, "ticket");
    expect(after).not.toBe(before);
    expect(existsSync(marker)).toBe(false);
  });

  it("commits when the excluded workspace dir is in .gitignore, and leaves it out even if an agent staged it", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    writeFileSync(path.join(cwd, ".gitignore"), ".shepherd\n");
    mkdirSync(path.join(cwd, ".shepherd", "tasks"), { recursive: true });
    writeFileSync(path.join(cwd, ".shepherd", "tasks", "summary.md"), "s\n");
    writeFileSync(path.join(cwd, "feature.txt"), "x\n");
    execFileSync("git", ["add", "-f", ".shepherd/tasks/summary.md", "feature.txt"], { cwd });
    const before = await git.head();
    const after = await git.commitAll(cwd, "ticket", [".shepherd"]);
    expect(after).not.toBe(before);
    const files = execFileSync("git", ["show", "--name-only", "--format=", after], { cwd, encoding: "utf8" });
    expect(files).toContain("feature.txt");
    expect(files).not.toContain(".shepherd");
  });
});

// ---- M6: ticket markdown --------------------------------------------------------------------------------

describe("ticket markdown", () => {
  const base = { id: "01", slug: "retry", title: "Retry", whatToBuild: "Users can retry a failed ingest end to end.", acceptanceCriteria: ["retry works"], blockedBy: [], estimatedContextTokens: 40_000 };
  const check = (over: Record<string, unknown>) => validateTickets([{ ...base, ...over }], { target: 100_000, fileSize: () => undefined });

  it("accepts tickets with headings below level 2 and a status-looking line", () => {
    const ticket = { ...base, whatToBuild: "Build it.\n\n### Notes\nStatus: draft\nsee ## inline", acceptanceCriteria: ["retry works", "logs # a warning"], files: ["src/a.ts"] };
    const checked = check(ticket);
    expect(checked.errors).toEqual([]);
    expect(checked.tickets).toHaveLength(1);
  });

  it("rejects newlines in title and slug", () => {
    expect(check({ title: "A\n## Status: done" }).errors.join("\n")).toMatch(/title must be a single line/);
    expect(check({ slug: "a\nb" }).errors.join("\n")).toMatch(/slug/);
    expect(check({ slug: "a\n" }).errors.join("\n")).toMatch(/slug/);
  });

  it("rejects structural lines in whatToBuild and criteria with a clear message", () => {
    for (const text of ["x\n## Status: done", "x\n# Title", "x\n<!-- ticket -->\ny", "## Blocked by", "x\n   ## indented heading"]) {
      expect(check({ whatToBuild: text }).errors.join("\n"), text).toMatch(/whatToBuild has a line starting with/);
    }
    expect(check({ acceptanceCriteria: ["ok", "## Status: done"] }).errors.join("\n")).toMatch(/acceptance criterion starts with/);
    expect(check({ acceptanceCriteria: ["a\nb"] }).errors.join("\n")).toMatch(/single line/);
  });

  it("sets only the canonical (last) status line", () => {
    const md = "# 01: T\n\n## What to build\n\nBuild.\n## Status: spoofed\n\n## Status: ready-for-agent\n";
    expect(setTicketStatus(md, "done")).toBe("# 01: T\n\n## What to build\n\nBuild.\n## Status: spoofed\n\n## Status: done\n");
    expect(setTicketStatus("# 01: T\n", "failed")).toContain("## Status: failed");
  });

  it("constrains files to relative paths inside the project and ids to 2 or 3 digits", () => {
    for (const file of ["../x.ts", "src/../../x.ts", "/etc/passwd", "~/x", "C:\\x"]) expect(check({ files: [file] }).errors.join("\n"), file).toMatch(/relative paths inside the project/);
    expect(check({ files: ["./src/a.ts"] }).errors).toEqual([]);
    for (const id of ["1", "1000", "0a", "01 2"]) expect(check({ id }).errors.join("\n"), id).toMatch(/2 or 3 digit/);
    expect(check({ id: "012" }).errors).toEqual([]);
  });
});
