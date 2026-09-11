/**
 * Basic quickstart - COMPILE-TESTED against the packed tarball by
 * `pnpm verify:package`. Running it requires a live Ollama daemon.
 *
 * This file mirrors the README quickstart verbatim on purpose: if the
 * README drifts, this example stops compiling and CI fails.
 */
import {
  ContextManager,
  createAgentRunner,
  createOllamaThoughtProcess,
  createStandardCatalogue,
  createDefaultDigestionPipeline,
} from "@nemesis-oss/agentic-runtime";

// 1. Brain — Ollama adapter
const brain = createOllamaThoughtProcess(
  "http://localhost:11434", // Ollama base URL
  "qwen3:8b", // Model alias
);

// 2. Hands — Tool catalogue (define your tools)
const catalogue = createStandardCatalogue({
  emit: (name, payload) => console.log(`[tool:${name}]`, payload),
});

// 3. Memory — Context manager with digestion
const digestionPipeline = createDefaultDigestionPipeline(brain, {
  mounting: { manifests: [] },
  idleLiveSeconds: 1800,
  entropyOverride: 0.1,
  upperBoundTokenCount: 8000,
  killSwitch: new AbortController().signal,
});

const contextManager = new ContextManager(
  {
    modelCapacityTokenCeiling: 8192,
    reserveFreshTailCount: 10,
    digestStyleHint: "Summarize tool observations concisely.",
  },
  digestionPipeline,
);

// 4. Run the agent
const runner = createAgentRunner(brain, catalogue, contextManager, {
  adminCharter: `You are an autonomous research agent.
Objective: Investigate the root cause of production incidents.
Available tools: search, read, fetch.
Always cite evidence.`,
  budgets: { maxCogStepN: 15, wallTimeCeilMs: 300_000 },
});

const result = await runner.run(
  "Investigate the latency spike in the payments service between 14:00-15:00 UTC.",
);

console.log("Status:", result.status);
console.log("Report:", result.finalReport?.executiveSummary);
