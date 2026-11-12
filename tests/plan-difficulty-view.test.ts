import { describe, expect, it } from "vitest";
import { PLAN_FILE, renderPlanReview } from "../src/orchestrator/plan.js";
import { renderTicket } from "../src/orchestrator/tickets.js";
import { sampleSpec, sampleTicket, ticketWorkflow, tieredConfig, tempRepo, workflow } from "./helpers.js";

const tickets = [
  sampleTicket("01", { difficulty: "low", title: "Scaffold the project" }),
  sampleTicket("02", { difficulty: "medium", title: "Add the parser", blockedBy: ["01"] }),
  sampleTicket("03", { difficulty: "high", title: "Harden auth", blockedBy: ["02"] }),
];

describe("difficulty in the plan", () => {
  it("shows a Tickets table with the implementer, and the difficulty in each heading", async () => {
    const { app, taskId } = await ticketWorkflow(tickets);
    const markdown = app.store.readText(taskId, PLAN_FILE)!;
    const section = markdown.slice(markdown.indexOf("## Tickets"));
    expect(section.split("\n").slice(0, 7)).toEqual([
      "## Tickets",
      "",
      "| # | Ticket | Difficulty | Implementer | Blocked by |",
      "| --- | --- | --- | --- | --- |",
      "| 01 | Scaffold the project | low | xai/grok-4.7 | none |",
      "| 02 | Add the parser | medium | anthropic/claude-sonnet-5-5 | 01 |",
      "| 03 | Harden auth | high | openai/gpt-6.1-sol | 02 |",
    ]);
    expect(markdown).toContain("### 01 · low · Scaffold the project");
    expect(markdown).toContain("### 03 · high · Harden auth");
    expect(markdown).not.toContain("difficulty: high");
    expect(markdown.indexOf("| # |")).toBeLessThan(markdown.indexOf("### 01"));
  });

  it("puts the table in the result of writing the tickets", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig() });
    await app.startPlan("Add retry to the ingest parser");
    await app.savePlanSpec(sampleSpec);
    const params = tickets.map((item) => ({ ...item, implementation: "Do it in src/ingest.ts." }));
    const { table } = await app.commitTickets(params);
    expect(table).toContain("| 03 | Harden auth | high | openai/gpt-6.1-sol | 02 |");
    expect(table).toContain("| # | Ticket | Difficulty | Implementer | Blocked by |");
  });

  it("renders the difficulty in a ticket file and omits the table without a config", async () => {
    expect(renderTicket(tickets[2]!)).toContain("**Difficulty: high**");
    const { app, taskId } = await ticketWorkflow(tickets);
    expect(renderPlanReview(app.store.load(taskId)!.plan!, undefined)).not.toContain("| # |");
  });
});
