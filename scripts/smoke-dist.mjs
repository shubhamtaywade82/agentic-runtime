/**
 * Smoke test against the BUILT package (dist/) - verifies the compiled
 * ESM output is importable and the terminal sealing chain works end-to-end.
 */
import {
  AgentRunner,
  ContextManager,
  SynthesisEngine,
  DisputeResolver,
  NegotiationLedger,
  ResourceSentinel,
  ToolkitCatalogue,
  FinalReportSchema,
  isGateAbortedError,
  RUNTIME_VERSION,
} from "../dist/index.js";

const noopSink = { emit: () => {} };

const validReportJson = JSON.stringify({
  status: "ACHIEVED",
  objective: "smoke",
  executiveSummary: "A smoke-test summary that is definitely longer than fifty characters total.",
  findings: [],
  disputes: [],
  metrics: {
    totalSteps: 1,
    totalToolCalls: 0,
    totalWallTimeMs: 5,
    totalTokensIn: 0,
    totalTokensOut: 0,
    sentinelAcquisitions: 0,
    sentinelRejections: 0,
  },
  seal: { timestamp: new Date().toISOString(), hash: "", runtimeVersion: RUNTIME_VERSION },
});

let sealCalls = 0;
const brain = {
  identityTag: "smoke:brain",
  async digest(messages, schedule) {
    if (schedule.constrain !== undefined) {
      sealCalls++;
      return {
        content: validReportJson,
        toolCalls: [],
        finishTag: "stop",
        usage: null,
      };
    }
    return { content: "done", toolCalls: [], finishTag: "stop", usage: null };
  },
};

const catalogue = new ToolkitCatalogue(noopSink);
const ctx = new ContextManager(
  {
    modelCapacityTokenCeiling: 1_000_000,
    reserveFreshTailCount: 4,
    digestStyleHint: "concise",
  },
  { summarize: async () => "digest" },
);
const runner = new AgentRunner(brain, catalogue, ctx, { adminCharter: "smoke" });
const result = await runner.run("Smoke test the seal chain");

const checks = [
  ["status ACHIEVED", result.status === "ACHIEVED"],
  ["finalReport non-null", result.finalReport !== null],
  ["report schema-valid", FinalReportSchema.safeParse(result.finalReport).success === true],
  ["seal invoked", sealCalls === 1],
  ["hash content-addressed", /^sha256:[0-9a-f]{64}$/.test(result.finalReport.seal.hash)],
  ["resolver exported", typeof DisputeResolver === "function"],
  ["ledger exported", typeof NegotiationLedger === "function"],
  ["synthesis engine exported", typeof SynthesisEngine === "function"],
  ["structural predicate", isGateAbortedError({ name: "GateAbortedError" }) === false],
  [
    "sentinel aggregateStats",
    typeof new ResourceSentinel(
      { maxParallelTools: 1, maxParallelInferences: 1, maxQueueDepth: 1 },
      noopSink,
    ).aggregateStats === "function",
  ],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
