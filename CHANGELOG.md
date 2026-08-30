# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
