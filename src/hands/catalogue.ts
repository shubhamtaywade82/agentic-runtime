import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodIssue, ZodType } from "zod";
import type {
  ToolDefinition,
  SandboxLease,
  ToolCallRequest,
  ToolResult,
  EventSink,
  JSONSchema7,
} from "../core/types.js";

/**
 * Maximum bytes for tool output before truncation (context bleed mitigation).
 * @public
 */
export const SMART_LIMIT_BYTES = 48_000;

/**
 * Hard ceiling for tool execution time (ms).
 * @public
 */
export const HARD_TOOL_CEILING_MS = 30_000;

/**
 * Result of forwarding an intent to a tool.
 * @public
 */
export interface ForwardResult {
  type: "ok" | "fail";
  body: string; // Fenced with <result_trust_level="untrusted-data">
}

/**
 * ToolkitCatalogue - Registry and executor for tools.
 * 
 * Responsibilities:
 * - Tool registration and manifest generation (for Brain mounting)
 * - Parameter validation via Zod (strict)
 * - Execution with timeout and abort support
 * - Output fencing with <result_trust_level="untrusted-data">
 * - Observation projection (reflect) for context compaction
 * @public
 */
export class ToolkitCatalogue {
  private slots = new Map<string, ToolDefinition<Record<string, unknown>>>();

  constructor(private sink: EventSink) {}

  /**
   * Register a tool in the catalogue.
   * @public
   */
  place<TArgs extends Record<string, unknown>>(
    tool: ToolDefinition<TArgs>,
  ): this {
    this.slots.set(tool.handle, tool as ToolDefinition<Record<string, unknown>>);
    return this;
  }

  /**
   * Get all registered tool handles.
   * @public
   */
  slotNames(): string[] {
    return [...this.slots.keys()];
  }

  /**
   * Get tool definition by handle.
   * @public
   */
  get(handle: string): ToolDefinition | undefined {
    return this.slots.get(handle);
  }

  /**
   * Generate manifests for Brain mounting (model-native tool calling).
   * Uses conservative JSON Schema conversion (OpenAPI 3 compatible).
   * @public
   */
  manifests(): Array<{ name: string; description: string; parametersJsonSchema: JSONSchema7 }> {
    return [...this.slots.values()].map((t) => ({
      name: t.handle,
      description: t.caption,
      parametersJsonSchema: toJsonSchema(t.argsShape),
    }));
  }

  /**
   * Execute a validated tool intent.
   * 
   * Flow:
   * 1. Look up tool by name
   * 2. Validate arguments against Zod schema (strict)
   * 3. Execute with timeout and abort signal
   * 4. Apply reflect projection if defined
   * 5. Fence output with <result_trust_level="untrusted-data">
   * 6. Truncate if exceeds SMART_LIMIT_BYTES
   * @public
   */
  async forwardIntent(
    intent: ToolCallRequest,
    lease: SandboxLease,
    cancelToken: AbortSignal,
  ): Promise<ForwardResult> {
    const tool = this.slots.get(intent.name);
    if (!tool) {
      return {
        type: "fail",
        body: `Unresolvable dispatch target "${intent.name}". Valid targets: ${this.slotNames().join(", ")}.`,
      };
    }

    // Strict parameter validation
    const verified = tool.argsShape.safeParse(intent.arguments);
    if (!verified.success) {
      const issues = (verified as { error: { issues: ZodIssue[] } }).error.issues;
      const grievances = issues
        .map((issue: ZodIssue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return {
        type: "fail",
        body: `Argument credential rejection [${grievances}]. Resend corrected calling card.`,
      };
    }

    const startedAt = performance.now();
    try {
      // Execute with deadline guard
      const raw = await this.guardDeadlines(
        () => tool.invoke(verified.data, lease, cancelToken),
        tool.timeoutMs ?? HARD_TOOL_CEILING_MS,
      );

      // Apply observation projection (reflect) for context compaction
      const inspectable = tool.reflect ? tool.reflect(raw) : raw;
      const serialized = typeof inspectable === "string" 
        ? inspectable 
        : JSON.stringify(inspectable, null, 2);

      // Fence output - neutralize fence closing tags (anti break-out vector)
      const safeBody = serialized
        .slice(0, SMART_LIMIT_BYTES)
        .replace(/<\/?result_trust_level[^>]*>/g, "");
      
      const truncatedNote = serialized.length > SMART_LIMIT_BYTES
        ? `\n[Truncated ${serialized.length} → ${SMART_LIMIT_BYTES} bytes.]`
        : "";

      const executionMs = performance.now() - startedAt;
      this.sink.emit("tool:result", {
        handle: tool.handle,
        ms: executionMs,
        bytes: serialized.length,
        truncated: serialized.length > SMART_LIMIT_BYTES,
      });

      return {
        type: "ok",
        body: `<result_trust_level="untrusted-data" src="${tool.handle}">\n${safeBody}\n</result_trust_level>${truncatedNote}`,
      };

    } catch (err) {
      const executionMs = performance.now() - startedAt;
      const failure = err instanceof ToolInvocationError ? err : new ToolInvocationError(String(err), "execution");
      
      this.sink.emit("tool:failure", {
        handle: tool.handle,
        kind: failure.category,
        ms: executionMs,
      });

      return {
        type: "fail",
        body: `${failure.category.toUpperCase()} _ACTION HALTED_ :: ${failure.message}\nAssess whether alternative paths exist.`,
      };
    }
  }

  /**
   * Execute a tool directly (for testing or internal use).
   * Bypasses intent forwarding, uses validated args directly.
   * @public
   */
  async executeDirect<TArgs extends Record<string, unknown>>(
    handle: string,
    args: TArgs,
    lease: SandboxLease,
    cancelToken: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.slots.get(handle);
    if (!tool) {
      throw new ToolInvocationError(`Unknown tool: ${handle}`, "unknown_tool");
    }

    const verified = tool.argsShape.safeParse(args);
    if (!verified.success) {
      const issues = (verified as { error: { issues: ZodIssue[] } }).error.issues;
      throw new ToolInvocationError(
        `Validation failed: ${issues.map((issue: ZodIssue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        "validation",
      );
    }

    const startedAt = performance.now();
    try {
      const output = await this.guardDeadlines(
        () => tool.invoke(verified.data, lease, cancelToken),
        tool.timeoutMs ?? HARD_TOOL_CEILING_MS,
      );
      const executionMs = performance.now() - startedAt;

      return {
        toolCallId: crypto.randomUUID(),
        name: handle,
        success: true,
        output,
        trustLevel: "verified",
        executionTimeMs: executionMs,
      };
    } catch (err) {
      const executionMs = performance.now() - startedAt;
      const failure = err instanceof ToolInvocationError ? err : new ToolInvocationError(String(err), "execution");
      
      return {
        toolCallId: crypto.randomUUID(),
        name: handle,
        success: false,
        output: null,
        error: failure.message,
        trustLevel: "unverified",
        executionTimeMs: executionMs,
      };
    }
  }

  /**
   * Guard execution with deadline and abort signal.
   */
  private guardDeadlines<R>(fn: () => Promise<R>, ceilingMs: number): Promise<R> {
    const deadline = Promise.race([
      fn(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new ToolInvocationError("exceeded sandbox lease period", "timeout")), ceilingMs)
      ),
    ]);

    // Also respect external abort signal
    // Note: This is a simplified version; real implementation would wire AbortSignal
    return deadline;
  }
}

/**
 * Convert Zod schema to JSON Schema (conservative, OpenAPI 3 compatible).
 * Strips unsupported features for grammar compiler compatibility.
 * @public
 */
export function toJsonSchema(schema: ZodType<unknown, unknown, unknown>): JSONSchema7 {
  return zodToJsonSchema(schema, { target: "openApi3" }) as JSONSchema7;
}

/**
 * ToolInvocationError - Categorized tool execution errors (distinct from core ToolExecutionError).
 * @public
 */
export class ToolInvocationError extends Error {
  constructor(
    message: string,
    public readonly category: "validation" | "execution" | "timeout" | "denied" | "unknown_tool",
  ) {
    super(message);
    this.name = "ToolInvocationError";
  }
}

/**
 * Create a standard sandbox lease for testing.
 * @public
 */
export function createTestLease(overrides: Partial<SandboxLease> = {}): SandboxLease {
  return {
    tag: "test-scratch:/tmp/test/",
    leaseMs: 30_000,
    maxResultBytes: SMART_LIMIT_BYTES,
    auditTrailId: crypto.randomUUID(),
    canClobberDisc: false,
    ...overrides,
  };
}

/**
 * Factory to create a ToolkitCatalogue with standard tools.
 * @public
 */
export function createStandardCatalogue(sink: EventSink): ToolkitCatalogue {
  return new ToolkitCatalogue(sink);
}