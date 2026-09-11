# Known Limitations (v0.2.0)

This document catalogs the deliberate engineering trade-offs and known limitations in `v0.2.0`. These are not bugs — they are documented boundaries where the architecture has not yet been extended. Each item has a tracked migration path for `v0.3+`.

**Addressed in v0.2.0:** the v0.1 items that shipped in this release are
marked below. The capability layer (§1 context), progressive discovery,
per-step capability selection and the policy/approval boundary are now
stable; MCP tools, resources and prompts are first-class governed
capabilities with Sentinel routing and human approval gating.

---

## 0. MCP Client Surface (New in v0.2)

**Scope:** The in-repo MCP client implements the client side of MCP over stdio and streamable HTTP: initialize handshake with protocol negotiation, tools/list+call, resources/list+read, prompts/list+get, cancellation, and the session header convention.

**Not yet implemented (deliberate):** server→client capabilities — sampling
(`sampling/createMessage`), elicitation (`elicitation/create`), roots
(`roots/list`) are declined with `-32601` (fail-honest rather than
pretending). Long-lived server-initiated GET streams, resource
subscription/`subscribe`, `notifications/message` logging streaming, and
`structuredContent` round-tripping into tool schemas are also out of scope.

**Impact:** MCP servers that *require* client-side LLM sampling or interactive
elicitation cannot run against this client yet; ordinary tool/resource/prompt
servers (the overwhelming majority, including all seven official reference
servers) work today.

**Migration (v0.3):** implement sampling with a `SamplingBrain` seam (routing
through the existing ModelRouter), elicitation on top of the ApprovalProvider
boundary, and roots via a workspace declaration on `McpServerConfig`.

---

## 1. Plurality Layer Deferred

**Scope:** The multi-agent orchestration primitives (`DIVIDE_SERVICE`, `FORUM_PLANNING`, `DEPTH_FUNNEL`, persona bench, `TRUCE_NEGOTIATION`) are excluded from the stable `v0.1` export map.

**Rationale:** The dispute lattice (`DisputeResolver` Tier 1–4) carries deterministic offline test coverage for the full escalation matrix (`test/unit/resolver.test.ts`, scenarios S1–S8: oracle resolution, majority recompute, judge arbitration, human-gate approval/rejection/timeout, ledger append-only invariants, and abort propagation). The higher-order composition patterns remain partially serialized and lack the fuzz/property test coverage required for the stability guarantee.

**Impact:** Consumers requiring fan-out swarms must either implement custom orchestration atop `AgentRunner` or import from `./experimental` (no semver guarantees).

**Migration (v0.2):** Promote `AgentSpec` / `AgentRegistry` to stable exports; add fuzz tests for `DIVIDE_SERVICE` fan-out ordering; add `TRUCE_NEGOTIATION` deadlock scenarios to the test matrix.

---

## 2. GPU Concurrency: Per-Model Gates Only

**Scope:** The `ResourceSentinel` creates per-model `brainGate(modelId)` gates but does **not** enforce a secondary global ceiling for SM (Streaming Multiprocessor) contention across distinct models.

**Rationale:** Ollama's scheduler multiplexes multiple loaded models onto the same physical GPU. Two gates (e.g., `brain:qwen3:8b` + `brain:llama3:70b`) can both acquire permits simultaneously, exceeding physical SM capacity.

**Impact:** On consumer GPUs (< 24GB VRAM), running a Qwen worker fleet and a Llama judge simultaneously may trigger OOM kills or severe latency regression not reflected in `runtime_gate_wait_ms`.

**Mitigation:** Set `maxParallelInferences: 1` globally; run heavy models sequentially.

**Migration (v0.2):** Add a global `smCeiling` semaphore that all model gates must acquire *in addition to* their per-model gate; expose `OLLAMA_NUM_PARALLEL` parsing to auto-calibrate.

---

## 3. Streaming Ingestion Deferred

**Scope:** The `OllamaThoughtProcess` adapter uses `stream: false` exclusively. Token-by-token streaming into the agent loop is unsupported.

**Rationale:** Streaming requires a backpressure-aware `ReadableStream` consumer inside the `AgentRunner` loop, with explicit handling for partial tool-call JSON fragments. This interacts non-trivially with the `RepeatCallBinder` and `ContextManager` compaction triggers.

**Impact:** Long single-turn generations (e.g., 8k token code generation) block the event loop for the full duration; no progressive UI updates possible.

**Migration (v0.2):** Implement `OllamaStreamThoughtProcess` with `ReadableStream` consumer; add `partial_json` recovery for tool calls; add `streaming` budget dimension to `RunBudgets`.

---

## 4. Context Compaction Quality Unvalidated

**Scope:** The `ContextManager` triggers summarization at 85% token pressure using the same LLM (zero temperature, no tools). The *semantic fidelity* of these digests is currently unmeasured.

**Rationale:** Summarization quality is a function of the specific LLM used. A `qwen3:8b` summarizer may drop critical entities that a `llama3:70b` would preserve.

**Impact:** Long-running agents (`maxCogStepN > 20`) may lose causal chain fidelity in early turns, leading to `DisputeResolver` quarantines or hallucinated `evidenceRef` citations.

**Migration (v0.2):** Build a compaction-quality eval harness: seed a golden `ContextManager` lane with known facts; run digestion cycles; assert fact retrieval accuracy via a separate judge LLM. Expose `compactionQualityThreshold` config.

---

## 5. GPU Tool Routing: Fail-Closed Stub

**Scope:** The `ToolkitCatalogue` enforces `targetModelId` for `gpu-inference` tools at registration but routes them through `brainGate(targetModelId)` with hardcoded parallelism. There is **no** embedding-model-specific pooling or batching.

**Rationale:** Local embedding inference (e.g., `nomic-embed-text`) has different latency/throughput profiles than generative models. The current gate treats them identically.

**Impact:** High-throughput embedding workloads (e.g., RAG ingestion) will serialize behind the generative model's `maxParallelInferences`, wasting throughput.

**Migration (v0.2):** Add `EmbeddingPool` gate type with batch-aware acquisition; auto-route `resourceClass: "embedding"` tools to it.

---

## 6. OTel Backend Adapters Absent

**Scope:** The `Observability Bus` emits a canonical `RuntimeEventEnvelopeSchema` but ships **no** OpenTelemetry exporter. Consumers must implement their own `EventSink` adapter.

**Rationale:** OTel SDK dependencies are heavy and version-sensitive. Bundling them would violate the zero-dependency (beyond `zod`) runtime philosophy.

**Impact:** Operators must write ~50 lines of boilerplate to connect to Prometheus/Grafana/Datadog.

**Migration (v0.2):** Publish optional `@nemesis-oss/agentic-runtime-otel` peer package with `NodeSDK` integration; add `metrics.ts` constant exports for metric names to prevent drift.

---

## 7. Post-1.0 Package Split: `agentic-runtime-ollama`

**Scope:** The `OllamaThoughtProcess` adapter lives in the main package but depends on `@nemesis-oss/ollama-sdk` as an optional peer.

**Rationale:** The kernel claims model-agnosticism (the entire Thread 1 rationale). Bundling the Ollama adapter in the main package contradicts this thesis and forces consumers using other SDKs (e.g., `vllm`, `tgi`, `openai`) to tree-shake or ignore the adapter.

**Migration (v1.0):**
1. Move `src/brain/adapter.ts` → new package `@nemesis-oss/agentic-runtime-ollama`
2. Main package exports only `ThoughtProcess` interface and `createRuntime(config: { brain: ThoughtProcess })`
3. Consumer installs: `pnpm add @nemesis-oss/agentic-runtime @nemesis-oss/agentic-runtime-ollama`

---

## 8. `ContextManager` Compaction Uses Same LLM

**Scope:** The `DigestionPipeline` created by `createDefaultDigestionPipeline` uses the *same* `ThoughtProcess` (and thus same model) for summarization as the main agent loop.

**Rationale:** Cost optimization — no second model required.

**Impact:** A model that is good at reasoning may be poor at summarization (and vice versa). The `digestStyleHint` is the only control knob.

**Migration (v0.2):** Allow `ContextManagerConfig` to accept a separate `summarizerBrain: ThoughtProcess`; default to main brain for backward compatibility.

---

## 9. `RepeatCallBinder` Key Normalization Only Sorts Keys

**Scope:** The `RepeatCallBinder.computeSignature` sorts argument keys alphabetically but does not normalize values (e.g., whitespace, case, semantic equivalence of `"1"` vs `1`).

**Rationale:** Deep semantic normalization requires domain knowledge per tool.

**Impact:** `search(query: "foo")` followed by `search(query: "foo ")` are treated as distinct calls, bypassing the governance nudge.

**Migration (v0.2):** Add optional `normalizer: (args: Record<string, unknown>) => string` to `RepeatCallBinderConfig`; ship built-in normalizers for common types (trim strings, coerce numbers, sort arrays).

---

## 10. Judge Model Diversity Advisory Only

**Scope:** The `DisputeResolver` accepts a single `ThoughtProcess` for Tier 3 arbitration. The mitigation for correlated error (require model-family diversity in worker pools) is documented but not enforced.

**Rationale:** Enforcing diversity requires the consumer to provision multiple distinct model aliases and wire them into the resolver — a deployment topology concern.

**Impact:** A 3-worker plurality among three `llama3.1:8b` instances is ~one opinion sampled thrice. The `NegotiationLedger` oscillation detection is the only guard.

**Migration (v0.2):** Add `JudgePool` type accepting `ThoughtProcess[]`; implement round-robin or diversity-aware selection; add `diversityRequired: boolean` config.

---

## 11. No Built-in Checkpointing / Crash Recovery

**Scope:** The `ContextManager` and `ExecutionLedger` are purely in-memory. A process crash (OOM, SIGKILL, power loss) loses the entire run state.

**Rationale:** Checkpointing requires a durable backend (Redis, PostgreSQL, file system) and a serialization format for the `ContextManager` lane and `ExecutionLedger`. This is a host-application concern.

**Impact:** Long-running agents (`wallTimeCeilMs > 10min`) have no resilience to infrastructure failures.

**Migration (v0.2):** Define `CheckpointStore` interface; add `AgentRunnerConfig.checkpointIntervalMs`; ship `RedisCheckpointStore` implementation.

---

## 12. No Structured Output Streaming / Partial Results

**Scope:** The `SynthesisEngine.seal()` produces a monolithic `FinalReport`. There is no mechanism to stream partial findings or emit intermediate `Finding` objects during a long run.

**Rationale:** The seal contract requires evidence closure (all `evidenceRef` IDs must exist in the ledger). Streaming partial findings before closure would violate the seal invariant.

**Impact:** Operators cannot monitor finding accumulation in real-time; only the final sealed artifact is visible.

**Migration (v0.2):** Add `SynthesisEngine.streamSeal()` returning `AsyncIterable<Finding>` that yields findings as they pass closure checks, with a final `FinalReport` envelope.

---

## 13. No Sandbox Isolation for `local-sandbox` Tools

**Scope:** `resourceClass: "local-sandbox"` tools execute in the same Node.js process with full filesystem/network access. The runtime does not spawn containers, WASM runtimes, or use `vm2`/`isolated-vm`.

**Rationale:** True sandboxing adds significant complexity (container orchestration, WASM compilation) and latency. The `effects: "transactional"` + `idempotencyKey` contract is the documented mitigation.

**Impact:** A compromised or buggy `local-sandbox` tool can read/write arbitrary host files, spawn subprocesses, or access host network.

**Migration (v0.2):** Add optional `SandboxProvider` interface to `ResourceSentinel`; ship `DockerSandboxProvider` and `WasmerSandboxProvider` implementations; `ToolDefinition` gets optional `sandboxProfile: "none" | "docker" | "wasm"`.

---

## 14. No Multi-Tenancy / Run Isolation

**Scope:** The `ResourceSentinel` gates are global singletons. Running multiple independent `AgentRunner` instances in the same process shares all gates and the `Observability` sink.

**Rationale:** Multi-tenancy requires namespaced gates, per-run `runId` propagation through all events, and sink scoping.

**Impact:** Cannot run a multi-tenant SaaS (multiple customers) in a single Node.js process without cross-talk on GPU concurrency and metric pollution.

**Migration (v0.2):** Add `TenantContext` to `AgentRunnerConfig`; namespace all gates and sink emissions by `tenantId`; add `ResourceSentinel.forTenant(tenantId)`.

---

## 15. Single-Process Only / No Distributed Execution

**Scope:** The runtime assumes a single Node.js process. It does not support distributing the `AgentRunner` loop, `ToolkitCatalogue`, or `DisputeResolver` across multiple machines.

**Rationale:** Distributed execution requires a message bus (NATS, Kafka, Redis Streams), serialized `ThoughtProcess` calls, and distributed locking for gates.

**Impact:** Cannot scale a single massive fan-out (`DIVIDE_SERVICE` with 1000 workers) beyond a single machine's GPU/CPU.

**Migration (v0.3+):** Define `DistributedRuntime` interface; introduce `MessageBus` abstraction; implement `DistributedAgentRunner` with leader election for the orchestrator loop.

---

## 16. Lifecycle Events Not Mapped to Canonical Metric Names

**Scope:** The sentinel gate and hands layers emit the canonical metric names from `observability/metrics.ts` (`GATE_METRICS.*`, `TOOL_METRICS.*`) with canonical label keys. The dispute and synthesis layers, however, emit lifecycle events under `domain:event` names (`dispute:plan`, `dispute:escalated`, `seal:attempt`, `seal:sealed`, `seal:degraded`) that have no counterpart emission under `DISPUTE_METRICS.*` / `SYNTHESIS_METRICS.*`.

**Rationale:** Those layers were implemented after the metric contract froze their counter names; their events carry full structured payloads (plans, violation lists) that do not decompose cleanly into counter increments without a dual-emission convention.

**Impact:** Operators aggregating `runtime_disputes_total` / `runtime_seals_total` from the sink see zero traffic today; the dispute/seal signals live only on the lifecycle event names.

**Migration (v0.2):** Emit canonical counter samples (`DISPUTE_METRICS.TOTAL`, `SYNTHESIS_METRICS.SEALS_TOTAL` / `VIOLATIONS_TOTAL`) alongside the lifecycle events, and document the dual-emission convention in `metrics.ts`.

---

## 17. Golden Fixture Is Synthetic, Not a Live Capture

**Scope:** `test/fixtures/chat-response.sample.json` is a hand-authored, SDK-shaped `ChatResponse` sample (marked `_provenance`). It is schema-faithful but was never captured from a live Ollama daemon.

**Rationale:** Fixture capture requires a running daemon with the exact model (`qwen3:8b`) provisioned — unavailable in CI and offline environments.

**Impact:** The fixture validates response parsing (tool-call extraction, ns→ms conversion, finish-tag mapping) but cannot surface daemon-side shape quirks (extra fields, `done_reason` variants, streaming edge cases).

**Mitigation:** `OLLAMA_SMOKE=1 UPDATE_GOLDEN=1 pnpm test:smoke` replaces the fixture with a live capture in one command; the pre-freeze checklist in `PACKAGING.md` tracks this as an open item.

**Migration (v0.1.0 freeze):** Run the capture command against the reference daemon before tagging.

---

## 0b. Capability Scoring Is Lexical, Not Semantic

**Scope:** `CapabilityIndex` ranking (and therefore `TopKCapabilitySelector`) uses deterministic token/prefix overlap scoring. There are no embeddings, no LLM calls, and no relevance learning.

**Rationale:** Progressive discovery must stay cheap, offline, replayable in tests and free of cold-start dependencies — the selector runs every step.

**Impact:** Discovery quality degrades when tool descriptions are terse or use different vocabulary than the objective (e.g. "find the bug" will not rank a tool described as "triage stack traces"). The escape hatch is explicit `discoverability.keywords` on the ToolDefinition, which rank at weight 2 (above descriptions).

**Migration (v0.3):** optional pluggable `CapabilityScorer` interface; an embedding-based implementation can run behind the existing `gpu-inference` Sentinel class.

---

## 0c. MCP Server Trust and Side Effects Are Operator-Declared

**Scope:** `McpServerConfig.trust` and `McpServerConfig.sideEffects` are declarations supplied by the operator at registration time. Tool annotations (`readOnlyHint`, `destructiveHint`) are server-authored hints, not verified guarantees.

**Rationale:** The protocol provides no cryptographic server identity or effect attestation; a malicious server can misreport annotations.

**Impact:** Policy quality is bounded by declaration honesty. The conservative defaults (`trust: "unknown"` → approval required; conservative side-effect declaration → `external-network` routing) mean misconfigured servers fail *toward* more gating, not less.

**Mitigation:** Pin commands/URLs explicitly, prefer `verified`/`official` trust only for servers you control or vetted reference servers, and keep destructive operations behind `manual` grant levels.

**Migration (v0.3):** allow-listed server manifests (hash-pinned commands), and a policy hook for annotation skepticism (requiring approval whenever annotations claim read-only from an untrusted server).

---

---

**End of Known Limitations.**

*This document is a living artifact. Items promoted to stable features in `v0.3+` will be removed from this list and appear in the `CHANGELOG.md` with migration guides.*