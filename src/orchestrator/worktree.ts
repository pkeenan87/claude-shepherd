/**
 * Lightweight worktree path resolution aligned with Herdr's native worktree layout
 * (`~/.config/herdr-app/settings.json` `worktrees.directory`, default `~/.herdr/worktrees`,
 * checkout path `<baseDir>/<repoName>/<branch-with-dashes>`), so worktrees created during
 * `/shepherd:plan --worktree` auto-nest under the parent repo in Herdr's Spaces sidebar.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WorkflowConfig } from "../config.js";

function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return raw;
}

/** Reads Herdr's configured `worktrees.directory` from settings.json, else `~/.herdr/worktrees`. */
export function herdrWorktreeDir(home = homedir(), appHome = process.env.HERDR_APP_HOME ?? path.join(home, ".config", "herdr-app")): string {
  const settingsPath = path.join(appHome, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { worktrees?: { directory?: unknown } };
      const dir = parsed?.worktrees?.directory;
      if (typeof dir === "string" && dir.trim()) return path.resolve(expandHome(dir.trim(), home));
    } catch {
      /* invalid or unreadable settings.json: fall back to default */
    }
  }
  return path.join(home, ".herdr", "worktrees");
}

/** Base directory for shepherd worktrees: `worktree.dir` in config, else Herdr's worktree directory. */
export function resolveWorktreeBaseDir(config: WorkflowConfig, home = homedir()): string {
  if (config.worktree?.dir) return path.resolve(expandHome(config.worktree.dir, home));
  return herdrWorktreeDir(home);
}

/** `<baseDir>/<repo-basename>/<branch-with-slashes-as-dashes>` — matches Herdr's native convention. */
export function worktreePathFor(commonRoot: string, branch: string, baseDir: string): string {
  const repoName = path.basename(path.resolve(commonRoot)).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
  return path.join(path.resolve(baseDir), repoName, slug);
}
