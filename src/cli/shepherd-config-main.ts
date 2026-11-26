/** Entry of the bundled panel CLI (dist/shepherd-config.mjs): runs `main` and exits with its code. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./shepherd-config.js";

// Herdr on macOS launches GUI mods with launchd's minimal PATH; merge the PATH captured at `herdr-install` time
// so agent model discovery (`agy`, `claude`, `cursor-agent`, `pi`) works. The local install keeps install.json
// next to this bundle; the `--remote` install keeps the descriptor one level up (<shepherd home>/panel-cli.json).
const savedPath = (file: string): string | undefined => {
  try {
    const saved = (JSON.parse(readFileSync(file, "utf8")) as { path?: unknown }).path;
    if (typeof saved === "string" && saved && !saved.includes("\n")) return saved;
  } catch {
    /* missing or unreadable: try the next descriptor */
  }
  return undefined;
};
const dir = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(dir, "install.json"), path.join(dir, "..", "panel-cli.json")]) {
  const saved = savedPath(file);
  if (!saved) continue;
  const cur = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...cur, ...saved.split(path.delimiter).filter(Boolean)])];
  if (merged.length > 0) process.env.PATH = merged.join(path.delimiter);
}

// A closed pipe (| head) is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" ? 0 : 1));

process.exitCode = await main(process.argv.slice(2));
