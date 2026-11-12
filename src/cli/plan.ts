/**
 * `shepherd plan ...`, `shepherd plans` and `shepherd task ...`: thin adapters from argv to the Workflow's planning
 * methods. Claude Code's main session drafts the spec and tickets; every rule (validation, redaction, ticket sizing,
 * phases, approval) stays in the orchestrator. Nothing here throws: a failure is a failed CommandResult.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowConfig } from "../config.js";
import { ticketDifficulty, WorkflowError, type CommandResult, type TaskState } from "../domain.js";
import { done, fail } from "../orchestrator/context.js";
import { ticketRouteView } from "../orchestrator/plan.js";
import { TECHNICAL_PLAN, LOCAL_SIZE_RULES, TICKET_RULES } from "../orchestrator/prompts.js";
import { CLOUD_TICKET_TOKENS, localLimits } from "../orchestrator/routing.js";
import type { Workflow } from "../orchestrator/service.js";
import { displayName } from "../orchestrator/tasks.js";
import { redact } from "../redact.js";

export const PLAN_USAGE = `Usage:
  shepherd plan start "<request>"     (or "-" to read the request from stdin)
  shepherd plan spec <file|->         the spec as JSON
  shepherd plan tickets <file|->      the tickets as JSON
  shepherd plan show
  shepherd plan revise "<changes>"    send the draft back for changes, then resend spec and tickets
  shepherd plan approve
  shepherd plans [<name> | close <name> | --all]
  shepherd task list [--all] | use <name> | close [<name>] [--force]
All commands accept --json.`;

const SPEC_SCHEMA = `{
  "summary": "what will be built and why, a short paragraph",
  "context": "what the code does today in the area that changes (files and functions you read)",
  "approach": "the technical design: components, data flow, new types and signatures, error handling, config",
  "changes": [{ "path": "repo/relative/file.ts", "change": "functions, types or exports added or modified (or 'new file: ...')" }],
  "reuse": ["existing function or utility, with its path"],
  "decisions": [{ "question": "...", "answer": "...", "rationale": "..." }],
  "assumptions": ["a decision made without asking, and why"],
  "outOfScope": ["..."],
  "risks": ["..."],
  "verification": ["a test to add or a command to run"],
  "complexity": "low | medium | high",
  "risk": "low | medium | high",
  "securitySensitive": false,
  "classificationReason": "one short sentence on the rating"
}
Required: summary, approach, changes (at least one), verification (at least one).`;

const TICKETS_SCHEMA = `{ "tickets": [
  {
    "id": "01",
    "slug": "lowercase-kebab-case",
    "title": "single line",
    "whatToBuild": "the end-to-end behavior to deliver",
    "implementation": "files, functions and signatures to add, how they wire in, tests to write (lists or ### headings, never # or ##)",
    "acceptanceCriteria": ["at least one checkable criterion, one line each"],
    "blockedBy": [],
    "difficulty": "low | medium | high",
    "files": ["repo/relative/file.ts"],
    "estimatedContextTokens": 30000,
    "checks": ["npm test"]
  }
] }
Required per ticket: id, slug, title, whatToBuild, acceptanceCriteria, estimatedContextTokens (a positive number). difficulty, files and checks are optional but set difficulty on every ticket.`;

/** Pi's tool names in the prompt text, as the CLI commands that replace them. */
function rephrase(text: string): string {
  return text.replace(/plan_tickets/g, "`shepherd plan tickets`").replace(/plan_spec/g, "`shepherd plan spec`").replace(/plan_questions/g, "AskUserQuestion");
}

function specGuide(): string {
  return rephrase(`Next: write the spec as JSON to a file and run \`shepherd plan spec <file>\`.\n${TECHNICAL_PLAN}\n\nSpec JSON:\n${SPEC_SCHEMA}`);
}

function ticketsGuide(config: WorkflowConfig): string {
  const limits = localLimits(config);
  // TICKET_RULES ends with Pi's review-screen paragraph; the CLI replaces it.
  const rules = TICKET_RULES(CLOUD_TICKET_TOKENS).split("\n").slice(0, -1).join("\n");
  return rephrase(`Next: write the tickets as JSON to a file and run \`shepherd plan tickets <file>\`. Every problem is listed; fix them all and resend.\n${rules}${limits.length ? `\n\n${LOCAL_SIZE_RULES(limits)}` : ""}\n\nTickets JSON:\n${TICKETS_SCHEMA}`);
}

const NEXT_APPROVAL = "Next: `shepherd plan show` and show it to the user, then ask whether to approve.";

/** The text of a failed or finished command, in the CLI's words rather than Pi's. */
function cliText(text: string): string {
  return text
    .replace(/Call plan_tickets\.?/g, "Resend with `shepherd plan tickets`.")
    .replace(/and call plan_tickets again/g, "and run `shepherd plan tickets` again")
    .replace(/Write the spec first with plan_spec, then call plan_tickets\./g, "Save the spec first with `shepherd plan spec <file>`, then run `shepherd plan tickets <file>`.")
    .replace(/No \/plan is running\. Start one with \/plan <request>\./g, 'No plan is being drafted. Run `shepherd plan start "<request>"`.')
    .replace(/plan_tickets/g, "`shepherd plan tickets`")
    .replace(/plan_spec/g, "`shepherd plan spec`")
    .replace(/\/show-plan/g, "`shepherd plan show`")
    .replace(/\/plan <request>/g, '`shepherd plan start "<request>"`')
    .replace(/\/plans/g, "`shepherd plans`")
    .replace(/Run \/build\./g, "/shepherd:build runs it.")
    .replace(/\/build/g, "/shepherd:build");
}

function asResult(error: unknown): CommandResult {
  if (error instanceof WorkflowError) return fail(error.code, cliText(error.message));
  return fail("ERROR", redact(error instanceof Error ? error.message.split("\n")[0]! : String(error)));
}

/** The JSON a file or stdin holds. A bad path or bad JSON is a failed result, not a throw. */
function readJsonInput(ref: string | undefined, stdin: string, cwd: string, what: string): { value: unknown } | { failed: CommandResult } {
  if (!ref) return { failed: fail("USAGE", `Give the ${what} file, or "-" to read it from stdin.`) };
  let text: string;
  if (ref === "-") text = stdin;
  else {
    const file = path.resolve(cwd, ref);
    if (!existsSync(file)) return { failed: fail("BAD_INPUT", `No such file: ${ref}`) };
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      return { failed: fail("BAD_INPUT", `Cannot read ${ref}: ${(error as Error).message.split("\n")[0]}`) };
    }
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { failed: fail("BAD_INPUT", `The ${what} is not valid JSON (${(error as Error).message.split("\n")[0]}). Write the JSON to a file with the Write tool, then pass its path.`) };
  }
}

/** One line per plan decision for the approval prompt: "2 low (m1), 1 high (m3)". */
function modelSummary(task: TaskState, config: WorkflowConfig): string {
  const counts = new Map<string, { n: number; model: string }>();
  for (const ticket of task.plan?.tickets ?? []) {
    const difficulty = ticketDifficulty(ticket);
    const entry = counts.get(difficulty) ?? { n: 0, model: ticketRouteView(config, ticket).implementer };
    entry.n += 1;
    counts.set(difficulty, entry);
  }
  return ["low", "medium", "high"].flatMap((d) => (counts.has(d) ? [`${counts.get(d)!.n} ${d} (${counts.get(d)!.model})`] : [])).join(", ");
}

/** The PreToolUse "ask" reason for `shepherd plan approve`: names the task, ticket count and the models that will build. */
export async function approvalReason(workflow: Workflow, config: WorkflowConfig): Promise<string> {
  const task = await workflow.activeTask();
  const tickets = task?.plan?.tickets?.length ?? 0;
  if (!task || !task.plan || task.phase !== "AWAITING_PLAN_APPROVAL") return `Approve the plan${task ? ` for ${displayName(task)}` : ""}? There is no drafted plan waiting, so this will most likely fail.`;
  return `Approve the plan for ${displayName(task)}? ${tickets} ticket${tickets === 1 ? "" : "s"}, models ${modelSummary(task, config)}. Approving lets /shepherd:build run it.`;
}

export interface PlanInput {
  workflow: Workflow;
  config: WorkflowConfig;
  /** The words after `plan` (flags removed). */
  args: string[];
  stdin: string;
  cwd: string;
}

/** `shepherd plan <sub> ...`. */
export async function planCommand({ workflow, config, args, stdin, cwd }: PlanInput): Promise<CommandResult> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "start": {
        const request = rest.length === 1 && rest[0] === "-" ? stdin.trim() : rest.join(" ").trim();
        const started = await workflow.startPlan(request, { headless: true });
        if (!started.ok) return fail(started.code ?? "ERROR", cliText(started.text));
        const task = workflow.activeTaskId() ? workflow.store.load(workflow.activeTaskId()!) : undefined;
        const name = task ? displayName(task) : "";
        const stage = workflow.planningStage();
        const head = `${(started.data as { resumed?: boolean } | undefined)?.resumed ? "Resuming" : "Planning"} task ${name}. Do not edit the repository while planning.`;
        return done(`${head}\n\n${stage === "tickets" ? ticketsGuide(config) : `${specGuide()}\n\nAfter the spec is saved, the tickets. ${ticketsGuide(config)}`}`, { ...(started.data as object), name, stage });
      }
      case "spec": {
        const input = readJsonInput(rest[0], stdin, cwd, "spec");
        if ("failed" in input) return input.failed;
        const saved = await workflow.savePlanSpec(input.value);
        const rated = saved.classification;
        return done(`Spec saved to ${saved.file}. Rated ${rated.complexity} complexity, ${rated.risk} risk.\n\n${ticketsGuide(config)}`, { file: saved.file, classification: rated });
      }
      case "tickets": {
        const input = readJsonInput(rest[0], stdin, cwd, "tickets");
        if ("failed" in input) return input.failed;
        workflow.requireTicketStage();
        const raw = input.value && typeof input.value === "object" && !Array.isArray(input.value) ? (input.value as { tickets?: unknown }).tickets : input.value;
        const check = workflow.checkTickets(raw);
        if (check.errors.length) return fail("TICKETS_INVALID", `Tickets rejected (${check.errors.length} problem${check.errors.length === 1 ? "" : "s"}). Fix all of them and run \`shepherd plan tickets\` again:\n${check.errors.map((e) => `- ${cliText(e)}`).join("\n")}`);
        const { plan, files, table } = await workflow.commitTickets(check.tickets);
        return done(`${check.tickets.length} tickets written (${files.length} files). Plan v${plan.version} is a draft.\n\n${table}\n\n${NEXT_APPROVAL}`, { version: plan.version, tickets: check.tickets.length, files });
      }
      case "show": {
        const shown = await workflow.showPlan();
        return shown.ok ? shown : fail(shown.code ?? "ERROR", cliText(shown.text));
      }
      case "revise": {
        const changes = rest.length === 1 && rest[0] === "-" ? stdin.trim() : rest.join(" ").trim();
        if (!changes) return fail("USAGE", 'Describe the changes: shepherd plan revise "<what should change>".');
        const revised = await workflow.reviseDraft(changes);
        if (!revised.ok) return fail(revised.code ?? "ERROR", cliText(revised.text));
        return done(`The plan is back in planning with your changes. Re-read code where needed, then resend the full spec and the full tickets.\n\n${specGuide()}`, revised.data);
      }
      case "approve": {
        const approved = await workflow.approveDraft();
        return approved.ok ? done(cliText(approved.text), approved.data) : fail(approved.code ?? "ERROR", cliText(approved.text));
      }
      default:
        return fail("USAGE", PLAN_USAGE);
    }
  } catch (error) {
    return asResult(error);
  }
}

/** `shepherd plans [args]`. */
export async function plansCommand(workflow: Workflow, args: string[]): Promise<CommandResult> {
  try {
    const result = await workflow.plans(args.join(" "));
    return { ...result, text: cliText(result.text) };
  } catch (error) {
    return asResult(error);
  }
}

/** `shepherd task list|use <name>|close [<name>] [--force]`. `--force` answers the "close anyway?" question. */
export async function taskCommand(workflow: Workflow, args: string[]): Promise<CommandResult> {
  const [sub, ...rest] = args;
  try {
    if (sub === "list") return plansCommand(workflow, rest);
    if (sub === "use") return rest.length ? plansCommand(workflow, rest) : fail("USAGE", "Usage: shepherd task use <name>");
    if (sub === "close") {
      const name = rest.length ? rest.join(" ") : (await workflow.activeTask()) ? displayName((await workflow.activeTask())!) : "";
      return name ? plansCommand(workflow, ["close", name]) : fail("NO_TASK", "No active task to close.");
    }
    return fail("USAGE", PLAN_USAGE);
  } catch (error) {
    return asResult(error);
  }
}
