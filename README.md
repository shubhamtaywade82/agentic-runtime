# @nemesis-oss/agentic-runtime

A model-agnostic TypeScript runtime for reliable, policy-controlled autonomous agents. Implements the four architectural pillars (Brain, Hands, Memory, Loop) with a normalized capability layer (native tools + MCP), hardware-aware concurrency, human approval gates, progressive tool discovery, dispute resolution and terminal report sealing.

## Status

**v0.2.x** — Early release. Public API surface locked per [PACKAGING.md](./PACKAGING.md). SemVer guarantees apply.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      AGENTIC RUNTIME                        │
│                                                             │
│  ┌──────────┐      ┌──────────┐      ┌────────────────┐    │
│  │  BRAIN   │◄────►│  HANDS   │◄────►│    MEMORY      │    │
│  │(Inference)│     │(Tools)   │      │(Context/State) │    │
│  └────┬─────┘      └────┬─────┘      └───────┬────────┘    │
│       │                 │                     │             │
│  Model Router      CAPABILITY LAYER           │             │
│  (local/cloud)   native + MCP + policy        │             │
│       │                 │                     │             │
│       └─────────────────┼─────────────────────┘             │
│                         ▼                                   │
│              ┌─────────────────────┐                        │
│  POLICY ────►│     AGENT LOOP      │◄──── SESSIONS          │
│  (trust +    │  (Think→Act→Eval)   │     (context           │
│  approvals)  └──────────┬──────────┘      continuity)       │
│                         ▼                                   │
│         ┌───────────────┼───────────────┐                   │
│         ▼               ▼               ▼                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │  SENTINEL  │  │ OBSERVABILITY│  │  DISPUTE   │            │
│  │ (GPU Gate) │  │  (Metrics)  │  │ RESOLUTION │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                         ▼                                   │
│              ┌─────────────────────┐                        │
│              │    SYNTHESIS        │                        │
│              │ (Terminal Seal)     │                        │
│              └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
# Required peers
pnpm add zod@^3.24 @nemesis-oss/ollama-sdk@^1.3.0

# Runtime
pnpm add @nemesis-oss/agentic-runtime@^0.2.0
```

**Node:** `>=20` (ESM only). MCP support uses only Node builtins (`child_process`, `fetch`) — no additional dependencies.

## Quickstart (high-level API)

```typescript
import {
  createAgentRuntime,
  createOllamaThoughtProcess,
  createApprovalProvider,
} from "@nemesis-oss/agentic-runtime";
import { z } from "zod";

const runtime = await createAgentRuntime({
  // Brain — any ThoughtProcess; or pass `router` for hybrid local/cloud.
  brain: createOllamaThoughtProcess("http://localhost:11434", "qwen3:8b"),

  // Native tools (Zod contracts, Sentinel-governed).
  tools: [
    {
      handle: "get_weather",
      caption: "Returns the current weather for a city",
      argsShape: z.object({ city: z.string() }),
      resourceClass: "external-network",
      effects: "pure",
      grantLevel: "auto",
      invoke: async (args) => ({
        toolCallId: "call-1",
        name: "get_weather",
        success: true,
        output: JSON.stringify({ city: args.city, temperatureC: 21 }),
        trustLevel: "unverified",
        executionTimeMs: 3,
      }),
    },
  ],

  // Optional: MCP servers — tools are adapted, governed and discovered.
  // mcp: { servers: [{ serverId: "filesystem", transport: "stdio",
  //   command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"],
  //   trust: "verified",
  //   sideEffects: { network: false, filesystem: true, process: false, database: false, externalMutation: false } }] },

  // Optional: human approval gate for acknowledged/manual grant levels.
  approvals: createApprovalProvider(async (request) => {
    console.log("Approval needed:", request.capability.name, request.reason);
    return { approved: true };
  }),
});

const result = await runtime.run("What is the weather in Tokyo?");
console.log(result.status, result.finalReport.executiveSummary);

// Stateful alternative: context continuity across runs + abort support.
const session = runtime.createSession();
await session.run("Remember that the API token is abc123");
const followUp = await session.run("What API token did I mention?");
session.abort(); // only when needed - the active run seals as CEDED

await runtime.close();
```

## Quickstart (low-level kernel API)

```typescript
import {
  ContextManager,
  createAgentRunner,
  createOllamaThoughtProcess,
  createStandardCatalogue,
  createDefaultDigestionPipeline,
} from "@nemesis-oss/agentic-runtime";

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

> `examples/basic` contains this snippet verbatim and is compile-tested against the packed tarball in CI — the README cannot drift.

## Core Concepts

### Brain (`@nemesis-oss/agentic-runtime/brain`)
- `OllamaThoughtProcess` — Adapter for `@nemesis-oss/ollama-sdk`
- Handles `length_truncated` detection, `findLast` message extraction, nanosecond→ms conversion
- Grammar-constrained decoding **only when no tools mounted** (prevents tool-calling collapse)

### Hands (`@nemesis-oss/agentic-runtime/hands`)
- `ToolkitCatalogue` — Tool registry with strict argument validation (Zod or JSON-Schema contracts)
- `ToolDispatcher` — Executes intents with timeout, abort, output fencing
- `<result_trust_level="untrusted-data">` fencing prevents prompt injection via tool output
- `resourceClass` classification routes GPU vs sandbox vs network tools to correct concurrency gate

### Capability (`@nemesis-oss/agentic-runtime/capability`)
- `CapabilityDescriptor` — one normalized description for native tools, MCP tools, resources and prompts
- `CapabilityIndex` — fail-closed registry with a deterministic offline relevance scorer
- `CapabilitySelector` — `Static` (mount all, v0.1 behavior) and `TopK` (progressive discovery for small-context models: the model *sees* top-k; every registered tool stays dispatchable, gated and fenced)
- `CapabilityRouter` — the single registration site: native and adapted tools flow into one governed catalogue

### Policy (`@nemesis-oss/agentic-runtime/policy`)
- `CapabilityPolicy` — deterministic ALLOW / DENY / REQUIRE_APPROVAL decisions, evaluated before every dispatch
- `GrantLevelPolicy` — denylist > allowlist > server-trust floor > grant-level threshold (auto allows; acknowledged+ asks; acknowledged-privileged/manual escalate to privileged scope)
- `ApprovalProvider` — async human-in-the-loop boundary; timeouts and provider failures deny (fail-closed); denials never consume intent budget and surface as `POLICY_DENIED` observations so the model pivots

### MCP (`@nemesis-oss/agentic-runtime/mcp`)
- In-repo MCP client — **zero new dependencies** (stdio child process + streamable HTTP with SSE)
- `McpClient` — initialize handshake with protocol negotiation, capability-gated tools/resources/prompts (paginated), `tools/call`, per-request timeouts, abort with `notifications/cancelled`, automatic `ping` answers, honest `-32601` declines for sampling/elicitation/roots
- `McpServerRegistry` — fail-closed config validation, connection lifecycle, trust/side-effect policy metadata
- Adapter — MCP tools become governed `ToolDefinition`s: Sentinel resource class from declared side effects, grant levels from annotations + trust, `${serverId}__` handle namespacing (collision-proof), strict argument validation with model-facing feedback
- `ProgressiveDiscovery` — connect → adapt → register → select flow

### Memory (`@nemesis-oss/agentic-runtime/memory`)
- `ContextManager` — Sliding window with summarization (85% threshold); `contextPressure()` for routers
- Pinned charter lines survive all digestion cycles
- `formatForSynthesis()` emits only verified receipts for terminal sealing

### Loop (`@nemesis-oss/agentic-runtime/loop`)
- `AgentRunner` — ReAct loop with budgets (`maxCogStepN`, `wallTimeCeilMs`, `hardIntentCount`)
- Optional per-step capability selection, policy gates, and model routing (all backward compatible)
- `RepeatCallBinder` — Detects repeated identical tool calls, injects governance nudge
- Salvage path produces `PARTIAL` report on budget exhaustion

### Router (`@nemesis-oss/agentic-runtime/router`)
- `ModelRouter` — selects the Brain per phase (step/seal/summarize/dispute); routing is deterministic, never calls an LLM
- `DeclarativeModelRouter` — ordered rules (phase, objective match, tool count, context pressure, step index, failure fallback)
- Enables hybrid topologies (e.g. MiniCPM for steps, Gemma for seals) without model-aware adapters; Sentinel brain gates key on the *selected* brain's identity

### Session (`@nemesis-oss/agentic-runtime/session`)
- `createAgentRuntime(config)` — the high-level facade: brain or router, native tools, MCP servers, policy, approvals, budgets, sentinel
- `runtime.run(objective)` — one-shot with fresh context; `runtime.createSession()` — context continuity, per-run budgets, `abort()` seals as CEDED
- Defaults: single-inference sentinel topology, TopK(8) discovery when MCP is configured, trust-aware `GrantLevelPolicy` for MCP tools

### Sentinel (`@nemesis-oss/agentic-runtime/sentinel`)
- `ConcurrencyGate` — Priority semaphore (`critical` for orchestrator, `normal` for workers)
- `ResourceSentinel` — Per-model `brainGate`, classified `handsGate` (`gpu-inference` | `local-sandbox` | `external-network` | `filesystem-read` | `filesystem-write` | `external-database` | ...)
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

All modules emit to a shared `EventSink` with a canonical envelope. Metric groups: `GATE_*`, `INFERENCE_*`, `TOOL_*`, `RUN_*`, `MEMORY_*`, `DISPUTE_*`, `SYNTHESIS_*`, `SINK_*`, `CAPABILITY_*`, `POLICY_*`, `MCP_*` — every name is listed in `ALL_METRIC_NAMES` (`./observability`).

**Key metrics:**
- `runtime_gate_wait_ms` / `runtime_gate_active` — GPU queue health
- `runtime_inference_ms` / `runtime_tokens_*` — LLM latency & cost
- `runtime_tool_ms` / `runtime_tool_failures_total` — Tool reliability
- `runtime_capability_mounted_size` — progressive discovery window per step
- `runtime_policy_decisions_total` / `runtime_policy_approvals_total` — trust boundary activity
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
# Unit tests (fixture replay + in-memory MCP loopback + real stdio/HTTP transports)
pnpm test

# Smoke tests (requires live Ollama + OLLAMA_SMOKE=1)
pnpm test:smoke

# Tarball consumer verification (pack -> install -> compile examples -> run)
pnpm verify:package
```

## License

MIT — see [LICENSE](./LICENSE)
