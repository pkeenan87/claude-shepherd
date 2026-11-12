import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/cli/shepherd.ts
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var USAGE = `Usage:
  shepherd version
`;
function packageVersion() {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (pkg.name === "claude-shepherd" && pkg.version) return pkg.version;
    } catch {
    }
  }
  return "unknown";
}
function main(argv, out = (text) => process.stdout.write(text)) {
  if (argv[0] === "version" && argv.length === 1) {
    out(`${packageVersion()}
`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}
function isEntry() {
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
export {
  main
};
