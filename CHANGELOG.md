# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] 0.2.0 — Capability Layer, MCP, Policy, Model Routing, Sessions

The v0.2 platform wave (branch `feat/v0.2-capability-layer`): the runtime
grows from a native-tool kernel into a model-agnostic, policy-controlled
capability bus. Every addition is backward compatible — v0.1 constructor
signatures and default behaviors are unchanged when the new options are
absent.

### Added

- **Capability layer (`./capability`):** `CapabilityDescriptor` normalizes
  native tools, MCP tools, resources and prompts; `CapabilityIndex` is a
  fail-closed registry with a deterministic offline relevance scorer;
  `CapabilitySelector` replaces the v0.1 "mount all tools" seam
  (`StaticCapabilitySelector` preserves v0.1 behavior, `TopKCapabilitySelector`
  implements progressive discovery for small-context models — the model sees
  top-k while every registered tool stays dispatchable, gated and fenced);
  `CapabilityRouter` is the single registration site into one governed
  catalogue. `ToolDefinition` gained additive optional provenance metadata
  (source, serverId, version, sideEffects, discoverability, permissions).
- **Policy engine (`./policy`):** `CapabilityPolicy` renders deterministic
  ALLOW / DENY / REQUIRE_APPROVAL decisions before every dispatch;
  `GrantLevelPolicy` (denylist > allowlist > server-trust floor > grant-level
  threshold with privileged-scope escalation); `CompositePolicy` fail-closed
  chain; `ApprovalProvider` human-in-the-loop boundary where timeouts,
  provider errors, missing providers and explicit rejections all deny.
  Policy denials consume no intent budget and surface as structured
  `POLICY_DENIED` observations so the model pivots.
- **MCP client (`./mcp`) — zero new dependencies:** JSON-RPC 2.0 codec;
  `StdioTransport` (child process NDJSON with malformed-frame tolerance,
  stderr forwarding, spawn-failure race, grace-then-kill close) and
  `StreamableHttpTransport` (POST JSON/SSE, 202 handling, Mcp-Session-Id
  capture/echo, DELETE close with hard timeout); `McpClient` with protocol
  negotiation, capability-gated paginated tools/resources/prompts, `tools/call`,
  per-request timeout + abort (`notifications/cancelled`), automatic `ping`
  answers and honest `-32601` declines for sampling/elicitation/roots;
  `McpServerRegistry` with fail-closed validation and trust/side-effect
  policy metadata; the tool adapter maps MCP tools into governed
  `ToolDefinition`s (Sentinel resource class from declared side effects, grant
  levels from annotations + trust, `${serverId}__` collision-proof namespacing);
  `ProgressiveDiscovery` orchestration.
- **Model router (`./router`):** `ModelRouter` selects the Brain per phase
  (step/seal/summarize/dispute); `StaticModelRouter` and rule-based
  `DeclarativeModelRouter` (phase, objective match, tool-count, context
  pressure, step index, failure fallback). Sentinel brain gates key on the
  selected brain's identity — hybrid local/cloud topologies keep per-model
  inference bounds.
- **Sessions (`./session`):** `createAgentRuntime(config)` high-level facade
  (brain or router, native tools, MCP servers, policy, approvals, budgets,
  sentinel — MCP connects before the handle returns, fail-closed);
  `runtime.run()` one-shot and `runtime.createSession()` with context
  continuity across runs, fresh budgets per run and `abort()` sealing as
  CEDED. Defaults follow the documented mitigation posture
  (single-inference sentinel, TopK(8) with MCP, trust-aware policy).
- **Packaging integrity:** `pnpm verify:package` — pack → fresh consumer
  install → strict-compile all examples against the tarball (README quickstart
  included, verbatim in `examples/basic`) → execute the offline
  `examples/custom-tools` demo → import-smoke all 15 public subpaths; wired as
  a dedicated CI job. `examples/mcp-filesystem` demonstrates MCP progressive
  discovery against the official filesystem reference server.
- **Observability contract:** `CAPABILITY_METRICS`, `POLICY_METRICS`,
  `MCP_METRICS` added to the canonical metric names.
- `ContextManager.contextPressure()` (0..1, for routers).
- Test fixtures: `test/fixtures/fake-mcp-server.mjs` (usable with the MCP
  inspector), in-memory MCP loopback harness, real HTTP/SSE transport tests.

### Fixed

- README/PACKAGING still referenced `@nemesis-oss/ollama-sdk@^0.1.0`
  (contradicting the `^1.3.0` peer contract; registry-verified publishable).
- README quickstart did not compile (missing `ContextManager` import, unused
  `OllamaClient` import, `constrain: undefined` under
  `exactOptionalPropertyTypes`); now compile-tested via `examples/basic`.
- `toJsonSchema` crashed on non-Zod contracts (including MCP JSON-Schema
  contracts); it now projects JSON-Schema-carrying contracts directly and
  degrades exotic contracts to a permissive object schema.
- `ToolDefinition.invoke`/`idempotencyKey` use method syntax (bivariant
  parameters), so typed tools like `ToolDefinition<{city: string}>` are
  assignable wherever generic tool definitions are accepted (surfaced by the
  tarball verification; no more `any` escape hatches).
- Post-digest abort check in `AgentRunner`: a brain that resolves instead of
  throwing on cancellation can no longer flip an aborted run to ACHIEVED —
  aborted runs are always CEDED.

## [0.1.1] - 2026-09-11 (main)

### Fixed

Terminal-sealing and audit remediation wave (branch
`fix/terminal-sealing-and-remaining-gaps`):

- **Terminal sealing (Gap 2/3):** `SynthesisEngine` implemented (`seal()` +
  deterministic `degradedSeal()`); `AgentRunner` terminal routing — every run
  ships exactly one sealed `FinalReport`, `RunResult.finalReport` is non-null
  by contract (previously `null` on every outcome, including ACHIEVED).
- **Dispute resolution (Gap 4):** 4-tier `DisputeResolver` with append-only
  `NegotiationLedger` and the S1–S8 deterministic test matrix.
- **Fast-path gate telemetry (Gap 1/A7):** zero-wait grants now emit
  `runtime_gate_wait_ms` samples so congestion SLA histograms see healthy
  runs; `runtime_gate_saturation_total` emission added.
- **Structural error predicates (Gap 5/A6):** name-based predicates survive
  dual-module bundling; `RunAbortedError` added (kill-switch aborts classify
  as CEDED, not FAILED).
- **Concurrency gate (D12):** slot refund moved to the release site — a dead
  entry (waiter aborted after dequeue) can no longer double-decrement
  `active` and over-grant beyond `maxConcurrent`. Seeded fuzz test locks the
  invariant.
- **RepeatCallBinder:** window-based repetition governance (catches A–B
  oscillation loops) and off-by-one fix (2 identical calls allowed, 3rd
  blocked, per docs).
- **Tool deadline guard:** the 30s deadline timer is cleared on settle and
  the abort signal is raced — in-flight tools are actually cancelled by the
  kill switch (previously ran to completion, one leaked `Timeout` per call).
- **Kill switch reaches in-flight inference:** the schedule kill switch is
  forwarded into the SDK request (`signal`), so aborting cancels the HTTP
  call instead of being observed after the response arrives.
- **Sentinel actually wired:** loop inferences acquire per-model brain-gate
  leases; all 8 resource classes gate through the hands gate when a sentinel
  is supplied (previously 2 of 8); sentinel-missing `denied` errors surface
  as `TOOL_DENIED` instead of `SANDBOX_PANIC`.
- **Fence hardening:** fence tags are stripped over the full serialization
  before truncation (slice-then-strip could split a tag at the byte boundary
  and leave a live half-tag inside the fenced body).
- **Adapter integrity:** `InferenceQualityError` re-thrown verbatim
  (violations list preserved); dead `messages`-array response fallback
  removed (SDK 1.x `ChatResponse` has a single `message` field).
- **Budget integrity:** governance nudges no longer consume the hard intent
  budget; `CognitiveOverloadError` is reachable (step exhaustion throws it
  post-loop); per-step `startedAt` timestamps are monotonic.
- **Run leases:** tools receive run-scoped sandbox leases
  (`run:<uuid>`) instead of fabricated test leases.
- **Metric contract:** gate and hands layers emit the canonical
  `GATE_METRICS`/`TOOL_METRICS` names with canonical label keys.
- **Build:** repaired compile-breaking corruption in `observability/metrics.ts`
  and `orchestration/agent-spec.ts` on `main`; API baseline regenerated.
- **CI:** fixed mangled branch filter (`ain]` → `main` — CI never ran on the
  default branch); workflow modernized (pnpm action v4, zod-compat leg that
  does not trip the api-extractor baseline on DTS drift).

### Added

- `LICENSE` (MIT) and this `CHANGELOG.md` (previously claimed but absent).
- `test/integration/smoke.test.ts` — opt-in live-daemon smoke test
  (`OLLAMA_SMOKE=1 pnpm test:smoke`); with `UPDATE_GOLDEN=1` it captures a
  live `ChatResponse` golden fixture to replace the synthetic one.
- `test/unit/gate-fuzz.test.ts` — seeded property/fuzz test for the
  concurrency gate invariants (D11/D12).
- `test/unit/audit-regressions.test.ts` — 16 regression tests locking every
  audit defect fixed in this wave.

### Changed

- Peer dependency `@nemesis-oss/ollama-sdk` raised to `^1.3.0` (the adapter
  targets the SDK 1.x surface: `chat({ signal })` cancellation, single
  `message` response shape). Previously declared `^0.1.0`, contradicting the
  tested dev dependency `^1.3.0`.

## [0.1.0] - 2026-08-29

### Added

- Initial feature set: four-pillar architecture (Brain adapter, Hands tool
  catalogue with certified envelopes and fenced outputs, Memory context
  manager with compaction, Loop `AgentRunner` with budgets and terminal
  sealing), `ResourceSentinel` concurrency gates, observability metric
  contract, VCR test harness, and the frozen public API baseline
  (`etc/agentic-runtime.api.md`).
