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

    expect(result.finalReport.metrics.sentinelAcquisitions).toBe(1); // the grant
    expect(result.finalReport.metrics.sentinelRejections).toBe(1); // the saturation
    expect(result.finalReport.metrics.totalSteps).toBe(1);
    expect(result.finalReport.metrics.totalTokensIn).toBe(0);

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
