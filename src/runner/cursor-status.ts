/**
 * cursor-agent never tells herdr whether it is idle, working or blocked: herdr (`hc`) learns a terminal's status only from
 * the program writing an OSC 7501 sequence to its terminal, which Claude Code and Pi do and cursor-agent does not. Without
 * it `hc wait` never reports ready and shepherd would wait for ever before typing the ticket prompt. Cursor's own hooks fill
 * the gap: `sessionStart` and `stop` say idle, `beforeSubmitPrompt` says working. `ensureCursorStatusHook` installs them in
 * `~/.cursor/hooks.json`, next to whatever else is there (herdr has its own `sessionStart` entry), before a cursor-agent tab opens.
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../storage/store.js";

export const CURSOR_STATUS_FILE = "shepherd-hc-status.sh";

/** A Cursor hook process has no controlling tty, so the script walks up its ancestors to the first one that has a terminal. */
export const CURSOR_STATUS_SCRIPT = `#!/bin/sh
# Written by shepherd (claude-shepherd) and overwritten by it: edit nothing here.
# Tells herdr (hc) the status of the terminal cursor-agent runs in: OSC 7501, which cursor-agent does not send itself.
# Usage (Cursor hook): shepherd-hc-status.sh idle|working|blocked
cat >/dev/null
[ -n "\${HC_TERMINAL_ID:-}" ] || exit 0
state="\${1:-}"
case "$state" in
  idle|working|blocked) ;;
  *) exit 0 ;;
esac
pid="$PPID"
n=0
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$n" -lt 64 ]; do
  tty="$(ps -o tty= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  case "$tty" in
    ""|"?"|"??") ;;
    *)
      printf '\\033]7501;state=%s:app=cursor\\033\\\\' "$state" >"/dev/$tty" 2>/dev/null
      exit 0
      ;;
  esac
  pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  n=$((n + 1))
done
exit 0
`;

type Hook = { command: string };
const EVENTS: Array<[event: string, state: string]> = [
  ["sessionStart", "idle"],
  ["beforeSubmitPrompt", "working"],
  ["stop", "idle"],
];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Installs the status script and its three hooks under `<home>/.cursor`. Writes nothing when anything there is not the expected shape. Never throws. */
export function ensureCursorStatusHook(home: string): { changed: boolean } | { problem: string } {
  const dir = path.join(home, ".cursor");
  const script = path.join(dir, CURSOR_STATUS_FILE);
  const hooksFile = path.join(dir, "hooks.json");
  try {
    let doc: Record<string, unknown> = { version: 1, hooks: {} };
    if (existsSync(hooksFile)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(hooksFile, "utf8"));
      } catch {
        return { problem: `${hooksFile} is not valid JSON; fix or remove it so shepherd can add its status hook` };
      }
      if (!isRecord(parsed)) return { problem: `${hooksFile} is not a JSON object; shepherd did not change it` };
      doc = parsed;
    }
    if (doc.hooks !== undefined && !isRecord(doc.hooks)) return { problem: `"hooks" in ${hooksFile} is not an object; shepherd did not change it` };
    const hooks = (doc.hooks ?? {}) as Record<string, unknown>;
    let hooksChanged = doc.hooks === undefined;
    for (const [event, state] of EVENTS) {
      const list = hooks[event];
      if (list !== undefined && !Array.isArray(list)) return { problem: `hooks.${event} in ${hooksFile} is not a list; shepherd did not change it` };
      const command = `sh '${script}' ${state}`;
      const entries = (list ?? []) as unknown[];
      if (entries.some((entry) => isRecord(entry) && entry.command === command)) continue;
      hooks[event] = [...entries, { command } satisfies Hook];
      hooksChanged = true;
    }
    doc.hooks = hooks;
    let changed = false;
    if (!existsSync(script) || readFileSync(script, "utf8") !== CURSOR_STATUS_SCRIPT) {
      atomicWrite(script, CURSOR_STATUS_SCRIPT);
      changed = true;
    }
    chmodSync(script, 0o755);
    if (hooksChanged || !existsSync(hooksFile)) {
      atomicWrite(hooksFile, `${JSON.stringify(doc, null, 2)}\n`);
      changed = true;
    }
    return { changed };
  } catch (error) {
    return { problem: `could not install shepherd's status hook under ${dir}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The progress line for a first install. */
export const cursorHookInstalledLine = (home: string): string => `cursor-agent: installed shepherd's status hook in ${path.join(home, ".cursor", "hooks.json")} (Cursor does not report idle/working to herdr on its own)`;

/** Why a cursor-agent tab that reported no status never became ready. */
export const CURSOR_SILENT_HINT = "cursor-agent reported no status to herdr, so shepherd cannot tell when it is ready or done; check that ~/.cursor/hooks.json still has shepherd's hc-status entries";
