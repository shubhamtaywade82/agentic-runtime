# @nemesis-oss/agentic-runtime — Packaging Specification

This document defines the public API surface, versioning policy, and compatibility guarantees for `@nemesis-oss/agentic-runtime` v0.2.x.

---

## 1. Export Map (Locked Contract)

The package uses ESM-only conditional exports. Consumers **must** import via the mapped subpaths — deep imports from `dist/` are not supported and will break on minor version bumps.

| Subpath | Entrypoint | Re-exports | Stability |
|---------|------------|------------|-----------|
| `.` | `dist/index.js` | All public symbols from all layers | Public |
| `./core` | `dist/core/index.js` | Error taxonomy, types, contracts, schemas, structural `Contract<T>` alias, `ToolDefinition` (with v0.2 provenance metadata) | Public |
| `./capability` | `dist/capability/index.js` | `CapabilityDescriptor`, `CapabilityKind/Source`, `capabilityId`, `toolToCapability`, `CapabilityIndex`, `scoreCapabilities`, `tokenizeForSearch`, `CapabilitySelector`, `StaticCapabilitySelector`, `TopKCapabilitySelector`, `CapabilityRouter`, `manifestSchemaFor`, `CapabilityManifest`, `CAPABILITY_METRICS` consumers | Public |
| `./policy` | `dist/policy/index.js` | `CapabilityPolicy`, `PolicyDecision`, `PolicyRequest`, `GrantLevelPolicy`, `CompositePolicy`, `AllowAllPolicy`, rank tables, `ApprovalProvider`, `ApprovalRequest/Result`, `createApprovalProvider`, `autoApprove`, `autoDeny`, `requestApprovalWithTimeout`, `ApprovalProviderError`, `ServerTrust` | Public |
| `./mcp` | `dist/mcp/index.js` | JSON-RPC codec, `StdioTransport`, `StreamableHttpTransport`, `anySignal`, `McpClient`, `McpServerRegistry`, `McpServerConfig`, `mcpToolsToToolDefinitions` + mapping helpers, `jsonSchemaContract`, `McpServerRegistry`, `ProgressiveDiscovery`, MCP error taxonomy, `MCP_METRICS` consumers | Public |
| `./router` | `dist/router/index.js` | `ModelRouter`, `ModelSelectionRequest/Phase`, `StaticModelRouter`, `DeclarativeModelRouter`, `RoutingRule` | Public |
| `./session` | `dist/session/index.js` | `createAgentRuntime`, `AgentRuntime`, `AgentSession`, `AgentRuntimeConfig`, `DEFAULT_AGENT_CHARTER`, `DEFAULT_SENTINEL_TOPOLOGY` | Public |
| `./brain` | `dist/brain/index.js` | `OllamaThoughtProcess`, `createOllamaThoughtProcess` (core types `ThoughtProcess`, `ChatMsg`, `RequestSchedule`, `AssistantTurn`, `TurnUsage` are consumed from `./core`) | Public |
| `./hands` | `dist/hands/index.js` | `ToolkitCatalogue`, `ToolDispatcher`, `CertifiedContractEnvelope`, `ForwardResult`, `ToolInvocationError`, `createTestLease`, `createStandardCatalogue`, `createCertifiedEnvelope`, `SMART_LIMIT_BYTES`, `HARD_TOOL_CEILING_MS`, `toJsonSchema` | Public |
| `./memory` | `dist/memory/index.js` | `ContextManager`, `ContextManagerConfig`, `DigestionPipeline`, `createDefaultDigestionPipeline`, `DEFAULT_COMPACTION_THRESHOLD` | Public |
| `./loop` | `dist/loop/index.js` | `AgentRunner`, `RunBudgets`, `RunResult`, `RunStatus`, `RepeatCallBinder`, `RepeatCallBinderConfig`, `createAgentRunner`, `createRepeatCallBinder`, `DEFAULT_RUN_BUDGETS`, `DEFAULT_REPEAT_CALL_BINDER_CONFIG` | Public |
| `./dispute` | `dist/dispute/index.js` | `DisputeResolver`, `DisputeResolverConfig`, `NegotiationLedger`, `ResolutionPlan` shapes, `DisputeResolutionError` (core) | Public |
| `./sentinel` | `dist/sentinel/index.js` | `ConcurrencyGate`, `ResourceSentinel`, `Priority` (`GateAbortedError`/`GateSaturatedError` are consumed from `./core`) | Public |
| `./observability` | `dist/observability/index.js` | The full metric contract: `GATE_METRICS`, `INFERENCE_METRICS`, `TOOL_METRICS`, `RUN_METRICS`, `MEMORY_METRICS`, `DISPUTE_METRICS`, `SYNTHESIS_METRICS`, `SINK_METRICS`, `CAPABILITY_METRICS`, `POLICY_METRICS`, `MCP_METRICS`, label enums/keys, `ALL_METRIC_NAMES`, `RuntimeEventEnvelopeSchema` (`EventSink` is consumed from `./core`) | Public |
| `./synthesis` | `dist/synthesis/index.js` | `SynthesisEngine`, `SealRequest`, `SealMetrics`, `DegradedSealOptions`, `SynthesisSealError`, `RUNTIME_VERSION`, `SEAL_ENTROPY_OVERRIDE`, `MAX_SEAL_ATTEMPTS`, `FENCE_ESCAPE_PATTERN` | Public |

**Invariant:** Any symbol not listed above is **not** part of the public API and may change without a major version bump.

**Note on `./orchestration`:** the multi-agent orchestration primitives remain excluded from the stable export map (see KNOWN_LIMITATIONS §1); import from `src` is unsupported.

---

## 2. Peer-Dependency Strategy

### `zod` (Required Peer)

| Version Constraint | Rationale |
|--------------------|-----------|
| `^3.24` | Runtime uses structural `Contract<T>` alias (`src/core/contracts.ts`) to prevent Zod major-version leakage into public types. Consumers **must** provide exactly one Zod instance. The runtime validates against its own peer `zod` at build time via API Extractor. |

**Anti-pattern to avoid:** Do not bundle `zod` in `dependencies`. The structural alias pattern only works when consumer and runtime share the exact same Zod instance.

### `@nemesis-oss/ollama-sdk` (Optional Peer)

| Version Constraint | Rationale |
|--------------------|-----------|
| `^1.3.0` (optional) | The `OllamaThoughtProcess` adapter targets the SDK 1.x surface: `chat({ signal })` for in-flight kill-switch cancellation and the single-`message` `ChatResponse` shape. Declared as `peerDependenciesMeta.optional: true` so the runtime can be used in environments that provide their own `ThoughtProcess` implementation without the SDK installed. (Historical note: the constraint was previously `^0.1.0`, contradicting the tested dev dependency `^1.3.0` — aligned in the terminal-sealing remediation wave.) |

**Migration note:** The runtime minor version tracks the SDK minor version. The adapter is isolated to `src/brain/adapter.ts` — no other module depends on SDK internals.

---

## 3. Compatibility Matrix

| Runtime Version | Compatible SDK | Compatible Zod | Node Engine | MCP |
|-----------------|----------------|----------------|-------------|-----|
| `0.1.x` | `@nemesis-oss/ollama-sdk@^1.3.0` | `zod@^3.24` | `>=20` | n/a |
| `0.2.x` | `@nemesis-oss/ollama-sdk@^1.3.0` | `zod@^3.24` | `>=20` | Built-in (zero extra deps) |

**Policy:** Zod major version is locked to `3.x` for the lifetime of the `0.x` line. A Zod `4.0.0` release will trigger a runtime `1.0.0` with a new structural alias strategy. MCP support adds **no dependencies** — the client speaks JSON-RPC 2.0 over Node builtins (`child_process` for stdio, `fetch` for streamable HTTP).

---

## 4. SemVer Policy

### Version Format: `MAJOR.MINOR.PATCH`

| Segment | Increment Trigger | Consumer Impact |
|---------|-------------------|-----------------|
| **PATCH** | Bug fixes that don't change public types, new internal-only symbols, performance improvements, documentation | Zero — drop-in replacement |
| **MINOR** | New public symbols (classes, interfaces, functions, enums), new optional parameters with defaults, new schema fields with defaults, new `resourceClass` values, new `ToolEffect` values, new `RunStatus` values | Zero — additive only, no breaking changes |
| **MAJOR** | Removal or signature change of any public symbol, change to `FinalReportSchema` that invalidates existing reports, change to `Contract<T>` structural contract, Zod major version bump, SDK major version bump, removal of any export map entry | Breaking — requires consumer migration |

### Protected Surface (Any change = MAJOR)

- `FinalReportSchema` shape (including `status` enum values)
- `Contract<T>` interface
- Export map entries (adding is MINOR, removing is MAJOR)
- `ToolDefinition` required fields
- `RunStatus` enum values
- `GateAbortedError` class existence

---

## 5. v0.2 Freeze Checklist (Release Gate)

All items must be ✅ before `v0.2.0` tag.

### Architecture & Correctness
- [x] v0.1 terminal-sealing / dispute / sentinel guarantees preserved (all v0.1 tests still pass)
- [x] Capability layer: fail-closed registration, deterministic scoring, selectors never crash the loop (stale ids are skipped)
- [x] Policy gate: evaluated after dedup, before intent budget; denials feed back as structured observations; fail-closed approvals
- [x] MCP: stdio + streamable HTTP transports (spawn race, malformed-frame tolerance, session capture, close timeouts); capability-gated listings; abort propagation as structural AbortError
- [x] Model routing: per-phase selection; sentinel brain gates key on the selected brain; router-aware lazy sealer
- [x] Sessions: context continuity, per-run budgets, abort seals as CEDED; post-digest abort check guarantees aborted runs are never ACHIEVED

### API Surface
- [x] Export map matches §1 exactly (15 public subpaths)
- [x] All public symbols tagged `@public` (API Extractor clean)
- [x] `zod` peer declared, not bundled; `@nemesis-oss/ollama-sdk` optional peer; no new runtime dependencies for MCP

### Build & CI
- [x] `pnpm lint` clean (ESLint + boundaries — new modules under the layering contract)
- [x] `pnpm build` clean (tsup + api-extractor, baseline regenerated for v0.2)
- [x] `pnpm test` passes (232 tests: unit + fixture replay + seeded gate fuzz + MCP loopback/stdio/HTTP)
- [x] `pnpm verify:package` passes in CI (tarball → consumer install → strict example compile → offline example execution → import smoke)

### Documentation
- [x] `PACKAGING.md` (this file) updated for v0.2
- [x] `README.md` with high-level + low-level quickstarts (compile-tested via `examples/basic`)
- [x] `CHANGELOG.md` v0.2.0 entry
- [x] `KNOWN_LIMITATIONS.md` refreshed (v0.2 scope + new MCP boundaries)
- [ ] Golden fixture `test/fixtures/chat-response.sample.json` replaced with a LIVE Ollama capture (requires a daemon: `OLLAMA_SMOKE=1 UPDATE_GOLDEN=1 pnpm test:smoke`)
- [ ] `API.md` generated from API Extractor (post-publish)

### Release Mechanics
- [ ] Tag `v0.2.0` on `main`
- [ ] `pnpm publish --access public` (or npm Trusted Publishing via GitHub Actions OIDC — recommended; eliminates long-lived tokens and provides provenance)
- [ ] GitHub Release with changelog
- [ ] Update SDK compatibility matrix in SDK repo README

---

## 6. Installation & Usage (Consumer Quickstart)

```bash
# Peer deps must be installed by consumer
pnpm add zod@^3.24 @nemesis-oss/ollama-sdk@^1.3.0 @nemesis-oss/agentic-runtime@^0.2.0
```

```typescript
import {
  createAgentRuntime,
  createOllamaThoughtProcess,
  createApprovalProvider,
} from "@nemesis-oss/agentic-runtime";
import { z } from "zod";

const runtime = await createAgentRuntime({
  brain: createOllamaThoughtProcess("http://localhost:11434", "qwen3:8b"),
  tools: [/* native ToolDefinitions (Zod contracts) */],
  mcp: {
    servers: [{
      serverId: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"],
      trust: "verified",
      sideEffects: { network: false, filesystem: true, process: false, database: false, externalMutation: false },
    }],
    limit: 8, // top-k capabilities mounted per run
  },
  approvals: createApprovalProvider(async (request) => ({ approved: true })),
});

const result = await runtime.run("Summarize the workspace.");
console.log(result.status, result.finalReport.executiveSummary);
await runtime.close();
```

Runnable end-to-end examples live in `examples/` (`basic` — README quickstart
verbatim, compile-tested; `custom-tools` — offline-runnable;
`mcp-filesystem` — MCP progressive discovery). `pnpm verify:package`
re-validates all of them against the packed tarball.

---

## 7. Migration Guide Template (For Future MAJOR)

When `1.0.0` ships (Zod 4 / SDK 1.0):

```markdown
# Migration 0.x → 1.0

## Breaking Changes
- `Contract<T>` now uses Zod 4 native type-safety (no structural alias needed)
- `OllamaThoughtProcess` updated for SDK v1.0 `ChatResponse` shape
- `FinalReportSchema.status` enum: `"completed"` → `"ACHIEVED"` (already in 0.1)

## Migration Steps
1. Upgrade `zod` to `^4.0.0`
2. Upgrade `@nemesis-oss/ollama-sdk` to `^1.0.0`
3. Upgrade `@nemesis-oss/agentic-runtime` to `^1.0.0`
4. Remove any manual `assertContract` calls — native Zod 4 works directly
5. Run tests; fix any type errors in tool definitions
```