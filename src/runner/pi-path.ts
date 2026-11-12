/**
 * Pi outside Pi: a Pi-model ticket (or review) runs as `pi` in a herdr tab, so outside a Pi session the only check shepherd
 * can make is that a `pi` program is on PATH. Whether Pi knows the model or holds a login for it is for the Pi child to say.
 */
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** True when an executable `pi` is in a directory of `PATH`. */
export function piOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

/** The sentence for a Pi model that cannot run because `pi` is missing. */
export const NO_PI = "`pi` is not on PATH, and a Pi model runs as a `pi` process (install Pi, or point the model at an agent: agent:<name>)";
