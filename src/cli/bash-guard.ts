/**
 * What a Bash command line would do that the PreToolUse hook cares about. Built on `sandbox.ts` so quote/wrapper/
 * subshell/inline-git-alias handling stays in one place (e.g., read-only `git worktree list` is allowed, while
 * `(git push)`, `$(git switch main)`, `env -u FOO git push`, `sh -ce`, and `hc --json run` are caught).
 */
import { baseName, changesWorktrees, commandsIn, gitCall, splitSegments, switchesBranch } from "../sandbox.js";

export type GuardHit =
  | "git push"
  | "git branch change"
  | "git worktree"
  | "shepherd run"
  | "hc run"
  | "plan approve"
  | "shepherd switch"
  | "cleanup remote"
  | "ship remote";

/** The commands of a line, each as its words with quotes removed. */
export function commandsOf(line: string): string[][] {
  return splitSegments(line).map((segment) => segment.tokens);
}

function shepherdCommandHits(argv: string[], from: number): GuardHit[] {
  const rest = argv.slice(from);
  const verbs = rest.filter((word) => !word.startsWith("-"));
  const first = verbs[0] ?? "";
  const second = verbs[1] ?? "";
  if (["build", "review", "fix"].includes(first)) {
    if (first === "build" && second === "pause") return [];
    return ["shepherd run"];
  }
  if (first === "plan" && second === "approve") return ["plan approve"];
  if ((first === "plans" && verbs.length >= 2) || (first === "task" && second === "use")) return ["shepherd switch"];
  if (first === "cleanup" && rest.includes("--remote")) return ["cleanup remote"];
  if (first === "ship" && (rest.includes("--push") || rest.includes("--pr"))) return ["ship remote"];
  return [];
}

function hitsForCommand(argv: string[]): GuardHit[] {
  const name = baseName(argv[0] ?? "");
  if (!name) return [];
  const call = gitCall(argv);
  if (call) {
    if (call.sub === "push") return ["git push"];
    if (call.sub === "worktree" && call.rest.find((arg) => !arg.startsWith("-")) !== "list") return ["git worktree"];
    if (call.sub === "switch" || call.sub === "checkout" || call.sub === "symbolic-ref" || call.sub === "update-ref") {
      if (switchesBranch(argv.join(" "))) return ["git branch change"];
    }
    return [];
  }
  if (name === "hc") {
    const sub = argv.slice(1).find((word) => !word.startsWith("-"));
    if (sub === "run") return ["hc run"];
    return [];
  }
  if (name === "shepherd" || name === "shepherd.mjs") return shepherdCommandHits(argv, 1);
  if (name === "node" || name === "npx") {
    const idx = argv.findIndex((word, i) => i > 0 && !word.startsWith("-") && baseName(word).startsWith("shepherd"));
    if (idx > 0) return shepherdCommandHits(argv, idx + 1);
  }
  return [];
}

const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Everything in the command line the guard cares about, in order. Quote-aware via `commandsIn` (so commit messages like `git commit -m "fix; git push"` are never false positives). */
export function guardHits(line: string): GuardHit[] {
  const hits: GuardHit[] = [];
  const simples = commandsIn(line);
  for (const simple of simples) {
    if (simple.opaque !== undefined) {
      if (/\bpush\b/.test(simple.opaque) && !hits.includes("git push")) hits.push("git push");
      continue;
    }
    if (simple.argv.length > 0) {
      hits.push(...hitsForCommand(simple.argv));
      const first = simple.argv[0] ?? "";
      // Variable-expanded command with `push` (e.g. `$GIT push`), or xargs/piped shell fed a push command.
      if (!hits.includes("git push")) {
        if (first.includes("$") && simple.argv.includes("push")) hits.push("git push");
        else if ((simple.xargs || (simple.piped && SHELL_BINS.has(baseName(first).toLowerCase()))) && /\bpush\b/.test(line)) hits.push("git push");
      }
    }
  }
  if (!hits.includes("git branch change") && switchesBranch(line)) hits.push("git branch change");
  if (!hits.includes("git worktree") && changesWorktrees(line)) hits.push("git worktree");
  return hits;
}
