import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { contextOf, tempRepo, tieredConfig, workflow } from "./helpers.js";
import { CLOUD_TICKET_TOKENS, climbed, contextTarget, escalate, localLimits, modelFor, nextRung, reviewModel, routeFor } from "../src/orchestrator/routing.js";

const LOCAL = `local:
  baseUrl: "http://127.0.0.1:8081/v1"
  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]
`;

describe("modelFor and escalate", () => {
  it("routes each difficulty to its model, from the defaults when models is unset", () => {
    const config = tieredConfig();
    expect(["low", "medium", "high"].map((d) => modelFor(config, d as never))).toEqual([
      { kind: "pi", provider: "xai", id: "grok-4.7" },
      { kind: "pi", provider: "anthropic", id: "claude-sonnet-5-5" },
      { kind: "pi", provider: "openai", id: "gpt-6.1-sol" },
    ]);
    expect(reviewModel(config)).toEqual({ kind: "pi", provider: "anthropic", id: "claude-opus-5-5" });
  });

  it("climbs low, medium, high and then stops: there is no rung above high", () => {
    expect(escalate("low")).toBe("medium");
    expect(escalate("medium")).toBe("high");
    expect(escalate("high")).toBeUndefined();
    expect(climbed("low", "high")).toBe(2);
    expect(climbed("medium", "low")).toBe(0);
    const config = tieredConfig();
    expect(nextRung(config, "low")).toBe("medium");
    expect(nextRung(config, "high")).toBeUndefined();
  });

  it("skips a rung that names the same model, and stops when nothing above differs", () => {
    const config = parseConfig("models: { low: anthropic/claude-sonnet-5-5, medium: anthropic/claude-sonnet-5-5, high: anthropic/claude-sonnet-5-5:high }\n");
    // The thinking level is part of the request, so a higher level of the same model is a different rung.
    expect(nextRung(config, "low")).toBe("high");
    const same = parseConfig("models: { low: anthropic/x, medium: anthropic/x, high: anthropic/x }\n");
    expect(nextRung(same, "low")).toBeUndefined();
  });

  it("returns an agent as an agent", () => {
    const config = parseConfig("models: { high: 'agent:claude/opus' }\n");
    expect(modelFor(config, "high")).toEqual({ kind: "agent", name: "claude", model: "opus" });
  });
});

describe("review models", () => {
  it("the review model is models.review, a Pi model or an agent", () => {
    expect(reviewModel(parseConfig("models: { review: openai/gpt-6.1-sol:high }\n"))).toMatchObject({ kind: "pi", provider: "openai", id: "gpt-6.1-sol", thinking: "high" });
    expect(reviewModel(parseConfig("models: { review: 'agent:claude/opus' }\n"))).toEqual({ kind: "agent", name: "claude", model: "opus" });
  });
});

describe("availability is whether `pi` can be started", () => {
  it("routeFor blocks a Pi model only when the host says `pi` is not on PATH, and never an agent", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig() });
    const ctx = contextOf(app);
    const sol = modelFor(ctx.config, "high");
    expect(routeFor(ctx, "high", sol)).toEqual({ rung: "high", model: sol, label: "openai/gpt-6.1-sol" });
    ctx.piAvailable = () => true;
    expect(routeFor(ctx, "high", sol).blocked).toBeUndefined();
    ctx.piAvailable = () => false;
    expect(routeFor(ctx, "high", sol).blocked).toMatch(/^openai\/gpt-6\.1-sol: `pi` is not on PATH/);
    expect(routeFor(ctx, "high", { kind: "agent", name: "claude" })).toEqual({ rung: "high", model: { kind: "agent", name: "claude" }, label: "agent:claude" });
  });
});

describe("local model limits for the planner", () => {
  it("names the difficulties built by a local model with a window, and sizes tickets to half of it", () => {
    const config = parseConfig(`models: { low: local/Qwen3.8-27B, medium: local/other }\n${LOCAL}`);
    expect(localLimits(config)).toEqual([{ difficulty: "low", model: "local/Qwen3.8-27B", contextWindow: 131072, targetTokens: 65536 }]);
    expect(contextTarget(config, "low")).toBe(65536);
    expect(contextTarget(config, "medium")).toBe(CLOUD_TICKET_TOKENS);
    expect(contextTarget(config, "high")).toBe(CLOUD_TICKET_TOKENS);
    expect(localLimits(tieredConfig())).toEqual([]);
  });
});
