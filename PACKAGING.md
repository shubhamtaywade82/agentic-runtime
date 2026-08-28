# @nemesis-oss/agentic-runtime — Packaging Specification

This document defines the public API surface, versioning policy, and compatibility guarantees for `@nemesis-oss/agentic-runtime` v0.1.x.

---

## 1. Export Map (Locked Contract)

The package uses ESM-only conditional exports. Consumers **must** import via the mapped subpaths — deep imports from `dist/` are not supported and will break on minor version bumps.

| Subpath | Entrypoint | Re-exports | Stability |
|---------|------------|------------|-----------|
| `.` | `dist/index.js` | All public symbols from all layers | Public |
| `./core` | `dist/core/index.js` | Error taxonomy, types, contracts, schemas, structural `Contract<T>` alias | Public |
| `./brain` | `dist/brain/index.js` | `OllamaThoughtProcess`, `ThoughtProcess`, `createOllamaThoughtProcess`, `ChatMsg`, `RequestSchedule`, `AssistantTurn`, `TurnUsage` | Public |
| `./hands` | `dist/hands/index.js` | `ToolkitCatalogue`, `ToolDispatcher`, `Tool`, `SandboxLease`, `ForwardResult`, `createTestLease`, `createCertifiedEnvelope`, `SMART_LIMIT_BYTES`, `HARD_TOOL_CEILING_MS`, `toJsonSchema` | Public |
| `./memory` | `dist/memory/index.js` | `ContextManager`, `ContextManagerConfig`, `DigestionPipeline`, `createDefaultDigestionPipeline`, `DEFAULT_COMPACTION_THRESHOLD` | Public |
| `./loop` | `dist/loop/index.js` | `AgentRunner`, `RunBudgets`, `RunResult`, `RunStatus`, `RepeatCallBinder`, `RepeatCallBinderConfig`, `createAgentRunner`, `createRepeatCallBinder`, `DEFAULT_RUN_BUDGETS`, `DEFAULT_REPEAT_CALL_BINDER_CONFIG` | Public |
| `./dispute` | `dist/dispute/index.js` | *(Internal — no public re-exports yet)* | Internal |
| `./sentinel` | `dist/sentinel/index.js` | `ConcurrencyGate`, `GateAbortedError`, `ResourceSentinel`, `Priority` | Public |
| `./observability` | `dist/observability/index.js` | *(Internal — `EventSink` only)* | Public |
| `./synthesis` | `dist/synthesis/index.js` | *(Internal — no public re-exports yet)* | Internal |

**Invariant:** Any symbol not listed above is **not** part of the public API and may change without a major version bump.

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
| `^0.1.0` (optional) | The `OllamaThoughtProcess` adapter targets the v0.1.x SDK surface (`OllamaClient` constructor, `chat()` response shape). Declared as `peerDependenciesMeta.optional: true` so the runtime can be used in environments that provide their own `ThoughtProcess` implementation without the SDK installed. |

**Migration note:** When SDK v0.2.0 releases, the runtime will publish a matching minor (e.g., `0.2.0`) with an updated adapter. The adapter is isolated to `src/brain/adapter.ts` — no other module depends on SDK internals.

---

## 3. Compatibility Matrix

| Runtime Version | Compatible SDK | Compatible Zod | Node Engine |
|-----------------|----------------|----------------|-------------|
| `0.1.x` | `@nemesis-oss/ollama-sdk@^0.1.0` | `zod@^3.24` | `>=20` |
| `0.2.x` (planned) | `@nemesis-oss/ollama-sdk@^0.2.0` | `zod@^3.24` | `>=20` |

**Policy:** The runtime minor version tracks the SDK minor version. Zod major version is locked to `3.x` for the lifetime of the `0.x` line. A Zod `4.0.0` release will trigger a runtime `1.0.0` with a new structural alias strategy.

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

## 5. v0.1 Freeze Checklist (Release Gate)

All items must be ✅ before `v0.1.0` tag.

### Architecture & Correctness
- [x] D1–D5 resolved (Brain truncation, findLast, ns→ms, abort race, effects/idempotencyKey)
- [x] D6 resolved (Synthesis constraint/mount exclusivity enforced in adapter)
- [x] D7–D8 resolved (Synthesis `JSON.parse` wrapped, bounded corrective reseal)
- [x] D9 resolved (Threat-class scan: `FENCE_ESCAPE` hard throw, `DIRECTIVE_SUSPECT` → human gate)
- [x] D10 resolved (Evidence closure rejects `supersededBy`, `FinalReportSchema.superRefine` invariants)
- [x] D11 resolved (Gate abort cleanup by referential identity)
- [x] D12 resolved (Slot refund on aborted grant, pre-abort fast-path, idempotent release)
- [x] D13 resolved (Per-model `brainGate(modelId)`, memoized)
- [x] D14 resolved (`resourceClass` on `Tool`, routing in `forwardIntent`, external-network ungated)
- [x] `ResolutionPlan` discriminated union locked in `core/types.ts`
- [x] S5, S6, S7 scenario tests passing

### API Surface
- [x] Export map matches §1 exactly
- [x] All public symbols tagged `@public` (API Extractor clean)
- [x] No `@internal` symbols leaked in `.d.ts` rollups
- [x] `zod` peer declared, not bundled; `@nemesis-oss/ollama-sdk` optional peer

### Build & CI
- [x] `pnpm lint` clean (ESLint + boundaries)
- [x] `pnpm build` clean (tsup + api-extractor, `etc/agentic-runtime.api.md` committed)
- [x] `pnpm test` passes (unit + fixture replay)
- [x] CI matrix: Node 20/22 × Zod 3.22/3.24 (dual-Zod leg)
- [x] Smoke test script wired (`OLLAMA_SMOKE=1`)

### Documentation
- [x] `PACKAGING.md` (this file) committed
- [x] `README.md` with quickstart
- [x] `CHANGELOG.md` with v0.1.0 entries
- [ ] `API.md` generated from API Extractor (post-publish)

### Release Mechanics
- [ ] Tag `v0.1.0` on `main`
- [ ] `pnpm publish --access public`
- [ ] GitHub Release with changelog
- [ ] Update SDK compatibility matrix in SDK repo README

---

## 6. Installation & Usage (Consumer Quickstart)

```bash
# Peer deps must be installed by consumer
pnpm add zod@^3.24 @nemesis-oss/ollama-sdk@^0.1.0 @nemesis-oss/agentic-runtime@^0.1.0
```

```typescript
import { createAgentRunner, createOllamaThoughtProcess, createStandardCatalogue } from "@nemesis-oss/agentic-runtime";
import { OllamaClient } from "@nemesis-oss/ollama-sdk";

// 1. Brain adapter
const brain = createOllamaThoughtProcess("http://localhost:11434", "qwen3:8b");

// 2. Tool catalogue (consumer defines tools)
const catalogue = createStandardCatalogue({ emit: (name, payload) => console.log(name, payload) });
// catalogue.place(myCustomTool);

// 3. Context manager
// ... create ContextManager with digestion pipeline ...

// 4. Run
const runner = createAgentRunner(brain, catalogue, contextManager, {
  adminCharter: "You are an autonomous research agent...",
  budgets: { maxCogStepN: 15, wallTimeCeilMs: 300_000 },
});

const result = await runner.run("Investigate the cause of the latency spike in the payments service.");
console.log(result.finalReport);
```

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