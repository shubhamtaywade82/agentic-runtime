# @nemesis-oss/agentic-runtime

A deterministic, production-grade autonomous AI agent runtime built on `@nemesis-oss/ollama-sdk`. Implements the four architectural pillars (Brain, Hands, Memory, Loop) with hardware-aware concurrency, dispute resolution, and terminal report sealing.

## Status

**v0.1.x** — Early release. Public API surface locked per [PACKAGING.md](./PACKAGING.md). SemVer guarantees apply.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      AGENTIC RUNTIME                        │
│                                                             │
│  ┌──────────┐      ┌──────────┐      ┌────────────────┐    │
│  │  BRAIN   │◄────►│  HANDS   │◄────►│    MEMORY      │    │
│  │(Inference)│      │(Tools)   │      │(Context/State) │    │
│  └────┬─────┘      └────┬─────┘      └───────┬────────┘    │
│       │                 │                     │             │
│       └─────────────────┼─────────────────────┘             │
│                         ▼                                   │
│              ┌─────────────────────┐                        │
│              │     AGENT LOOP      │                        │
│              │  (Think→Act→Eval)   │                        │
│              └──────────┬──────────┘                        │
│                         │                                   │
│         ┌───────────────┼───────────────┐                   │
│         ▼               ▼               ▼                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │  SENTINEL  │  │  OBSERVABILITY│  │  DISPUTE   │            │
│  │ (GPU Gate) │  │  (Metrics)  │  │  RESOLUTION│            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                                                             │
│                         ▼                                   │
│              ┌─────────────────────┐                        │
│              │    SYNTHESIS        │                        │
│              │ (Terminal Report)   │                        │
│              └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
# Required peers
pnpm add zod@^3.24 @nemesis-oss/ollama-sdk@^0.1.0

# Runtime
pnpm add @nemesis-oss/agentic-runtime@^0.1.0
```

**Node:** `>=20` (ESM only)

## Quickstart

```typescript
import {
  createAgentRunner,
  createOllamaThoughtProcess,
  createStandardCatalogue,
  createDefaultDigestionPipeline,
} from "@nemesis-oss/agentic-runtime";
import { OllamaClient } from "@nemesis-oss/ollama-sdk";

// 1. Brain — Ollama adapter
const brain = createOllamaThoughtProcess(
  "http://localhost:11434",  // Ollama base URL
  "qwen3:8b"                  // Model alias
);

// 2. Hands — Tool catalogue (define your tools)
const catalogue = createStandardCatalogue({
  emit: (name, payload) => console.log(`[tool:${name}]`, payload),
});

// 3. Memory — Context manager with digestion
const digestionPipeline = createDefaultDigestionPipeline(brain, {
  mounting: { manifests: [] },
  constrain: undefined,
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
  digestionPipeline
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
  "Investigate the latency spike in the payments service between 14:00-15:00 UTC."
);

console.log("Status:", result.status);
console.log("Report:", result.finalReport?.executiveSummary);
```

## Core Concepts

### Brain (`@nemesis-oss/agentic-runtime/brain`)
- `OllamaThoughtProcess` — Adapter for `@nemesis-oss/ollama-sdk`
- Handles `length_truncated` detection, `findLast` message extraction, nanosecond→ms conversion
- Grammar-constrained decoding **only when no tools mounted** (prevents tool-calling collapse)

### Hands (`@nemesis-oss/agentic-runtime/hands`)
- `ToolkitCatalogue` — Tool registry with Zod strict validation
- `ToolDispatcher` — Executes intents with timeout, abort, output fencing
- `<result_trust_level="untrusted-data">` fencing prevents prompt injection via tool output
- `resourceClass` classification routes GPU vs sandbox vs network tools to correct concurrency gate

### Memory (`@nemesis-oss/agentic-runtime/memory`)
- `ContextManager` — Sliding window with summarization (85% threshold)
- Pinned charter lines survive all digestion cycles
- `formatForSynthesis()` emits only verified receipts for terminal sealing

### Loop (`@nemesis-oss/agentic-runtime/loop`)
- `AgentRunner` — ReAct loop with budgets (`maxCogStepN`, `wallTimeCeilMs`, `hardIntentCount`)
- `RepeatCallBinder` — Detects consecutive identical tool calls, injects governance nudge
- Salvage path produces `PARTIAL` report on budget exhaustion

### Sentinel (`@nemesis-oss/agentic-runtime/sentinel`)
- `ConcurrencyGate` — Priority semaphore (`critical` for orchestrator, `normal` for workers)
- `ResourceSentinel` — Per-model `brainGate`, classified `handsGate` (`gpu-inference` | `local-sandbox` | `external-network`)
- Abort cleanup by referential identity (no silent slot leaks)

### Dispute (`@nemesis-oss/agentic-runtime/dispute`)
- Four-tier resolver: Oracle (numeric tolerance) → Recompute (narrow scope) → Judge (schema-constrained LLM) → Human Gate
- `NegotiationLedger` detects period-2 verdict oscillation
- `ResolutionPlan` discriminated union: `ADOPT` | `RECOMPUTE` | `QUARANTINE` | `HUMAN_GATE`

### Synthesis (`@nemesis-oss/agentic-runtime/synthesis`)
- `SynthesisEngine.seal()` — No-tools guarantee, grammar-constrained `FinalReportSchema`
- Evidence closure: every finding must cite a valid, non-superseded receipt
- Imperative breakout scan: structural (`FENCE_ESCAPE`) vs lexical (`DIRECTIVE_SUSPECT`)

## Observability

All modules emit to a shared `EventSink` with a canonical envelope:

```typescript
interface RuntimeEvent {
  v: 1;
  runId: string;
  seq: number;
  tsMs: number;
  agentPath: string; // "orchestrator>fanout#worker-3"
  // ... typed payload per source
}
```

**Key metrics:**
- `runtime_gate_wait_ms` / `runtime_gate_active` — GPU queue health
- `runtime_inference_ms` / `runtime_tokens_*` — LLM latency & cost
- `runtime_tool_ms` / `runtime_tool_failures_total` — Tool reliability
- `runtime_run_status_total` — ACHIEVED / PARTIAL / CEDED / FAILED
- `runtime_seals_total` — Terminal report production

## Configuration

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_SMOKE` | `0` | Enable integration tests against live Ollama |

### Programmatic Budgets
```typescript
const runner = createAgentRunner(brain, catalogue, ctx, {
  budgets: {
    maxCogStepN: 15,        // LLM turns
    wallTimeCeilMs: 300_000, // 5 minutes
    hardIntentCount: 20,    // Tool calls
    maxTokensPerStep: 8000, // Per-LLM-call ceiling
  },
});
```

## Testing

```bash
# Unit tests (fixture replay)
pnpm test

# Smoke tests (requires live Ollama + OLLAMA_SMOKE=1)
pnpm test:smoke
```

## License

MIT — see [LICENSE](./LICENSE)