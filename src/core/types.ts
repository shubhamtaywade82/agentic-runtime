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
 * The cognitive step limit was exceeded without the agent reaching a terminal state.
 * Maps to SDK `maxIterations` exhaustion.
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
 * A tool execution failed (network, validation, or handler error).
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
 * A hard budget (wall-time, token ceiling, intent count) was exhausted.
 * @public
 */
export class BudgetExhaustedError extends AgentRuntimeError {
  constructor(
    public readonly budgetType: "wallTime" | "cogSteps" | "intentCount",
    public readonly consumed: number,
    public readonly limit: number,
    cause?: unknown,
  ) {
    super(
      `Budget exhausted: ${budgetType} (${consumed}/${limit})`,
      "BUDGET_EXHAUSTED",
      cause,
    );
    this.name = "BudgetExhaustedError";
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
 * Represents a single assistant turn in the execution trace.
 * Aligns with SDK message structure.
 * @public
 */
export interface AssistantTurn {
  role: "assistant";
  content: string;
  toolCalls?: ToolCallRequest[];
  reasoning?: string; // Internal monologue / chain-of-thought
  timestamp: number;
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
  trustLevel: "verified" | "trusted" | "unverified"; // Result trust level for fencing
  executionTimeMs: number;
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
  status: z.enum(["completed", "failed", "cancelled", "escalated"]),
  objective: z.string(),
  executiveSummary: z.string(),
  findings: z.array(
    z.object({
      claim: z.string(),
      evidenceRef: z.string(), // References execution step or tool result ID
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
    hash: z.string(), // SHA-256 of the report content
    runtimeVersion: z.string(),
  }),
});

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
export const ToolEffectSchema = z.enum(["pure", "idempotent", "transactional", "destructive"]);

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
  argsShape: z.custom<Contract<unknown>>(), // Structural Zod alias
  resourceClass: ResourceClassSchema,
  effects: ToolEffectSchema.default("pure"),
  grantLevel: GrantLevelSchema.default("auto"),
  maxOutputChars: z.number().int().positive().optional(), // Context bleed mitigation
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
  effects: ToolEffect;
  grantLevel: GrantLevel;
  maxOutputChars?: number;
  timeoutMs?: number;
  invoke: (args: TArgs, lease: ResourceLease, cancelToken: AbortSignal) => Promise<ToolResult>;
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
 * Re-export structural Zod alias for consumers.
 * @public
 */
export { Contract, assertContract } from "./contracts.js";