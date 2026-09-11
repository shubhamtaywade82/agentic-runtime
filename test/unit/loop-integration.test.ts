import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentRunner } from "../../src/loop/agent-runner.js";
import { ContextManager } from "../../src/memory/context-manager.js";
import { ToolkitCatalogue } from "../../src/hands/catalogue.js";
import { ResourceSentinel } from "../../src/sentinel/index.js";
import type { ToolDefinition, ToolResult } from "../../src/core/types.js";
import { TopKCapabilitySelector } from "../../src/capability/selector.js";
import { GrantLevelPolicy } from "../../src/policy/grant-level-policy.js";
import { createApprovalProvider, autoApprove, autoDeny } from "../../src/policy/approval.js";
import { DeclarativeModelRouter } from "../../src/router/declarative-router.js";
import {
  assistantTurn,
  createScriptedBrain,
  modelReportJson,
  type ScriptedBrain,
} from "./scripted-brain.js";

const noopSink = { emit: () => {} };

function makeContext(initial: ConstructorParameters<typeof ContextManager>[2] = []): ContextManager {
  return new ContextManager(
    {
      modelCapacityTokenCeiling: 1_000_000,
      reserveFreshTailCount: 4,
      digestStyleHint: "concise",
    },
    { summarize: async () => "digest" },
    initial,
  );
}

function tool(handle: string, grantLevel: "auto" | "acknowledged" | "manual", output = `out:${handle}`): ToolDefinition<Record<string, unknown>> {
  return {
    handle,
    caption: `tool ${handle}`,
    argsShape: z.object({ x: z.number().optional() }),
    resourceClass: "external-network",
    effects: "pure",
    grantLevel,
    invoke: async (): Promise<ToolResult> => ({
      toolCallId: `call-${handle}`,
      name: handle,
      success: true,
      output,
      trustLevel: "unverified",
      executionTimeMs: 1,
    }),
  };
}

/** Brain script: call tools once, then answer. */
function callToolsThenAnswer(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, answer = "Done. The result is sufficient for the objective.") {
  let answered = false;
  return () => {
    if (answered || toolCalls.length === 0) {
      answered = true;
      return assistantTurn({ content: answer });
    }
    answered = true;
    return assistantTurn({
      content: "I will use tools.",
      finishTag: "tool_calls",
      toolCalls: toolCalls.map((c, i) => ({ id: `call-${i}`, name: c.name, arguments: c.arguments })),
    });
  };
}

/** Brain script that answers on loop calls, seals via constrain detection. */
function loopThenSeal(loop: () => ReturnType<typeof assistantTurn>) {
  return (call: { schedule: { constrain?: unknown } }) => {
    if (call.schedule.constrain !== undefined) {
      return assistantTurn({ content: modelReportJson() });
    }
    return loop();
  };
}

function makeRunner(
  brain: ScriptedBrain,
  opts: {
    tools?: ToolDefinition<Record<string, unknown>>[];
    policy?: ConstructorParameters<typeof GrantLevelPolicy>[0];
    approvals?: ReturnType<typeof createApprovalProvider>;
    approvalTimeoutMs?: number;
    selector?: TopKCapabilitySelector;
    router?: DeclarativeModelRouter;
    laneMode?: "replace" | "append";
    initialContext?: ConstructorParameters<typeof ContextManager>[2];
    sentinel?: ResourceSentinel;
  } = {},
): { runner: AgentRunner; brain: ScriptedBrain } {
  const catalogue = new ToolkitCatalogue(noopSink);
  for (const t of opts.tools ?? [tool("echo", "auto")]) catalogue.place(t);
  const context = makeContext(opts.initialContext);
  const runner = new AgentRunner(brain, catalogue, context, {
    adminCharter: "You are a test agent.",
    ...(opts.policy !== undefined ? { policy: new GrantLevelPolicy(opts.policy) } : {}),
    ...(opts.approvals !== undefined ? { approvals: opts.approvals } : {}),
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.selector !== undefined ? { capabilitySelector: opts.selector } : {}),
    ...(opts.router !== undefined ? { router: opts.router } : {}),
    ...(opts.laneMode !== undefined ? { laneMode: opts.laneMode } : {}),
    ...(opts.sentinel !== undefined ? { sentinel: opts.sentinel } : {}),
  });
  return { runner, brain };
}

describe("AgentRunner - policy gate integration", () => {
  it("ALLOW: auto-grant tools dispatch normally", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "echo", arguments: {} }])));
    const { runner } = makeRunner(brain, { tools: [tool("echo", "auto")] });

    const result = await runner.run("Do the thing");
    expect(result.status).toBe("ACHIEVED");
    expect(result.intentsDispatched).toBe(1);
    expect(result.steps[0]?.toolResults[0]?.success).toBe(true);
  });

  it("DENY: denylisted tools never dispatch, denial feeds back to the model", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(callToolsThenAnswer([{ name: "echo", arguments: {} }])),
    );
    const { runner } = makeRunner(brain, {
      tools: [tool("echo", "auto")],
      policy: { denyTools: ["echo"] },
    });

    const result = await runner.run("Do the forbidden thing");
    expect(result.status).toBe("ACHIEVED");
    // Denial consumed no intent budget.
    expect(result.intentsDispatched).toBe(0);

    const denial = result.steps[0]?.toolResults[0];
    expect(denial?.success).toBe(false);
    expect(denial?.output).toContain("POLICY_DENIED");
    expect(denial?.output).toContain("denylisted");
    expect(denial?.trustLevel).toBe("verified");
  });

  it("REQUIRE_APPROVAL + approval: dispatch proceeds", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "write", arguments: {} }])));
    const approvals = createApprovalProvider(async () => ({ approved: true }));
    const { runner } = makeRunner(brain, {
      tools: [tool("write", "acknowledged")],
      policy: {},
      approvals,
    });

    const result = await runner.run("Write the file");
    expect(result.intentsDispatched).toBe(1);
    expect(result.steps[0]?.toolResults[0]?.success).toBe(true);
  });

  it("REQUIRE_APPROVAL + rejection: denial without dispatch", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "write", arguments: {} }])));
    const { runner } = makeRunner(brain, {
      tools: [tool("write", "acknowledged")],
      policy: {},
      approvals: autoDeny("operator says no"),
    });

    const result = await runner.run("Write the file");
    expect(result.intentsDispatched).toBe(0);
    expect(result.steps[0]?.toolResults[0]?.output).toContain("operator says no");
  });

  it("REQUIRE_APPROVAL without a provider fails closed", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "write", arguments: {} }])));
    const { runner } = makeRunner(brain, { tools: [tool("write", "acknowledged")], policy: {} });

    const result = await runner.run("Write the file");
    expect(result.intentsDispatched).toBe(0);
    expect(result.steps[0]?.toolResults[0]?.output).toContain("fails closed");
  });

  it("approval timeout denies (fail-closed) and the run still seals", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "write", arguments: {} }])));
    const slow = createApprovalProvider(() => new Promise(() => {}) as never);
    const { runner } = makeRunner(brain, {
      tools: [tool("write", "acknowledged")],
      policy: {},
      approvals: slow,
      approvalTimeoutMs: 25,
    });

    const result = await runner.run("Write the file");
    expect(result.intentsDispatched).toBe(0);
    expect(result.steps[0]?.toolResults[0]?.output).toContain("timed out");
    expect(result.finalReport.status).toBe("ACHIEVED");
  });

  it("manual grant level escalates to privileged-scope approval", async () => {
    const scopes: string[] = [];
    const approvals = createApprovalProvider(async (req) => {
      scopes.push(req.scope);
      return { approved: true };
    });
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "deploy", arguments: {} }])));
    const { runner } = makeRunner(brain, {
      tools: [tool("deploy", "manual")],
      policy: {},
      approvals,
    });

    await runner.run("Deploy to production");
    expect(scopes).toEqual(["privileged"]);
  });

  it("allowlisted tools bypass grant-level requirements", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([{ name: "deploy", arguments: {} }])));
    const { runner } = makeRunner(brain, {
      tools: [tool("deploy", "manual")],
      policy: { allowTools: ["deploy"] },
    });

    const result = await runner.run("Deploy");
    expect(result.intentsDispatched).toBe(1);
  });
});

describe("AgentRunner - capability selector integration", () => {
  const tools = [
    tool("file_read", "auto"),
    tool("file_write", "acknowledged"),
    tool("web_search", "auto"),
    tool("git_status", "auto"),
  ];

  it("selector narrows mounted manifests; unmounted tools stay dispatchable", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(callToolsThenAnswer([{ name: "file_read", arguments: {} }])),
    );
    const { runner } = makeRunner(brain, {
      tools,
      selector: new TopKCapabilitySelector({ limit: 1 }),
    });

    const result = await runner.run("Read the file at /tmp/data.json");

    // Only the top-ranked tool manifest was mounted for the loop call.
    const loopCall = brain.calls.find((c) => c.schedule.constrain === undefined);
    expect(loopCall?.schedule.mounting?.manifests).toHaveLength(1);
    expect(loopCall?.schedule.mounting?.manifests[0]?.name).toBe("file_read");

    // The tool still dispatched (governance unchanged) and the run sealed.
    expect(result.intentsDispatched).toBe(1);
    expect(result.status).toBe("ACHIEVED");
  });

  it("without a selector, all manifests mount (v0.1 behavior)", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(callToolsThenAnswer([{ name: "web_search", arguments: {} }])),
    );
    const { runner } = makeRunner(brain, { tools });

    await runner.run("Search the web");
    const loopCall = brain.calls.find((c) => c.schedule.constrain === undefined);
    expect(loopCall?.schedule.mounting?.manifests).toHaveLength(4);
  });
});

describe("AgentRunner - model router integration", () => {
  it("steps run on the default brain; sealing runs on the router-selected seal brain", async () => {
    const stepBrain = createScriptedBrain(
      loopThenSeal(callToolsThenAnswer([])),
    );
    const sealBrain = createScriptedBrain(() =>
      assistantTurn({ content: modelReportJson() }),
    );

    const router = new DeclarativeModelRouter({
      default: stepBrain,
      rules: [{ when: { phase: "seal" }, brain: sealBrain }],
    });

    const brain = createScriptedBrain(
      loopThenSeal(callToolsThenAnswer([])),
    );
    // The runner's primary brain is only used when the router is absent;
    // with a router every digest flows through the router.
    const { runner } = makeRunner(brain, { router });

    const result = await runner.run("Summarize the situation");

    expect(result.status).toBe("ACHIEVED");
    // Loop turn went to the default (step) brain.
    const loopCalls = stepBrain.calls.filter((c) => c.schedule.constrain === undefined);
    expect(loopCalls.length).toBe(1);
    // Seal went to the seal brain (it saw the constrain schedule).
    expect(sealBrain.calls).toHaveLength(1);
    expect(sealBrain.calls[0]?.schedule.constrain).toBeDefined();
    // The primary brain was never consulted.
    expect(brain.calls).toHaveLength(0);
  });

  it("sentinel brain gates key on the SELECTED brain's identity", async () => {
    const sentinel = new ResourceSentinel(
      { maxParallelTools: 2, maxParallelInferences: 2, maxQueueDepth: 8 },
      noopSink,
    );
    // Step 0 uses brainA (default); step 1+ switches to brainB.
    const brainA = createScriptedBrain(() =>
      assistantTurn({ content: "thinking", finishTag: "tool_calls", toolCalls: [] }),
    );
    const brainB = createScriptedBrain(() =>
      assistantTurn({ content: "Done. The result is sufficient for the objective." }),
    );
    const sealBrain = createScriptedBrain(() => assistantTurn({ content: modelReportJson() }));
    const router = new DeclarativeModelRouter({
      default: brainA,
      rules: [
        { when: { phase: "seal" }, brain: sealBrain },
        { when: { stepIndexAbove: 0 }, brain: brainB },
      ],
    });

    const primary = createScriptedBrain(loopThenSeal(callToolsThenAnswer([])));
    const { runner } = makeRunner(primary, { router, sentinel });

    const result = await runner.run("Check gate routing");
    expect(result.status).toBe("ACHIEVED");

    // Step 0 went to brainA, step 1 to brainB (stepIndexAbove routing).
    expect(brainA.calls).toHaveLength(1);
    expect(brainB.calls).toHaveLength(1);
    expect(primary.calls).toHaveLength(0);

    // Two loop inferences through two DISTINCT per-model brain gates
    // (gate keyed on each selected brain's identityTag).
    const stats = sentinel.aggregateStats();
    expect(stats.grants).toBe(2);
    // Seal inferences are ungated (v0.1 behavior preserved).
    expect(sealBrain.calls).toHaveLength(1);
  });
});

describe("AgentRunner - lane modes", () => {
  it("replace mode (default) resets the lane per run", async () => {
    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([])));
    const { runner } = makeRunner(brain);
    const context = makeContext();

    await runner.run("first objective");
    const laneAfterFirst = context.lane.length;

    const brain2 = createScriptedBrain(loopThenSeal(callToolsThenAnswer([])));
    const runner2 = new AgentRunner(brain2, new ToolkitCatalogue(noopSink), context, {
      adminCharter: "charter",
    });
    await runner2.run("second objective");
    // charter + objective + assistant turn (+ possible seal context) - the
    // first run's messages are gone.
    expect(context.lane.length).toBeLessThanOrEqual(laneAfterFirst + 2);
    expect(context.lane.some((m) => m.content.includes("first objective"))).toBe(false);
  });

  it("append mode preserves prior history and adds the objective", async () => {
    const context = makeContext([
      { role: "system", content: "pinned charter" },
      { role: "user", content: "earlier request" },
      { role: "assistant", content: "earlier answer" },
    ]);

    const brain = createScriptedBrain(loopThenSeal(callToolsThenAnswer([])));
    const { runner } = makeRunner(brain, { laneMode: "append", initialContext: undefined });

    // Reuse the prepared context: build a runner directly over it.
    const runner2 = new AgentRunner(brain, new ToolkitCatalogue(noopSink), context, {
      adminCharter: "charter",
      laneMode: "append",
    });
    await runner2.run("follow-up objective");

    expect(context.lane.some((m) => m.content === "pinned charter")).toBe(true);
    expect(context.lane.some((m) => m.content === "earlier request")).toBe(true);
    expect(context.lane.some((m) => m.content === "follow-up objective")).toBe(true);
  });
});

describe("AgentRunner - contextPressure", () => {
  it("pressure grows with the lane and is bounded at 1", () => {
    const context = makeContext();
    expect(context.contextPressure()).toBe(0);

    for (let i = 0; i < 500; i++) {
      context.append({ role: "user", content: "x".repeat(100) });
    }
    // 500 messages * ~49 tokens each dwarfs the 1_000_000 cap? 500*49=24.5k -> 0.0245.
    expect(context.contextPressure()).toBeGreaterThan(0);
    expect(context.contextPressure()).toBeLessThanOrEqual(1);
  });
});
