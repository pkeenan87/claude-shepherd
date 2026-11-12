/**
 * What a Bash command line would do that the PreToolUse hook cares about. A simple quote-aware split into commands and
 * words (on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes), not a shell parser: it catches the plain forms and
 * `sh -c "..."`, which is what a model writes; it is a guard rail, not a sandbox.
 */

export type GuardHit = "git push" | "git branch change" | "git worktree" | "shepherd run" | "hc run";

/** The commands of a line, each as its words with quotes removed. */
export function commandsOf(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) word += line[(i += 1)];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      word += line[(i += 1)];
      inWord = true;
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const WRAPPERS = new Set(["env", "command", "time", "nohup", "sudo", "exec", "builtin"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

const base = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** The command with leading `VAR=x` words and wrappers (`env`, `sudo`, `nohup` …) dropped. */
function strip(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || WRAPPERS.has(base(words[i]!)) || (words[i]!.startsWith("-") && i > 0 && WRAPPERS.has(base(words[0]!))))) i += 1;
  return words.slice(i);
}

/** `git checkout`/`git switch` that moves HEAD to another branch, not `git checkout -- file` or `git checkout .`. */
function changesBranch(verb: string, args: string[]): boolean {
  if (verb === "switch") return true;
  if (args.some((arg) => ["-b", "-B", "--orphan", "--detach", "-d"].includes(arg))) return true;
  const dashes = args.indexOf("--");
  const named = (dashes < 0 ? args : args.slice(0, dashes)).filter((arg) => (!arg.startsWith("-") || arg === "-") && arg !== ".");
  // `git checkout <ref> -- <path>` restores files; without `--`, a named ref (or a path, which cannot be told apart here) is a switch.
  return named.length > 0 && dashes < 0;
}

function hitsOf(words: string[], depth: number): GuardHit[] {
  const command = strip(words);
  const name = base(command[0] ?? "");
  if (!name) return [];
  if (SHELLS.has(name) && depth < 3) {
    const at = command.findIndex((word) => /^-[a-z]*c$/.test(word));
    return at >= 0 && command[at + 1] ? commandsOf(command[at + 1]!).flatMap((inner) => hitsOf(inner, depth + 1)) : [];
  }
  if (name === "git") {
    let i = 1;
    while (i < command.length && command[i]!.startsWith("-")) i += GIT_VALUE_OPTIONS.has(command[i]!) ? 2 : 1;
    const verb = command[i];
    const args = command.slice(i + 1);
    if (verb === "push") return ["git push"];
    if (verb === "worktree") return ["git worktree"];
    if ((verb === "checkout" || verb === "switch") && changesBranch(verb, args)) return ["git branch change"];
    return [];
  }
  if (name === "hc" && command[1] === "run") return ["hc run"];
  if ((name === "shepherd" || name === "shepherd.mjs") && ["build", "review", "fix"].includes(command[1] ?? "")) return ["shepherd run"];
  // `node dist/shepherd.mjs build` and `npx shepherd build`
  if ((name === "node" || name === "npx") && command[1] && base(command[1]).startsWith("shepherd") && ["build", "review", "fix"].includes(command[2] ?? "")) return ["shepherd run"];
  return [];
}

/** Everything in the command line the guard cares about, in order. */
export function guardHits(line: string): GuardHit[] {
  return commandsOf(line).flatMap((words) => hitsOf(words, 0));
}
