/**
 * What every herdr tab runner shares: the tab name, and `openTab`, the open / send / wait / read / close loop of a program
 * in a tab (`pi-ticket.ts` and `agent-ticket.ts` run tickets with it, `agent-review.ts` runs /review with it). Each runner
 * adds its own "collect" step after a turn (a Pi child's session files, an agent's usage log and summary file).
 *
 * herdr reports a terminal's status as `working`, `blocked` (the program waits for the person: an approval, a question),
 * `idle`, `done` (finished while nobody looked: the same as idle here), `error`, or the terminal ended. A send is
 * `hc send --wait`, which types the text and waits for the turn that send started, so an idle status read just before the
 * turn begins cannot end it early. Before a send the tab is waited for until it is no longer working or blocked (`hc send`
 * would queue text for a working tab and refuse a blocked one). One `hc` call blocks for at most a slice: a check-in that
 * finds the tab still working is followed by `hc wait`, up to the wall-clock limit. A blocked tab is waited for with one
 * progress line, the first time.
 */
import type { TrustPrompt } from "../agents.js";
import type { HerdrClient, WaitResult } from "../herdr/client.js";
import { redact } from "../redact.js";

export const READY_TIMEOUT_MS = 5 * 60_000;
/** After this long with no ready report, tell the person the tab may need them. */
export const READY_NUDGE_MS = 20_000;
/** How long one look for a known trust prompt waits for a ready report first. */
export const TRUST_LOOK_MS = 2000;
/** The wall-clock limit of one turn: agents have no turn limit, so this is the backstop. */
export const TURN_TIMEOUT_MS = 4 * 60 * 60_000;
/** How much of the screen is kept as the "last text" of a turn. */
export const SCREEN_TAIL_CHARS = 2000;
const SCREEN_HISTORY_LINES = 200;

/**
 * `chef-<task name>-<ticket>-<n>-<time>`, at most 32 characters of a-z 0-9 - _ (hc's rule): the task name gives way when it
 * is long. The last part is the clock in seconds (base 36), so a tab left open by an earlier attempt never has the name.
 */
export function tabName(task: string, ticketId: string, attempt: number, at = Date.now(), prefix = "shep"): string {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const stamp = Math.floor(at / 1000).toString(36).slice(-4);
  const ticket = clean(ticketId).slice(0, 12);
  const tail = `-${ticket}-${attempt}-${stamp}`;
  const room = 32 - prefix.length - 1 - tail.length;
  if (room >= 1) return `${prefix}-${clean(task || "task").slice(0, room)}${tail}`;
  return `${prefix}${tail}`.slice(0, 32);
}

export const messageOf = (error: unknown): string => redact(error instanceof Error && error.message ? error.message : String(error));

/** Test seams and timings shared by the runners. */
export interface TabTimings {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long the tab may take to become ready (a blocked tab may wait for the person up to `turnTimeoutMs`). Default 5 minutes. */
  readyTimeoutMs?: number;
  /** Wall-clock limit of one turn (default 4 hours). */
  turnTimeoutMs?: number;
  /** The pause between looks at a blocked tab. */
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why a wait did not end in a settled tab, or undefined. */
export function waitProblem(waited: WaitResult, tab: string, minutes: number): string | undefined {
  if (waited.status === "ended") return `the herdr sub-agent ${tab} ended${waited.exitCode !== null ? ` (exit ${waited.exitCode})` : ""}`;
  if (waited.timedOut) return `the herdr sub-agent ${tab} was still working after ${minutes} minutes`;
  if (waited.status === "error") return `the program in tab ${tab} reported an error; look at the tab`;
  return undefined;
}

export interface OpenTabInput extends TabTimings {
  client: HerdrClient;
  /**
   * The herdr space of shepherd's own terminal. Given, the tab opens as a visible tab beside it (`herdr.space` and `herdr.tab`
   * labels). Absent (the default), no label is passed: `hc run` from inside a herdr terminal records that terminal as the
   * child's `parent` and the child is a paneless sub-agent, which shows in herdr's agents list.
   */
  space?: string;
  cwd: string;
  /** The program's argv. */
  argv: string[];
  /** The tab's name (`tabName`). */
  name: string;
  labels?: Record<string, string>;
  /** One progress line, for example "Ticket 01 is waiting for you in tab <name>". */
  progress(text: string): void;
  /** What to say, once per wait, when the program is blocked in this tab. */
  blockedNotice: string;
  /** The agent's own "trust this folder?" prompt (`TRUST_PROMPTS`): answered when it shows, before the ready wait. */
  trust?: TrustPrompt;
  /** Said when the program reports no status by the first nudge, and `hc get` confirms it has never reported one: the wait ends there with this message. Only for a program known never to report (cursor-agent). */
  silentHint?: string;
  /** The PATH the program is started with. Default: shepherd's own `PATH`. */
  path?: string;
}

/**
 * The argv with shepherd's PATH put in front through `env`. herdr starts a tab with its server's environment, not ours, and
 * a server started by launchd (macOS) has only /usr/bin:/bin:/usr/sbin:/sbin: an agent installed by fnm, nvm, npm or
 * Homebrew would not be found ("cannot start codex"), nor the `node` its script needs. An argv that is already an `env`
 * wrapper gets the PATH as its first assignment.
 */
export function withPath(argv: string[], path: string | undefined): string[] {
  if (!path || path.includes("\n")) return argv;
  const assignment = `PATH=${path}`;
  return argv[0] === "env" ? ["env", assignment, ...argv.slice(1)] : ["env", assignment, ...argv];
}

export interface Tab {
  address: string;
  name: string;
  /** Types `text` into the tab once it is quiet and waits for the turn that starts, however long a person takes to answer a block. Throws on a dead, errored or timed-out tab. */
  prompt(text: string): Promise<void>;
  /** The tail of the tab's screen (its last output), "" when the client cannot read it. */
  lastText(): Promise<string>;
  /** Closes the tab. Never throws. */
  close(): Promise<void>;
}

/**
 * Opens a tab running `argv`, waits until the program is ready, and returns the handle. Throws (with a message that names
 * the tab) when `hc run` fails or the program never becomes ready; a tab that opened is left open then.
 */
export async function openTab(input: OpenTabInput): Promise<Tab> {
  const { client } = input;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const turnTimeoutMs = input.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const readyTimeoutMs = input.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const address = await client.run({ argv: withPath(input.argv, "path" in input ? input.path : process.env.PATH), cwd: input.cwd, name: input.name, labels: { ...(input.space ? { "herdr.space": input.space, "herdr.tab": input.name } : {}), ...input.labels } });

  /** Follows `current` until the tab is neither working nor blocked, or `limitMs` of active (non-blocked) time has passed. */
  async function settle(current: WaitResult, started: number, limitMs: number): Promise<WaitResult> {
    let announced = false;
    let blockedMs = 0;
    for (;;) {
      const wall = now() - started;
      const activeElapsed = Math.max(0, wall - blockedMs);
      if (current.status === "blocked") {
        // Waiting for the person (an approval): keep waiting up to turnTimeoutMs without burning the active limit.
        if (!announced) {
          announced = true;
          input.progress(input.blockedNotice);
        }
        if (wall >= turnTimeoutMs) return { status: "timeout", exitCode: null, timedOut: true };
        const pauseAt = now();
        await sleep(input.pollMs ?? 3000);
        blockedMs += Math.max(0, now() - pauseAt);
        current = await client.waitIdle(address, { timeoutMs: Math.max(1000, Math.min(turnTimeoutMs - (now() - started), limitMs)) });
        continue;
      }
      if (current.status !== "working") return current;
      if (activeElapsed >= limitMs) return { status: "timeout", exitCode: null, timedOut: true };
      current = await client.waitIdle(address, { timeoutMs: Math.max(1000, limitMs - activeElapsed) });
    }
  }

  const minutes = (ms: number) => Math.round(ms / 60_000);
  const readyAt = now();
  let earlyReady: WaitResult | undefined;
  if (input.trust) {
    for (;;) {
      const look = await client.waitIdle(address, { timeoutMs: TRUST_LOOK_MS });
      // A trust prompt shows as no status yet (timed out) or as `blocked` (agy, live): look at the screen for either.
      if (!look.timedOut && look.status !== "blocked") {
        earlyReady = look;
        break;
      }
      let screen = "";
      try {
        screen = await client.read(address, 0);
      } catch {
        /* unreadable: keep waiting */
      }
      if (input.trust.screen.test(screen)) {
        await client.keys(address, input.trust.keys);
        input.progress(`${input.name}: answered its "trust this folder" prompt for ${input.cwd}`);
        break;
      }
      if (now() - readyAt >= Math.min(READY_NUDGE_MS, readyTimeoutMs)) break;
    }
  }
  let first = earlyReady ?? (await client.waitIdle(address, { timeoutMs: Math.max(1000, Math.min(READY_NUDGE_MS, readyTimeoutMs) - (now() - readyAt)) }));
  let readyLimit = readyTimeoutMs;
  if (first.timedOut && input.silentHint && (await client.reported(address)) === false) throw new Error(`${input.silentHint} (herdr sub-agent ${input.name} is left open)`);
  if (first.timedOut && readyTimeoutMs > READY_NUDGE_MS) {
    input.progress(`${input.blockedNotice} (it has not reported ready; it may be showing a first-run prompt such as "trust this folder")`);
    readyLimit = Math.max(readyTimeoutMs, turnTimeoutMs);
    first = await client.waitIdle(address, { timeoutMs: Math.max(1000, readyLimit - (now() - readyAt)) });
  }
  const ready = await settle(first, readyAt, readyLimit);
  const notReady = waitProblem(ready, address, minutes(readyLimit));
  if (notReady) throw new Error(`${notReady} before the program was ready`);

  return {
    address,
    name: input.name,
    async prompt(text) {
      const started = now();
      // A tab that is still working (the person typed into it) or blocked is waited for first: hc queues text for a working tab.
      const quiet = await settle(await client.waitIdle(address, { timeoutMs: turnTimeoutMs }), started, turnTimeoutMs);
      const before = waitProblem(quiet, address, minutes(turnTimeoutMs));
      if (before) throw new Error(before);
      // After startup or answering a trust prompt, hc send can briefly report "is still starting: its output has not settled";
      // retry until the TUI's screen settles instead of failing the turn.
      const sendRetryMs = input.pollMs ?? 1000;
      const maxSettleWaitMs = Math.min(30_000, turnTimeoutMs);
      let sent: WaitResult;
      for (let attempt = 0; ; attempt += 1) {
        try {
          sent = await client.send(address, text, { timeoutMs: Math.max(1000, turnTimeoutMs - (now() - started)) });
          break;
        } catch (error) {
          const msg = messageOf(error);
          if (!/still starting|output has not settled/i.test(msg) || now() - started >= maxSettleWaitMs || attempt >= 20) {
            throw error;
          }
          await sleep(sendRetryMs);
        }
      }
      const problem = waitProblem(await settle(sent, started, turnTimeoutMs), address, minutes(turnTimeoutMs));
      if (problem) throw new Error(problem);
    },
    async lastText() {
      try {
        return redact((await client.read(address, SCREEN_HISTORY_LINES)).trim()).slice(-SCREEN_TAIL_CHARS);
      } catch {
        return "";
      }
    },
    async close() {
      try {
        await client.kill(address);
      } catch {
        /* already gone */
      }
    },
  };
}
