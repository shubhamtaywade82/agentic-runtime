import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentRunner } from "../../src/loop/agent-runner.js";
import { ContextManager } from "../../src/memory/context-manager.js";
import { ToolkitCatalogue } from "../../src/hands/catalogue.js";
import { ResourceSentinel } from "../../src/sentinel/index.js";
import { FinalReportSchema, InferenceQualityError } from "../../src/core/types.js";
import type { ToolDefinition } from "../../src/core/types.js";
import {
  assistantTurn,
  createScriptedBrain,
  modelReportJson,
  testSealMetrics,
} from "./scripted-brain.js";

const noopSink = { emit: () => {} };

function makeContext(): ContextManager {
  return new ContextManager(
    {
      modelCapacityTokenCeiling: 1_000_000,
      reserveFreshTailCount: 4,
      digestStyleHint: "concise",
    },
    { summarize: async () => "digest" },
  );
}

const echoTool: ToolDefinition<{ x: number }> = {
  handle: "echo",
  caption: "echoes its input",
  argsShape: z.object({ x: z.number() }),
  resourceClass: "external-network",
  effects: "pure",
  grantLevel: "auto",
  invoke: async (_args, _lease, _signal) => ({
    toolCallId: "call-echo",
    name: "echo",
    success: true,
    output: "echoed",
    trustLevel: "unverified",
    executionTimeMs: 1,
  }),
};

function makeRunner(
  brain: ReturnType<typeof createScriptedBrain>,
  opts: { budgets?: Partial<{ maxCogStepN: number; wallTimeCeilMs: number; hardIntentCount: number; maxTokensPerStep: number }>; sentinel?: ResourceSentinel } = {},
): AgentRunner {
  const catalogue = new ToolkitCatalogue(noopSink).place(echoTool);
  return new AgentRunner(brain, catalogue, makeContext(), {
    adminCharter: "You are a test agent.",
    budgets: opts.budgets,
    sentinel: opts.sentinel,
  });
}

/**
 * Brain script that distinguishes loop calls from seal calls via the
 * grammar constraint: only the seal schedule carries `constrain`.
 */
function loopThenSeal(loop: () => ReturnType<typeof assistantTurn>, seal?: string) {
  return (call: { schedule: { constrain?: unknown } }) => {
    if (call.schedule.constrain !== undefined) {
      return assistantTurn({ content: seal ?? modelReportJson() });
    }
    return loop();
  };
}

describe("AgentRunner - terminal sealing (Gap 3)", () => {
  it("ACHIEVED: run terminates with a model-authored seal, never null", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(() => assistantTurn({ content: "The latency is 200ms." })),
    );
    const runner = makeRunner(brain);

    const result = await runner.run("Measure the API latency");

    expect(result.status).toBe("ACHIEVED");
    expect(result.finalReport).not.toBeNull();
    expect(FinalReportSchema.safeParse(result.finalReport).success).toBe(true);
    expect(result.finalReport.status).toBe("ACHIEVED");
    expect(result.finalReport.objective).toBe("Measure the API latency");
    expect(result.finalReport.executiveSummary).not.toContain("SEAL_DEGRADED");
    expect(result.finalReport.seal.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 1 loop call + 1 seal call
    expect(brain.calls).toHaveLength(2);
    const sealCall = brain.calls[1];
    expect(sealCall?.schedule.mounting?.manifests).toHaveLength(0); // No-Tools Guarantee
    expect(sealCall?.schedule.constrain?.subjectOutputSchema).toBeDefined();
  });

  it("fatal error: FAILED with the deterministic degraded seal and no seal inference", async () => {
    const brain = createScriptedBrain(() => {
      throw new InferenceQualityError("daemon produced garbage", ["bad_json"]);
    });
    const runner = makeRunner(brain);

    const result = await runner.run("Do the impossible");

    expect(result.status).toBe("FAILED");
    expect(result.finalReport.status).toBe("FAILED");
    expect(result.finalReport.executiveSummary.startsWith("SEAL_DEGRADED:")).toBe(true);
    expect(result.finalReport.executiveSummary).toContain("daemon produced garbage");
    expect(result.finalReport.findings).toEqual([]);
    // A5: the brain was never consulted for sealing - it is the failure source.
    expect(brain.calls).toHaveLength(1);
  });

  it("budget exhaustion: PARTIAL with a real seal attempt", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(() =>
        assistantTurn({ content: "still investigating", finishTag: "tool_calls", toolCalls: [] }),
      ),
    );
    const runner = makeRunner(brain, { budgets: { maxCogStepN: 2 } });

    const result = await runner.run("Never-ending investigation");

    expect(result.status).toBe("PARTIAL");
    expect(result.finalReport.status).toBe("PARTIAL");
    // 2 loop calls + 1 seal call
    expect(brain.calls).toHaveLength(3);
    const sealPrompt = brain.calls[2]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(sealPrompt).toContain("Budget was exhausted before full completion");
  });

  it("kill switch abort: CEDED (operator abort is not a failure)", async () => {
    let runnerRef: AgentRunner | null = null;
    const brain = createScriptedBrain((call) => {
      if (call.schedule.constrain !== undefined) {
        return assistantTurn({ content: modelReportJson() });
      }
      // Abort mid-run, while a tool dispatch is in flight.
      runnerRef?.getAbortController().abort();
      return assistantTurn({
        content: "calling the tool",
        finishTag: "tool_calls",
        toolCalls: [{ id: "call-1", name: "echo", arguments: { x: 1 } }],
      });
    });
    const runner = makeRunner(brain);
    runnerRef = runner;

    const result = await runner.run("Abort me midway");

    expect(result.status).toBe("CEDED");
    expect(result.finalReport.status).toBe("CEDED");
    expect(FinalReportSchema.safeParse(result.finalReport).success).toBe(true);
  });

  it("seal failure after ACHIEVED: degrades to FAILED, never ships null", async () => {
    const brain = createScriptedBrain((call) => {
      if (call.schedule.constrain !== undefined) {
        // The seal stage emits garbage twice -> SynthesisSealError.
        return assistantTurn({ content: "definitely not json" });
      }
      return assistantTurn({ content: "final answer" });
    });
    const runner = makeRunner(brain);

    const result = await runner.run("Achieve then fail to seal");

    expect(result.status).toBe("FAILED");
    expect(result.finalReport.status).toBe("FAILED");
    expect(result.finalReport.executiveSummary.startsWith("SEAL_DEGRADED:")).toBe(true);
    // 1 loop call + 2 seal attempts
    expect(brain.calls).toHaveLength(3);
  });

  it("seal aborted by kill switch: degrades with CEDED semantics", async () => {
    let runnerRef: AgentRunner | null = null;
    const brain = createScriptedBrain((call) => {
      if (call.schedule.constrain !== undefined) {
        runnerRef?.getAbortController().abort();
        throw new Error("Inference aborted by kill switch");
      }
      return assistantTurn({ content: "final answer" });
    });
    const runner = makeRunner(brain);
    runnerRef = runner;

    const result = await runner.run("Achieve, then die during sealing");

    expect(result.status).toBe("CEDED");
    expect(result.finalReport.status).toBe("CEDED");
    expect(result.finalReport.executiveSummary.startsWith("SEAL_DEGRADED:")).toBe(true);
  });

  it("carries real sentinel telemetry into the sealed metrics", async () => {
    const sentinel = new ResourceSentinel(
      { maxParallelTools: 1, maxParallelInferences: 1, maxQueueDepth: 2 },
      noopSink,
    );
    const neverAbort = () => new AbortController().signal;

    // One granted lease...
    const release = await sentinel.handsGate.acquire("normal", neverAbort());
    // ...then saturate the queue: depth 2 parked waiters, the third rejects.
    const parked1 = sentinel.handsGate.acquire("normal", neverAbort());
    const parked2 = sentinel.handsGate.acquire("normal", neverAbort());
    await new Promise((r) => setTimeout(r, 5));
    await expect(sentinel.handsGate.acquire("normal", neverAbort())).rejects.toThrow();

    const brain = createScriptedBrain(
      loopThenSeal(() => assistantTurn({ content: "answer" })),
    );
    const runner = makeRunner(brain, { sentinel });

    const result = await runner.run("Use the sentinel");

    // 2 acquisitions: 1 pre-seeded hands grant + 1 loop inference grant
    // (the runner now actually acquires a per-model brain-gate lease for
    // every loop digest - sentinel wiring is no longer metrics-only).
    expect(result.finalReport.metrics.sentinelAcquisitions).toBe(2);
    expect(result.finalReport.metrics.sentinelRejections).toBe(1); // the saturation
    expect(result.finalReport.metrics.totalSteps).toBe(1);
    expect(result.finalReport.metrics.totalTokensIn).toBe(0);
    // The brain gate itself saw exactly one acquire/release cycle.
    expect(sentinel.brainGate("scripted:test").stats()).toMatchObject({
      grants: 1,
      active: 0,
    });

    // Drain the parked waiters so nothing dangles.
    release();
    (await parked1)();
    (await parked2)();
  });
});

describe("AgentRunner - step ledger integrity", () => {
  it("records monotonic per-step wall-clock windows (startedAt fix)", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(() =>
        assistantTurn({ content: "step", finishTag: "tool_calls", toolCalls: [] }),
      ),
    );
    const runner = makeRunner(brain, { budgets: { maxCogStepN: 2 } });

    const result = await runner.run("Two-step run");

    expect(result.steps).toHaveLength(2);
    const [first, second] = result.steps;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("unreachable");

    expect(first.completedAt).toBeGreaterThanOrEqual(first.startedAt);
    expect(second.startedAt).toBeGreaterThanOrEqual(first.completedAt);
    expect(second.completedAt).toBeGreaterThanOrEqual(second.startedAt);
  });
});

describe("AgentRunner - audit regressions (Wave 2)", () => {
  it("governance nudges do not consume the hard intent budget", async () => {
    // The brain emits the SAME tool call every step. With the default binder
    // allowance (2), steps 1-2 dispatch; steps 3+ are nudged. Under the old
    // ordering (budget increment before the binder check) the nudged calls
    // also consumed budget and triggered a premature BudgetExhaustedError.
    const brain = createScriptedBrain(
      loopThenSeal(() =>
        assistantTurn({
          content: "again",
          finishTag: "tool_calls",
          toolCalls: [{ id: "c1", name: "echo", arguments: { x: 1 } }],
        }),
      ),
    );
    const runner = makeRunner(brain, {
      budgets: { maxCogStepN: 6, hardIntentCount: 3 },
    });

    const result = await runner.run("Loop the same call");

    // Only the two pre-block calls dispatched; the nudges stayed free.
    expect(result.intentsDispatched).toBe(2);
    expect(result.status).toBe("PARTIAL"); // step budget exhausted, not intents
    expect(result.finalReport.metrics.totalToolCalls).toBe(2);
  });

  it("hands tools a run-scoped lease, not a fabricated test lease", async () => {
    const seenTags: string[] = [];
    const leasingTool: ToolDefinition<{ x: number }> = {
      ...echoTool,
      handle: "leash",
      invoke: async (_args, lease) => {
        seenTags.push(lease.tag);
        return {
          toolCallId: "call-leash",
          name: "leash",
          success: true,
          output: "ok",
          trustLevel: "unverified",
          executionTimeMs: 1,
        };
      },
    };
    const catalogue = new ToolkitCatalogue(noopSink).place(leasingTool);
    const brain = createScriptedBrain(
      loopThenSeal(() =>
        assistantTurn({
          content: "calling",
          finishTag: "tool_calls",
          toolCalls: [{ id: "c1", name: "leash", arguments: { x: 1 } }],
        }),
      ),
    );
    const runner = new AgentRunner(brain, catalogue, makeContext(), {
      adminCharter: "You are a test agent.",
      budgets: { maxCogStepN: 2 },
    });

    await runner.run("Check the lease");

    expect(seenTags.length).toBeGreaterThan(0);
    for (const tag of seenTags) {
      expect(tag).toMatch(/^run:[0-9a-f-]{36}$/); // run-scoped, not "test-scratch"
    }
  });

  it("step exhaustion throws CognitiveOverloadError (no longer dead code)", async () => {
    const brain = createScriptedBrain(
      loopThenSeal(() =>
        assistantTurn({ content: "drifting", finishTag: "tool_calls", toolCalls: [] }),
      ),
    );
    const runner = makeRunner(brain, { budgets: { maxCogStepN: 2 } });

    const result = await runner.run("Drift past the step budget");

    // The run terminates PARTIAL and the seal prompt carries the
    // budget-exhaustion context surfaced by the now-reachable overload error.
    expect(result.status).toBe("PARTIAL");
    const sealPrompt =
      brain.calls[brain.calls.length - 1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(sealPrompt).toMatch(/step budget|CognitiveOverload|exhaust/i);
  });
});
