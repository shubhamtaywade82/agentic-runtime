import { z } from "zod";
import { Contract, assertContract } from "./contracts.js";

/**
 * Base error for all runtime failures. Preserves the error chain for observability.
 * @public
 */
export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, AgentRuntimeError);
    }
  }
}

/**
 * Transport-level failures (network, timeout, 5xx) - RETRYABLE.
 * The SDK handles retry logic; runtime treats these as transient.
 * @public
 */
export class TransportFailure extends AgentRuntimeError {
  constructor(
    message: string,
    public readonly retryAfterMs?: number | null,
    cause?: unknown,
  ) {
    super(message, "TRANSPORT_FAILURE", cause);
    this.name = "TransportFailure";
  }
}

/**
 * Inference quality failures (malformed JSON, schema violations) - NOT RETRYABLE.
 * Same input produces same output; must feed violations back for self-correction.
 * @public
 */
export class InferenceQualityError extends AgentRuntimeError {
  constructor(
    message: string,
    public readonly violations: string[],
    public readonly rawOutput?: string,
  ) {
    super(message, "INFERENCE_QUALITY_ERROR", undefined);
    this.name = "InferenceQualityError";
  }
}

/**
 * Tool execution failures - categorized for precise handling.
 * @public
 */
export class ToolFailure extends AgentRuntimeError {
  constructor(
    message: string,
    public readonly category: "validation" | "execution" | "timeout" | "denied" | "unknown_tool",
  ) {
    super(message, "TOOL_FAILURE", undefined);
    this.name = "ToolFailure";
  }
}

/**
 * Budget exhaustion - NOT RETRYABLE without budget increase.
 * @public
 */
export class BudgetExhaustedError extends AgentRuntimeError {
  constructor(
    public readonly dimension: "steps" | "wallclock" | "tokens" | "intents",
    public readonly consumed: number,
    public readonly limit: number,
  ) {
    super(
      `Budget exhausted: ${dimension} (${consumed}/${limit})`,
      "BUDGET_EXHAUSTED",
      undefined,
    );
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Cognitive step limit exceeded without resolution.
 * @public
 */
export class CognitiveOverloadError extends AgentRuntimeError {
  constructor(
    public readonly stepsExecuted: number,
    public readonly limit: number,
    cause?: unknown,
  ) {
    super(
      `Cognitive step limit exceeded: ${stepsExecuted}/${limit} iterations without resolution`,
      "COGNITIVE_OVERLOAD",
      cause,
    );
    this.name = "CognitiveOverloadError";
  }
}

/**
 * Tool execution failed (network, validation, or handler error).
 * Wraps the original tool error for the dispute lattice.
 * @public
 */
export class ToolExecutionError extends AgentRuntimeError {
  constructor(
    public readonly toolName: string,
    public readonly args: unknown,
    public readonly originalError: Error,
  ) {
    super(
      `Tool '${toolName}' execution failed: ${originalError.message}`,
      "TOOL_EXECUTION_ERROR",
      originalError,
    );
    this.name = "ToolExecutionError";
  }
}

/**
 * The human approval gate timed out or was rejected.
 * Used by the HumanProtocol boundary.
 * @public
 */
export class HumanGateTimeoutError extends AgentRuntimeError {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(
      `Human approval gate timed out after ${timeoutMs}ms for tool '${toolName}'`,
      "HUMAN_GATE_TIMEOUT",
      cause,
    );
    this.name = "HumanGateTimeoutError";
  }
}

/**
 * A dispute between agents or between agent and validator could not be resolved.
 * @public
 */
export class DisputeResolutionError extends AgentRuntimeError {
  constructor(
    public readonly tier: 1 | 2 | 3 | 4,
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `Dispute resolution failed at tier ${tier}: ${reason}`,
      "DISPUTE_RESOLUTION_FAILED",
      cause,
    );
    this.name = "DisputeResolutionError";
  }
}

/**
 * Resource sentinel denied acquisition (concurrency gate).
 * @public
 */
export class ConcurrencyDeniedError extends AgentRuntimeError {
  constructor(
    public readonly resourceClass: string,
    public readonly requested: number,
    public readonly available: number,
    cause?: unknown,
  ) {
    super(
      `Concurrency denied for ${resourceClass}: requested ${requested}, available ${available}`,
      "CONCURRENCY_DENIED",
      cause,
    );
    this.name = "ConcurrencyDeniedError";
  }
}

/**
 * Concurrency gate acquisition aborted by kill switch.
 * @public
 */
export class GateAbortedError extends AgentRuntimeError {
  constructor(label: string) {
    super(
      `Aborted while awaiting ${label} compute lease.`,
      "GATE_ABORTED",
      undefined,
    );
    this.name = "GateAbortedError";
  }
}

/**
 * Concurrency gate queue depth exceeded.
 * @public
 */
export class GateSaturatedError extends AgentRuntimeError {
  constructor(label: string, maxDepth: number) {
    super(
      `Gate ${label} queue saturated (max depth: ${maxDepth}). Reconsider scope.`,
      "GATE_SATURATED",
      undefined,
    );
    this.name = "GateSaturatedError";
  }
}

/**
 * Run terminated by external kill switch (user or operator abort).
 * Distinct from GateAbortedError (which covers gate lease waits only).
 * Classified as CEDED: control was returned to the operator by design.
 * @public
 */
export class RunAbortedError extends AgentRuntimeError {
  constructor(reason: string = "external kill switch", cause?: unknown) {
    super(
      `Run aborted: ${reason}`,
      "RUN_ABORTED",
      cause,
    );
    this.name = "RunAbortedError";
  }
}

/**
 * Check if an error is a transient transport failure (retryable).
 *
 * Detection is structural, in priority order:
 * 1. SDK typed errors carry a `retryable: true` flag (duck-typed, so core
 *    stays free of SDK imports) - no message sniffing needed.
 * 2. Well-known transport error codes/signals in the error's name or
 *    message (ECONNREFUSED, ETIMEDOUT, "fetch failed", ...).
 * 3. The same checks against the error's `cause` chain (Node wraps
 *    transport failures, e.g. `fetch failed` caused by ECONNREFUSED).
 * @public
 */
export function isTransientTransport(err: unknown): boolean {
  return classifyTransient(err, 0);
}

const TRANSIENT_SIGNAL = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|OllamaNetworkError|5\d\d)\b/i;

function classifyTransient(err: unknown, depth: number): boolean {
  if (depth > 3 || !(err instanceof Error)) return false;

  // 1. SDK typed errors: structural retryable flag.
  if ((err as { retryable?: unknown }).retryable === true) return true;

  // 2. Name/message signal sniffing (fallback for untyped transport errors).
  if (TRANSIENT_SIGNAL.test(`${err.name} ${err.message}`)) return true;

  // 3. Cause chain: Node's fetch wraps the real socket error.
  return classifyTransient((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Check if an error is a gate abort error.
 *
 * Structural check (A6): matches on the class name rather than `instanceof`
 * so predicates keep working when a consumer's bundler/DTS setup produces a
 * second copy of the module (dual-instance hazard), and across `Symbol.hasInstance`
 * exotic environments. All runtime error classes set `name` in their constructor,
 * making this a reliable discriminator.
 * @public
 */
export function isGateAbortedError(err: unknown): err is GateAbortedError {
  return err instanceof Error && err.name === "GateAbortedError";
}

/**
 * Check if an error is a gate saturation error. Structural check (A6),
 * see isGateAbortedError for rationale.
 * @public
 */
export function isGateSaturatedError(err: unknown): err is GateSaturatedError {
  return err instanceof Error && err.name === "GateSaturatedError";
}

/**
 * Check if an error is a run abort error (kill switch). Structural check (A6),
 * see isGateAbortedError for rationale.
 * @public
 */
export function isRunAbortedError(err: unknown): err is RunAbortedError {
  return err instanceof Error && err.name === "RunAbortedError";
}

/**
 * Check if an error is an inference quality error. Structural check (A6),
 * see isGateAbortedError for rationale.
 * @public
 */
export function isInferenceQualityError(err: unknown): err is InferenceQualityError {
  return err instanceof Error && err.name === "InferenceQualityError";
}

/**
 * Check if an error is a budget exhaustion error. Structural check (A6),
 * see isGateAbortedError for rationale.
 * @public
 */
export function isBudgetExhaustedError(err: unknown): err is BudgetExhaustedError {
  return err instanceof Error && err.name === "BudgetExhaustedError";
}

/**
 * Check if an error is a cognitive overload error. Structural check (A6),
 * see isGateAbortedError for rationale.
 * @public
 */
export function isCognitiveOverloadError(err: unknown): err is CognitiveOverloadError {
  return err instanceof Error && err.name === "CognitiveOverloadError";
}

/**
 * Turn usage metrics from the inference engine.
 * @public
 */
export interface TurnUsage {
  promptTokens: number;
  evalTokens: number;
  totalDurationMs: number;
  loadDurationMs: number;
}

/**
 * Represents a single assistant turn in the execution trace.
 * Aligns with SDK message structure.
 * @public
 */
export interface AssistantTurn {
  content: string;
  toolCalls: ToolCallRequest[];
  finishTag: "stop" | "tool_calls" | "length_truncated";
  usage: TurnUsage | null;
}

/**
 * Structured tool call request emitted by the Brain.
 * Matches SDK function calling format.
 * @public
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of a tool execution (observation).
 * Injected back into the context window.
 * @public
 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  success: boolean;
  output: unknown;
  error?: string;
  trustLevel: "verified" | "trusted" | "unverified";
  executionTimeMs: number;
}

/**
 * Outcome of a certified contract execution.
 * @public
 */
export interface ContractOutcome {
  status: "SUCCESS" | "FAILURE" | "PARTIAL";
  payload: string; // Fenced with <result_trust_level="untrusted-data">
  telemetry: {
    executionMs: number;
    bytesTransferred: number;
  };
}

/**
 * Execution step record for the ledger and observability.
 * @public
 */
export interface ExecutionStep {
  stepIndex: number;
  assistantTurn: AssistantTurn;
  toolResults: ToolResult[];
  startedAt: number;
  completedAt: number;
}

/**
 * Final sealed report emitted by the Synthesis Engine.
 * This is the immutable terminal artifact.
 * @public
 */
export const FinalReportSchema = z.object({
  status: z.enum(["ACHIEVED", "PARTIAL", "CEDED", "FAILED"]),
  objective: z.string(),
  executiveSummary: z.string().min(50),
  findings: z.array(
    z.object({
      claim: z.string(),
      evidenceRef: z.string().regex(/^receipt-[a-f0-9-]+$/),
      confidence: z.number().min(0).max(1),
    }),
  ),
  disputes: z.array(
    z.object({
      tier: z.number().int().min(1).max(4),
      parties: z.array(z.string()),
      resolution: z.string(),
      resolved: z.boolean(),
    }),
  ),
  metrics: z.object({
    totalSteps: z.number().int(),
    totalToolCalls: z.number().int(),
    totalWallTimeMs: z.number().int(),
    totalTokensIn: z.number().int(),
    totalTokensOut: z.number().int(),
    sentinelAcquisitions: z.number().int(),
    sentinelRejections: z.number().int(),
  }),
  seal: z.object({
    timestamp: z.string().datetime(),
    hash: z.string(),
    runtimeVersion: z.string(),
  }),
}).strict();

/** @public */
export type FinalReport = z.infer<typeof FinalReportSchema>;

/**
 * Contract for FinalReport - structural alias to prevent Zod version leakage.
 * @public
 */
export const FinalReportContract = assertContract(FinalReportSchema) as Contract<FinalReport>;

/**
 * Budget configuration for the agentic loop.
 * @public
 */
export const BudgetConfigSchema = z.object({
  maxCogStepN: z.number().int().positive().default(15),
  wallTimeCeilMs: z.number().int().positive().default(300_000),
  hardIntentCount: z.number().int().positive().default(20),
  maxTokensPerStep: z.number().int().positive().default(8_000),
});

/** @public */
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

/**
 * Resource class for the Hardware Sentinel.
 * @public
 */
export const ResourceClassSchema = z.enum([
  "local-cpu",
  "local-gpu",
  "gpu-inference",
  "local-sandbox",
  "external-network",
  "external-database",
  "filesystem-read",
  "filesystem-write",
]);

/** @public */
export type ResourceClass = z.infer<typeof ResourceClassSchema>;

/**
 * Tool effect classification for idempotency and retry semantics.
 * @public
 */
export const ToolEffectSchema = z.enum(["pure", "transactional"]);

/** @public */
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

/**
 * Tool grant level for HumanProtocol.
 * @public
 */
export const GrantLevelSchema = z.enum(["auto", "acknowledged", "acknowledged-privileged", "manual"]);

/** @public */
export type GrantLevel = z.infer<typeof GrantLevelSchema>;

/**
 * Tool definition contract - aligns with SDK defineTool pattern.
 * @public
 */
export const ToolDefinitionSchema = z.object({
  handle: z.string().min(1),
  caption: z.string().min(1),
  argsShape: z.custom<Contract<unknown>>(),
  resourceClass: ResourceClassSchema,
  effects: ToolEffectSchema.default("pure"),
  grantLevel: GrantLevelSchema.default("auto"),
  maxOutputChars: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Tool definition interface with invoke handler.
 * @public
 */
export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  handle: string;
  caption: string;
  argsShape: Contract<TArgs>;
  resourceClass: ResourceClass;
  /** 
   * Effect classification determines retry safety:
   * - "pure": No side effects, safe to re-dispatch blindly
   * - "transactional": Side effects with idempotency key, safe to re-dispatch with same key
   */
  effects: "pure" | "transactional";
  grantLevel: GrantLevel;
  maxOutputChars?: number;
  timeoutMs?: number;
  invoke: (args: TArgs, lease: SandboxLease | ResourceLease, cancelToken: AbortSignal) => Promise<ToolResult>;
  /** Optional projection to strip noise before persisting digests. */
  reflect?: (raw: ToolResult) => unknown;
  /**
   * Required for "transactional" tools. Generates a deterministic key from arguments
   * to enable safe re-dispatch (e.g., HTTP POST with same idempotency key).
   */
  idempotencyKey?: (args: TArgs) => string;
  /**
   * Required when resourceClass is "gpu-inference". Specifies the model ID
   * to route the inference through the correct per-model concurrency gate.
   */
  targetModelId?: string;
}

/**
 * Sandbox lease for tool execution isolation.
 * @public
 */
export interface SandboxLease {
  tag: string;
  leaseMs: number;
  maxResultBytes: number;
  auditTrailId: string;
  canClobberDisc: boolean;
}

/**
 * Resource lease returned by the Sentinel.
 * @public
 */
export interface ResourceLease {
  resourceClass: ResourceClass;
  units: number;
  acquiredAt: number;
  expiresAt?: number;
  release: () => Promise<void>;
}

/**
 * Observability event types for the bus.
 * @public
 */
export const ObservabilityEventSchema = z.object({
  name: z.string(),
  payload: z.unknown(),
  timestamp: z.number(),
  stepIndex: z.number().int().optional(),
  traceId: z.string().optional(),
});

/** @public */
export type ObservabilityEvent = z.infer<typeof ObservabilityEventSchema>;

/**
 * Human protocol authorization request.
 * @public
 */
export interface HumanProtocolRequest {
  toolCall: ToolCallRequest;
  toolDefinition: ToolDefinition;
  lease: ResourceLease;
  context: {
    objective: string;
    stepIndex: number;
    previousAttempts: number;
  };
}

/**
 * Mounted tools manifest for the Brain.
 * @public
 */
export interface MountedTools {
  manifests: ReadonlyArray<{
    name: string;
    description: string;
    parametersJsonSchema: JSONSchema7;
  }>;
}

/**
 * Constraint payload for grammar-constrained decoding.
 * @public
 */
export interface ConstraintPayload {
  subjectOutputSchema: JSONSchema7 | null;
}

/**
 * Request schedule for inference calls.
 * @public
 */
export interface RequestSchedule {
  mounting?: MountedTools;
  constrain?: ConstraintPayload;
  idleLiveSeconds?: number;
  entropyOverride?: number;
  upperBoundTokenCount?: number;
  killSwitch: AbortSignal;
  transcriptDigest?: string;
}

/**
 * Chat message format for the Brain interface.
 * @public
 */
export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * ThoughtProcess interface - thin seam for inference adapters.
 * @public
 */
export interface ThoughtProcess {
  digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn>;
  readonly identityTag: string;
}

/**
 * Configuration for the Ollama adapter.
 * @public
 */
export interface ThoughtPortConfig {
  baseUrl: string;
  defaults?: {
    numCtx?: number;
    idleLiveSeconds?: number;
    timeoutMs?: number;
    retries?: number;
  };
  verbose?: Logger;
}

/**
 * Logger interface.
 * @public
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** @public */
export interface Logger {
  log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Event sink for observability.
 * @public
 */
export interface EventSink {
  emit(name: string, payload: Record<string, unknown>): void;
}

/**
 * Progress tracking.
 * @public
 */
export const ProgressSchema = z.object({
  doneTasks: z.number().int().nonnegative(),
  totalKnownTasks: z.number().int().nonnegative().nullable(),
  currentActivity: z.string(),
});

/** @public */
export type Progress = z.infer<typeof ProgressSchema>;

/**
 * JSON Schema type (from json-schema package).
 * @public
 */
export interface JSONSchema7 {
  type?: string;
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Re-export structural Zod alias for consumers.
 * @public
 */
export { Contract, assertContract } from "./contracts.js";