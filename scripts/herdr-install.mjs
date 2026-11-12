#!/usr/bin/env node
// Thin shim: `shepherd herdr-install` lives in the bundle (npm run bundle writes dist/shepherd.mjs).
//   node scripts/herdr-install.mjs [--layout <name>] [--no-dock]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "shepherd.mjs");
const result = spawnSync(process.execPath, [bundle, "herdr-install", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
