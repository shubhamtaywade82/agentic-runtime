import { z } from "zod";

/**
 * Observability Metric Constants
 *
 * This module defines the canonical metric names and label enums for the
 * observability bus. All metrics emitted by the runtime MUST use these constants
 * to prevent cardinality explosion and ensure semantic consistency.
 *
 * Emission convention (v0.1):
 * - Numeric telemetry (counters, gauges, histograms) is emitted under the
 *   canonical names below. The sentinel gate (`GATE_METRICS.*`) and the hands
 *   layer (`TOOL_METRICS.*`) comply; payloads carry the canonical label keys
 *   (`GATE_LABEL_KEYS`, `TOOL_LABEL_KEYS`, ...).
 * - Lifecycle/domain events (e.g. "seal:attempt", "dispute:plan") use
 *   `domain:event` names and are NOT metrics. Mapping them onto
 *   `DISPUTE_METRICS` / `SYNTHESIS_METRICS` counters is a tracked v0.2
 *   migration item (see KNOWN_LIMITATIONS.md #16).
 *
 * Changing any value here constitutes a BREAKING CHANGE (MAJOR version bump)
 * as it affects operator dashboards, alerts, and replay consumers.
 * @public
 */

// ============================================================================
// Gate Metrics (Hardware Sentinel)
// ============================================================================

/** Gate identifier format: "brain:{modelId}" | "hands" */
/** @public */
export const GATE_LABELS = ["brain", "hands"] as const;
/** @public */
export type GateLabel = (typeof GATE_LABELS)[number];

/** Priority lanes in the concurrency gate */
/** @public */
export const PRIORITY_LABELS = ["critical", "normal"] as const;
/** @public */
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

/** Gate metric names */
/** @public */
export const GATE_METRICS = {
  /** Histogram: time spent waiting in the gate queue (ms) */
  WAIT_MS: "runtime_gate_wait_ms",
  
  /** Gauge: currently active leases */
  ACTIVE: "runtime_gate_active",
  
  /** Gauge: currently waiting in queue */
  WAITING: "runtime_gate_waiting",
  
  /** Counter: total grants */
  GRANTS_TOTAL: "runtime_gate_grants_total",
  
  /** Counter: total refunds (aborted grants) */
  REFUNDS_TOTAL: "runtime_gate_refunds_total",
  
  /** Counter: saturation rejections */
  SATURATION_TOTAL: "runtime_gate_saturation_total",
} as const;

/** Gate metric label keys */
/** @public */
export const GATE_LABEL_KEYS = {
  GATE: "gate",
  PRIORITY: "priority",
} as const;

// ============================================================================
// Brain / Inference Metrics
// ============================================================================

/** @public */
export type ModelLabel = string;

/** Finish tag for inference turns */
/** @public */
export const FINISH_TAG_LABELS = ["stop", "tool_calls", "length_truncated"] as const;
/** @public */
export type FinishTagLabel = (typeof FINISH_TAG_LABELS)[number];

/** Brain/Inference metric names */
/** @public */
export const INFERENCE_METRICS = {
  /** Histogram: total inference latency (ms) */
  LATENCY_MS: "runtime_inference_ms",
  
  /** Counter: prompt tokens consumed */
  TOKENS_PROMPT_TOTAL: "runtime_tokens_prompt_total",
  
  /** Counter: eval/completion tokens generated */
  TOKENS_EVAL_TOTAL: "runtime_tokens_eval_total",
  
  /** Counter: total turns */
  TURNS_TOTAL: "runtime_inference_turns_total",
  
  /** Counter: truncation events */
  TRUNCATIONS_TOTAL: "runtime_inference_truncations_total",
} as const;

/** Inference metric label keys */
/** @public */
export const INFERENCE_LABEL_KEYS = {
  MODEL: "model",
  FINISH_TAG: "finish_tag",
} as const;

// ============================================================================
// Hands / Tool Metrics
// ============================================================================

/** Tool class categories */
/** @public */
export const TOOL_CLASS_LABELS = [
  "search",
  "read", 
  "write",
  "compute",
  "fetch",
  "validate",
  "lint",
  "audit",
  "local_sandbox",
  "external_network",
  "external_database",
  "gpu_inference",
] as const;
/** @public */
export type ToolClassLabel = (typeof TOOL_CLASS_LABELS)[number];

/** Tool failure categories (closed enum) */
/** @public */
export const TOOL_FAILURE_CATEGORIES = [
  "validation",
  "execution", 
  "timeout",
  "denied",
  "unknown_tool",
] as const;
/** @public */
export type ToolFailureCategory = (typeof TOOL_FAILURE_CATEGORIES)[number];

/** Tool metric names */
/** @public */
export const TOOL_METRICS = {
  /** Histogram: tool execution latency (ms) */
  LATENCY_MS: "runtime_tool_ms",
  
  /** Counter: total tool failures */
  FAILURES_TOTAL: "runtime_tool_failures_total",
  
  /** Counter: total tool invocations */
  INVOCATIONS_TOTAL: "runtime_tool_invocations_total",
  
  /** Counter: total bytes transferred */
  BYTES_TRANSFERRED_TOTAL: "runtime_tool_bytes_transferred_total",
} as const;

/** Tool metric label keys */
/** @public */
export const TOOL_LABEL_KEYS = {
  TOOL_CLASS: "tool_class",
  FAIL_CATEGORY: "fail_category",
} as const;

// ============================================================================
// Loop / Run Metrics
// ============================================================================

/** Run status outcomes */
/** @public */
export const RUN_STATUS_LABELS = ["ACHIEVED", "PARTIAL", "CEDED", "FAILED"] as const;
/** @public */
export type RunStatusLabel = (typeof RUN_STATUS_LABELS)[number];

/** Run exit reasons */
/** @public */
export const RUN_EXIT_REASON_LABELS = [
  "objective_met",
  "wall_clock_exhausted",
  "cog_steps_exhausted",
  "intents_exhausted",
  "operator_abort",
  "transport_failure",
  "synthesis_failure",
] as const;
/** @public */
export type RunExitReasonLabel = (typeof RUN_EXIT_REASON_LABELS)[number];

/** Loop/Run metric names */
/** @public */
export const RUN_METRICS = {
  /** Counter: runs by terminal status */
  STATUS_TOTAL: "runtime_run_status_total",
  
  /** Histogram: total run wall-clock time (ms) */
  DURATION_MS: "runtime_run_ms",
  
  /** Counter: total cognitive steps */
  STEPS_TOTAL: "runtime_run_steps_total",
  
  /** Counter: total tool intents dispatched */
  INTENTS_TOTAL: "runtime_run_intents_total",
  
  /** Counter: salvage events */
  SALVAGE_TOTAL: "runtime_run_salvage_total",
} as const;

/** Run metric label keys */
/** @public */
export const RUN_LABEL_KEYS = {
  STATUS: "status",
  EXIT_REASON: "exit_reason",
} as const;

// ============================================================================
// Memory / Context Metrics
// ============================================================================

/** Memory/Context metric names */
/** @public */
export const MEMORY_METRICS = {
  /** Counter: total digestion cycles */
  DIGESTIONS_TOTAL: "runtime_digestions_total",
  
  /** Gauge: estimated tokens in context */
  EST_TOKENS: "runtime_ctx_est_tokens",
  
  /** Gauge: current lane length */
  LANE_LENGTH: "runtime_ctx_lane_length",
  
  /** Counter: pin operations */
  PINS_TOTAL: "runtime_ctx_pins_total",
} as const;

// ============================================================================
// Dispute Metrics
// ============================================================================

/** Dispute resolution tiers */
/** @public */
export const DISPUTE_TIER_LABELS = ["ORACLE", "RECOMPUTE", "JUDGE", "HUMAN_GATE"] as const;
/** @public */
export type DisputeTierLabel = (typeof DISPUTE_TIER_LABELS)[number];

/** Dispute resolution actions */
/** @public */
export const DISPUTE_ACTION_LABELS = [
  "ADOPT",
  "RECOMPUTE", 
  "QUARANTINE",
  "HUMAN_GATE",
] as const;
/** @public */
export type DisputeActionLabel = (typeof DISPUTE_ACTION_LABELS)[number];

/** Dispute metric names */
/** @public */
export const DISPUTE_METRICS = {
  /** Counter: disputes by tier and action */
  TOTAL: "runtime_disputes_total",
  
  /** Histogram: resolution latency (ms) */
  LATENCY_MS: "runtime_dispute_ms",
  
  /** Counter: quarantine events */
  QUARANTINE_TOTAL: "runtime_dispute_quarantine_total",
  
  /** Counter: oscillation detections */
  OSCILLATION_TOTAL: "runtime_dispute_oscillation_total",
} as const;

/** Dispute metric label keys */
/** @public */
export const DISPUTE_LABEL_KEYS = {
  TIER: "tier",
  ACTION: "action",
} as const;

// ============================================================================
// Synthesis / Seal Metrics
// ============================================================================

/** Seal result classes */
/** @public */
export const SEAL_RESULT_LABELS = ["accepted", "violation"] as const;
/** @public */
export type SealResultLabel = (typeof SEAL_RESULT_LABELS)[number];

/** Seal violation classes */
/** @public */
export const SEAL_VIOLATION_CLASSES = [
  "FENCE_ESCAPE",
  "DIRECTIVE_SUSPECT", 
  "SCHEMA",
  "CLOSURE",
] as const;
/** @public */
export type SealViolationClass = (typeof SEAL_VIOLATION_CLASSES)[number];

/** Synthesis metric names */
/** @public */
export const SYNTHESIS_METRICS = {
  /** Counter: total seals attempted */
  SEALS_TOTAL: "runtime_seals_total",
  
  /** Counter: seal violations by class */
  VIOLATIONS_TOTAL: "runtime_seal_violations_total",
  
  /** Histogram: seal latency (ms) */
  LATENCY_MS: "runtime_seal_ms",
  
  /** Counter: reseal attempts */
  RESEAL_ATTEMPTS_TOTAL: "runtime_seal_reseal_attempts_total",
} as const;

/** Synthesis metric label keys */
/** @public */
export const SYNTHESIS_LABEL_KEYS = {
  RESULT: "result",
  VIOLATION_CLASS: "violation_class",
} as const;

// ============================================================================
// Sink / Telemetry Health
// ============================================================================

/** Sink/Telemetry metric names */
/** @public */
export const SINK_METRICS = {
  /** Counter: events successfully emitted */
  EMITTED_TOTAL: "runtime_sink_emitted_total",
  
  /** Counter: events dropped (sink errors) */
  DROPPED_TOTAL: "runtime_sink_dropped_total",
  
  /** Counter: listener errors */
  LISTENER_ERRORS_TOTAL: "runtime_sink_listener_errors_total",
} as const;

// ============================================================================
// Capability Layer (progressive discovery)
// ============================================================================

/** Capability-layer metric names */
/** @public */
export const CAPABILITY_METRICS = {
  /** Counter: capabilities registered into the router, by source and kind */
  REGISTRATIONS_TOTAL: "runtime_capability_registrations_total",

  /** Gauge: size of the active mounted capability set per step */
  MOUNTED_SIZE: "runtime_capability_mounted_size",

  /** Counter: server capability sets dropped from the index */
  FORGOTTEN_SERVERS_TOTAL: "runtime_capability_forgotten_servers_total",
} as const;

/** Capability metric label keys */
/** @public */
export const CAPABILITY_LABEL_KEYS = {
  SOURCE: "source",
  KIND: "kind",
} as const;

// ============================================================================
// Policy Layer (capability trust boundary)
// ============================================================================

/** Policy-layer metric names */
/** @public */
export const POLICY_METRICS = {
  /** Counter: policy decisions rendered, by decision type */
  DECISIONS_TOTAL: "runtime_policy_decisions_total",

  /** Counter: approval requests resolved, by outcome */
  APPROVALS_TOTAL: "runtime_policy_approvals_total",

  /** Counter: approval requests that timed out (fail-closed denials) */
  APPROVAL_TIMEOUTS_TOTAL: "runtime_policy_approval_timeouts_total",
} as const;

/** Policy metric label keys */
/** @public */
export const POLICY_LABEL_KEYS = {
  DECISION: "decision",
  SCOPE: "scope",
  OUTCOME: "outcome",
} as const;

// ============================================================================
// Canonical Envelope Schema
// ============================================================================

/**
 * Canonical runtime event envelope.
 * All events crossing the sink MUST conform to this schema.
 * Version `v: 1` is the wire format version.
 * @public
 */
export const RuntimeEventEnvelopeSchema = z.object({
  v: z.literal(1),
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  tsMs: z.number().int().nonnegative(),
  agentPath: z.string().min(1),
}).passthrough();

/** @public */
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>;

// ============================================================================
// Utility: All Metric Names (for registration/validation)
// ============================================================================

/** Flattened array of all metric names for registration */
/** @public */
export const ALL_METRIC_NAMES = [
  ...Object.values(GATE_METRICS),
  ...Object.values(INFERENCE_METRICS),
  ...Object.values(TOOL_METRICS),
  ...Object.values(RUN_METRICS),
  ...Object.values(MEMORY_METRICS),
  ...Object.values(DISPUTE_METRICS),
  ...Object.values(SYNTHESIS_METRICS),
  ...Object.values(SINK_METRICS),
  ...Object.values(CAPABILITY_METRICS),
  ...Object.values(POLICY_METRICS),
] as const;

/** @public */
export type MetricName = (typeof ALL_METRIC_NAMES)[number];

// ============================================================================
// SLA Baseline Alerts (for documentation)
// ============================================================================

/**
 * Baseline operator alerts derived from the metric contract.
 * These are documented here to freeze the SLA definitions for v0.1.
 * 
 * Queue-thrash: GPU healthy but topology mis-sized
 * histogram_quantile(0.99, sum by (le,gate) (rate(runtime_gate_wait_ms_bucket[5m]))) > 30000
 * 
 * Correlated-worker collapse: disputes routinely escaping Tier 1–2
 * sum(rate(runtime_disputes_total[15m])) by (tier)
 *   / on() group_left sum(rate(runtime_disputes_total[15m])) < 0.5   # Tier-1 share collapsing
 * 
 * Truncation misconfiguration rising after a model/context change
 * sum(increase(runtime_inference_eval_count_total[1h])) ...
 *   ↑ paired with: increase(runtime_seal_violations_total{class="SCHEMA"}[1h]) > 5
 * 
 * Chronic under-budgeting: salvage machinery carrying the system
 * sum(rate(runtime_run_status_total[1d])) by (status) — PARTIAL share > 0.4
 */