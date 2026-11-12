/**
 * shepherd: the command line of the Claude Code plugin. For now it only prints its version; the workflow commands arrive
 * in later phases. `main` returns the exit code.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  shepherd version
`;

/** The version in package.json. It sits one level above src/cli, build/cli and dist (the bundle). */
function packageVersion(): string {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "claude-shepherd" && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "unknown";
}

export function main(argv: string[], out: (text: string) => void = (text) => process.stdout.write(text)): number {
  if (argv[0] === "version" && argv.length === 1) {
    out(`${packageVersion()}\n`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

/** True when this file is the program being run: directly, or through the `bin/shepherd` shim that imports the bundle. */
function isEntry(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const real = realpathSync(invoked);
    return real === realpathSync(fileURLToPath(import.meta.url)) || path.basename(real) === "shepherd";
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = main(process.argv.slice(2));
