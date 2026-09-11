/**
 * Custom tools + the high-level runtime API - RUNS OFFLINE with zero
 * infrastructure. `pnpm verify:package` compiles AND executes this example
 * against the packed tarball.
 *
 * The "brain" here is a scripted ThoughtProcess so the demo is
 * deterministic; swap it for createOllamaThoughtProcess() to run against
 * a live model - the runtime contract is identical.
 */
import { z } from "zod";
import {
  createAgentRuntime,
  DEFAULT_AGENT_CHARTER,
} from "@nemesis-oss/agentic-runtime";
import type {
  AssistantTurn,
  ChatMsg,
  RequestSchedule,
  ThoughtProcess,
  ToolResult,
} from "@nemesis-oss/agentic-runtime";

// ---------------------------------------------------------------------------
// 1. A deterministic offline brain (the ThoughtProcess seam)
// ---------------------------------------------------------------------------

/** A valid FinalReport the scripted brain "authors" at seal time. */
const sealReportJson = JSON.stringify({
  status: "ACHIEVED",
  objective: "What is the weather in Tokyo?",
  executiveSummary:
    "The weather tool reported 21 degrees and clear skies over Tokyo. The objective is answered directly from the verified tool receipt.",
  findings: [
    {
      claim: "Tokyo is at 21 degrees with clear skies.",
      evidenceRef: "receipt-0001",
      confidence: 0.95,
    },
  ],
  disputes: [],
  metrics: {
    totalSteps: 2,
    totalToolCalls: 1,
    totalWallTimeMs: 12,
    totalTokensIn: 210,
    totalTokensOut: 64,
    sentinelAcquisitions: 1,
    sentinelRejections: 0,
  },
  seal: {
    timestamp: new Date().toISOString(),
    hash: "",
    runtimeVersion: "0.2.0",
  },
});

/** Scripted inference: tool call first, final answer second, seal on constrain. */
function createScriptedBrain(): ThoughtProcess {
  let step = 0;
  return {
    identityTag: "scripted:demo",
    async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
      // The seal call carries the grammar constraint (No-Tools Guarantee).
      if (schedule.constrain !== undefined) {
        return { content: sealReportJson, toolCalls: [], finishTag: "stop", usage: null };
      }
      step += 1;
      if (step === 1) {
        return {
          content: "I will check the weather.",
          toolCalls: [{ id: "call-1", name: "get_weather", arguments: { city: "Tokyo" } }],
          finishTag: "tool_calls",
          usage: { promptTokens: 120, evalTokens: 24, totalDurationMs: 5, loadDurationMs: 1 },
        };
      }
      return {
        content: "The weather in Tokyo is 21 degrees and clear.",
        toolCalls: [],
        finishTag: "stop",
        usage: { promptTokens: 90, evalTokens: 40, totalDurationMs: 4, loadDurationMs: 1 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 2. A native tool (Zod contract, governed by the Sentinel)
// ---------------------------------------------------------------------------

const getWeather = {
  handle: "get_weather",
  caption: "Returns the current weather for a city",
  argsShape: z.object({ city: z.string().min(1) }),
  resourceClass: "external-network" as const,
  effects: "pure" as const,
  grantLevel: "auto" as const,
  invoke: async (args: { city: string }): Promise<ToolResult> => ({
    toolCallId: "call-1",
    name: "get_weather",
    success: true,
    output: JSON.stringify({ city: args.city, temperatureC: 21, conditions: "clear" }),
    trustLevel: "unverified",
    executionTimeMs: 3,
  }),
};

// ---------------------------------------------------------------------------
// 3. High-level runtime: one object, one call
// ---------------------------------------------------------------------------

const runtime = await createAgentRuntime({
  brain: createScriptedBrain(),
  tools: [getWeather],
  charter: DEFAULT_AGENT_CHARTER,
  budgets: { maxCogStepN: 6, wallTimeCeilMs: 60_000, hardIntentCount: 4 },
  sink: {
    emit: (name, payload) => {
      if (name.startsWith("runtime_tool_") || name.startsWith("runtime_run_")) {
        console.log(`[metric] ${name}`, payload);
      }
    },
  },
});

const result = await runtime.run("What is the weather in Tokyo?");

console.log("status:           ", result.status);
console.log("intents dispatched:", result.intentsDispatched);
console.log("steps:            ", result.steps.length);
console.log("sealed hash:      ", result.finalReport.seal.hash);
console.log("summary:          ", result.finalReport.executiveSummary.slice(0, 80), "...");
console.log("report findings:  ", result.finalReport.findings.length);

await runtime.close();

// Deterministic exit contract: the example IS a test of the packed artifact.
if (result.status !== "ACHIEVED" || result.intentsDispatched !== 1) {
  console.error("Unexpected run outcome.");
  process.exit(1);
}
console.log("\nExample completed successfully.");
