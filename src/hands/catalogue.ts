import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodIssue, ZodType } from "zod";
import type {
  ToolDefinition,
  SandboxLease,
  ToolCallRequest,
  ToolResult,
  EventSink,
  JSONSchema7,
  Contract,
  ResourceClass,
} from "../core/types.js";
import type { ResourceSentinel } from "../sentinel/index.js";
import { TOOL_METRICS, TOOL_LABEL_KEYS } from "../observability/metrics.js";
import type { ToolClassLabel } from "../observability/metrics.js";

/**
 * Map a resource class to the canonical tool-class metric label.
 */
function toolClassOf(resClass: ResourceClass | undefined): ToolClassLabel {
  switch (resClass) {
    case "local-sandbox":
      return "local_sandbox";
    case "external-network":
      return "external_network";
    case "external-database":
      return "external_database";
    case "gpu-inference":
      return "gpu_inference";
    case "filesystem-read":
      return "read";
    case "filesystem-write":
      return "write";
    default:
      // local-cpu, local-gpu, unspecified
      return "compute";
  }
}

/**
 * Fabricate an abort error that survives structural classification
 * (`err.name === "AbortError"`) all the way to the dispatcher.
 */
function makeAbortError(): Error {
  const err = new Error("Tool execution aborted by kill switch or budget guard");
  err.name = "AbortError";
  return err;
}

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

function adaptToToolDefinition(raw: any): ToolDefinition {
  if (raw && typeof raw.invoke === "function" && typeof raw.handle === "string") {
    return raw;
  }
  const handle = raw.name || raw.handle;
  const caption = raw.description || raw.caption || handle;
  const argsShape = raw.parameters || raw.argsShape;
  return {
    handle,
    caption,
    argsShape,
    resourceClass: raw.resourceClass ?? "local-cpu",
    effects: raw.effects ?? "pure",
    grantLevel: raw.grantLevel ?? "auto",
    reflect: (res: ToolResult) => (res && typeof res === "object" && "output" in res ? res.output : res),
    invoke: async (args: any, lease: any, cancelToken: any): Promise<ToolResult> => {
      const start = performance.now();
      try {
        const out = raw.execute ? await raw.execute(args) : await raw.invoke(args, lease, cancelToken);
        return {
          toolCallId: (lease as any)?.toolCallId ?? "",
          name: handle,
          success: true,
          output: out,
          trustLevel: "verified",
          executionTimeMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolCallId: (lease as any)?.toolCallId ?? "",
          name: handle,
          success: false,
          output: err instanceof Error ? err.message : String(err),
          trustLevel: "unverified",
          executionTimeMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * ToolkitCatalogue - Registry and executor for tools.
 * 
 * Responsibilities:
 * - Tool registration and manifest generation (for Brain mounting)
 * - Parameter validation via Zod (strict)
 * - Execution with timeout and abort support
 * - Output fencing with `<result_trust_level="untrusted-data">`
 * - Observation projection (reflect) for context compaction
 * - Resource-class aware routing (A3: fail-closed GPU routing)
 * @public
 */
export class ToolkitCatalogue {
  private slots = new Map<string, ToolDefinition<Record<string, unknown>>>();
  private sink: EventSink;

  constructor(
    sinkOrTools?: EventSink | Array<ToolDefinition | any>,
    private sentinel?: ResourceSentinel,
  ) {
    if (Array.isArray(sinkOrTools)) {
      this.sink = { emit: () => {} };
      for (const t of sinkOrTools) {
        this.place(adaptToToolDefinition(t));
      }
    } else {
      this.sink = sinkOrTools ?? { emit: () => {} };
    }
  }

  /**
   * Register a tool in the catalogue.
   * Fail-closed validation: gpu-inference tools MUST have targetModelId.
   * @public
   */
  place<TArgs extends Record<string, unknown>>(
    tool: ToolDefinition<TArgs>,
  ): this {
    // A3: Fail-closed validation - gpu-inference tools MUST have targetModelId
    if (tool.resourceClass === "gpu-inference" && !tool.targetModelId) {
      throw new ToolInvocationError(
        `Tool ${tool.handle} requires resourceClass 'gpu-inference' but lacks targetModelId.`,
        "denied"
      );
    }
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
   * 3. Acquire concurrency leases (see gating policy below)
   * 4. Execute with timeout and abort signal
   * 5. Apply reflect projection if defined
   * 6. Fence output with `<result_trust_level="untrusted-data">`
   * 7. Truncate if exceeds SMART_LIMIT_BYTES
   *
   * Gating policy (audit fix - was: only local-sandbox + gpu-inference gated):
   * - Sentinel wired: EVERY resource class occupies a hands-gate slot
   *   (bounded total tool concurrency); gpu-inference tools additionally
   *   occupy their per-model brain gate. Acquisition order is globally
   *   consistent (hands then brain), so no hold-and-wait cycles are possible.
   * - No sentinel (degraded mode): only the fail-closed classes reject
   *   (local-sandbox, gpu-inference); the remaining classes run ungated.
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

    // A3 + audit fix: resource-class aware routing for ALL classes.
    const resClass = tool.resourceClass ?? "external-network";
    const toolClass = toolClassOf(resClass);
    const releases: Array<() => void> = [];

    try {
      if (this.sentinel) {
        // Bounded total tool concurrency for every resource class.
        releases.push(await this.sentinel.handsGate.acquire("normal", cancelToken));
        if (resClass === "gpu-inference") {
          if (!tool.targetModelId) {
            throw new ToolInvocationError(`Tool ${tool.handle} requires targetModelId for gpu-inference`, "denied");
          }
          // Consistent hands-before-brain acquisition order (deadlock-free).
          releases.push(
            await this.sentinel.brainGate(tool.targetModelId, undefined, this.sink).acquire("normal", cancelToken),
          );
        }
      } else {
        // Degraded mode: fail-closed classes still refuse to run ungated.
        if (resClass === "local-sandbox") {
          throw new ToolInvocationError("Sentinel required for local-sandbox tools", "denied");
        }
        if (resClass === "gpu-inference") {
          throw new ToolInvocationError("Sentinel required for gpu-inference tools", "denied");
        }
      }

      const startedAt = performance.now();
      try {
        // Execute with deadline guard (timeout + abort, no leaked timers)
        const raw = await this.guardDeadlines(
          () => tool.invoke(verified.data, lease, cancelToken),
          tool.timeoutMs ?? HARD_TOOL_CEILING_MS,
          cancelToken,
        );

        // Apply observation projection (reflect) for context compaction
        const inspectable = tool.reflect ? tool.reflect(raw) : raw;
        const serialized = typeof inspectable === "string"
          ? inspectable
          : JSON.stringify(inspectable, null, 2);

        // Fence output - neutralize fence tags over the FULL serialization
        // BEFORE truncating. The historical slice-then-strip order could cut
        // a fence tag at the byte boundary, leaving a live half-tag inside
        // the fenced body (a break-out vector).
        const stripped = serialized.replace(/<\/?result_trust_level[^>]*>/g, "");
        const truncated = stripped.length > SMART_LIMIT_BYTES;
        const safeBody = truncated ? stripped.slice(0, SMART_LIMIT_BYTES) : stripped;
        const truncatedNote = truncated
          ? `\n[Truncated ${stripped.length} -> ${SMART_LIMIT_BYTES} bytes.]`
          : "";

        const executionMs = performance.now() - startedAt;
        this.sink.emit(TOOL_METRICS.INVOCATIONS_TOTAL, {
          tool: tool.handle,
          [TOOL_LABEL_KEYS.TOOL_CLASS]: toolClass,
          ms: executionMs,
          bytes: serialized.length,
          truncated,
        });

        return {
          type: "ok",
          body: `<result_trust_level="untrusted-data" src="${tool.handle}">\n${safeBody}\n</result_trust_level>${truncatedNote}`,
        };

      } catch (err) {
        const executionMs = performance.now() - startedAt;

        // Aborts propagate: the dispatcher classifies them as PARTIAL
        // (operator kill switch / budget guard), not as tool failures.
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }

        const failure = err instanceof ToolInvocationError ? err : new ToolInvocationError(String(err), "execution");

        this.sink.emit(TOOL_METRICS.FAILURES_TOTAL, {
          tool: tool.handle,
          [TOOL_LABEL_KEYS.TOOL_CLASS]: toolClass,
          [TOOL_LABEL_KEYS.FAIL_CATEGORY]: failure.category,
          ms: executionMs,
        });

        return {
          type: "fail",
          body: `${failure.category.toUpperCase()} _ACTION HALTED_ :: ${failure.message}\nAssess whether alternative paths exist.`,
        };
      }
    } finally {
      for (const release of releases.reverse()) release();
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
        cancelToken,
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
   * Guard execution with a hard deadline and the external abort signal.
   *
   * Both guards are fully cleaned up when either side settles:
   * - the deadline timer is cleared (the historical implementation leaked one
   *   pending 30s Timeout per tool call), and
   * - the abort listener is removed.
   *
   * Aborts reject with a structural AbortError so callers can distinguish
   * cancellation (operator kill switch / budget guard) from tool failure.
   */
  private guardDeadlines<R>(
    fn: () => Promise<R>,
    ceilingMs: number,
    cancelToken: AbortSignal,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (cancelToken.aborted) {
        reject(makeAbortError());
        return;
      }

      let settled = false;
      const cleanup: Array<() => void> = [];
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        for (const fn of cleanup) fn();
        action();
      };

      const timer = setTimeout(
        () =>
          settle(() =>
            reject(new ToolInvocationError("exceeded sandbox lease period", "timeout")),
          ),
        ceilingMs,
      );
      const onAbort = () => settle(() => reject(makeAbortError()));
      cleanup.push(() => clearTimeout(timer));
      cleanup.push(() => cancelToken.removeEventListener("abort", onAbort));

      cancelToken.addEventListener("abort", onAbort, { once: true });

      fn().then(
        (value) => settle(() => resolve(value)),
        (err) => settle(() => reject(err)),
      );
    });
  }
}

/** Type alias for generic ZodType to avoid explicit any in generics. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZodType = ZodType<any, any, any>;

/**
 * Convert Zod schema to JSON Schema (conservative, OpenAPI 3 compatible).
 * Strips unsupported features for grammar compiler compatibility.
 * Accepts the structural Contract alias and casts to ZodType internally.
 *
 * v0.2: contracts that already carry a JSON Schema (MCP tools, via
 * jsonSchemaContract) project directly; non-Zod structural contracts
 * degrade to a permissive object schema instead of crashing the
 * manifest projection.
 * @public
 */
export function toJsonSchema(schema: Contract<unknown> | AnyZodType): JSONSchema7 {
  const direct = (schema as { jsonSchema?: JSONSchema7 }).jsonSchema;
  if (direct !== null && typeof direct === "object") return direct;
  try {
    return zodToJsonSchema(schema as AnyZodType, { target: "openApi3" }) as JSONSchema7;
  } catch {
    return { type: "object" };
  }
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