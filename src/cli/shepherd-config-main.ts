/** Entry of the bundled panel CLI (dist/shepherd-config.mjs): runs `main` and exits with its code. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./shepherd-config.js";

// Herdr on macOS launches GUI mods with launchd's minimal PATH; merge the PATH captured at `herdr-install` time
// (from install.json next to this bundle) so agent model discovery (`agy`, `claude`, `cursor-agent`, `pi`) works.
try {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const saved = (JSON.parse(readFileSync(path.join(dir, "install.json"), "utf8")) as { path?: unknown }).path;
  if (typeof saved === "string" && saved && !saved.includes("\n")) {
    const cur = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const merged = [...new Set([...cur, ...saved.split(path.delimiter).filter(Boolean)])];
    if (merged.length > 0) process.env.PATH = merged.join(path.delimiter);
  }
} catch {
  /* running outside an installed mod dir or without install.json: keep current PATH */
}

// A closed pipe (| head) is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" ? 0 : 1));

process.exitCode = await main(process.argv.slice(2));
