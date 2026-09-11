import { ToolkitCatalogue, createTestLease } from "./catalogue.js";
import { ToolInvocationError } from "./catalogue.js";
import type {
  ToolCallRequest,
  SandboxLease,
  ContractOutcome,
} from "../core/types.js";
import { TransportFailure, isGateAbortedError, isGateSaturatedError } from "../core/types.js";

/**
 * Certified contract envelope for execution.
 * @public
 */
export interface CertifiedContractEnvelope {
  intent: ToolCallRequest;
  lease: SandboxLease;
  certifiedAt: number;
  attempt: number;
}

/**
 * ToolDispatcher - Executes validated tool intents against the Hands layer.
 * 
 * Hardens against:
 * - Transport severances (SDK transport drops)
 * - Localized aborts (budget exhaustion, operator kill-switch)
 * - Sandbox panics
 * 
 * Ensures failures in the hands layer never crash the main agentic loop,
 * instead returning a structured ContractOutcome that the loop can reason over.
 * @public
 */
export class ToolDispatcher {
  constructor(
    public readonly catalogue: ToolkitCatalogue,
    private globalKillSwitch: AbortSignal = new AbortController().signal,
  ) {}

  /**
   * Execute a validated tool intent.
   * @public
   */
  async executeIntent(envelope: CertifiedContractEnvelope): Promise<ContractOutcome> {
    const { intent, lease } = envelope;
    const startTime = performance.now();

    // Localized AbortController for this specific tool execution
    // Allows runtime to cancel this specific tool without killing the entire LLM thought process
    const toolAbort = new AbortController();
    
    // D4: Fast-path check - if globalKillSwitch already aborted before registration,
    // the event listener would never fire. Abort immediately with the same reason.
    const onGlobalAbort = () => toolAbort.abort(this.globalKillSwitch.reason);
    if (this.globalKillSwitch.aborted) {
      toolAbort.abort(this.globalKillSwitch.reason);
    } else {
      this.globalKillSwitch.addEventListener("abort", onGlobalAbort, { once: true });
    }

    try {
      // Dispatch to the Hands layer (handles Zod validation, timeouts, output fencing)
      const result = await this.catalogue.forwardIntent(intent, lease, toolAbort.signal);
      const executionMs = performance.now() - startTime;

      if (result.type === "ok") {
        return {
          status: "SUCCESS",
          payload: result.body, // Fenced with <result_trust_level="untrusted-data">
          telemetry: { executionMs, bytesTransferred: result.body.length },
        };
      } else {
        // ToolFailure (validation, execution, timeout, denied, unknown_tool)
        return {
          status: "FAILURE",
          payload: result.body,
          telemetry: { executionMs, bytesTransferred: 0 },
        };
      }
    } catch (err) {
      const executionMs = performance.now() - startTime;

      // 1. Handle Gate Aborted (operator cancel)
      if (isGateAbortedError(err)) {
        return {
          status: "PARTIAL",
          payload: `EXECUTION_ABORTED: Compute lease revoked (${err.message}).`,
          telemetry: { executionMs, bytesTransferred: 0 },
        };
      }

      // 2. Handle Gate Saturation (GPU saturated)
      if (isGateSaturatedError(err)) {
        return {
          status: "FAILURE",
          payload: `RESOURCE_SATURATION: ${err.message}. Reconsider scope or reduce fanout concurrency.`,
          telemetry: { executionMs, bytesTransferred: 0 },
        };
      }

      // 3. Handle SDK-level Transport Failures (e.g., Ollama node died mid-execution)
      if (err instanceof TransportFailure) {
        return {
          status: "FAILURE",
          payload: `TRANSPORT_SEVERANCE: The inference node or external dependency became unreachable (${err.message}). Pivot to fallback or halt.`,
          telemetry: { executionMs, bytesTransferred: 0 },
        };
      }

      // 4. Handle Execution Abort (Budget exhausted or Operator kill-switch)
      if (err instanceof Error && err.name === "AbortError") {
        return {
          status: "PARTIAL",
          payload: `EXECUTION_ABORTED: Tool call forcibly terminated by runtime budget or operator kill-switch. State may be partially mutated if tool lacked transactional rollback.`,
          telemetry: { executionMs, bytesTransferred: 0 },
        };
      }

      // 5. Handle categorized tool invocations that escape the catalogue
      // boundary (e.g. sentinel-missing 'denied' errors thrown during gate
      // acquisition). Historically these fell through to the sandbox-panic
      // catch-all and the category metadata was destroyed.
      if (err instanceof ToolInvocationError ||
          (err instanceof Error && err.name === "ToolInvocationError")) {
        const category = (err as ToolInvocationError).category ?? "execution";
        return {
          status: "FAILURE",
          payload: `TOOL_${category.toUpperCase()}: ${(err as Error).message}`,
          telemetry: { executionMs, bytesTransferred: 0 },
        };
      }

      // 6. Catch-all for sandbox panics
      return {
        status: "FAILURE",
        payload: `SANDBOX_PANIC: Unhandled exception in tool execution boundary: ${err instanceof Error ? err.message : String(err)}`,
        telemetry: { executionMs, bytesTransferred: 0 },
      };
    } finally {
      this.globalKillSwitch.removeEventListener("abort", onGlobalAbort);
    }
  }

  /**
   * Validate intent arguments against tool schema (pre-flight check).
   * @public
   */
  validateIntent(intent: ToolCallRequest): { valid: boolean; error?: string } {
    const tool = this.catalogue.get(intent.name);
    if (!tool) {
      return { valid: false, error: `Unknown tool: ${intent.name}` };
    }

    const verified = tool.argsShape.safeParse(intent.arguments);
    if (!verified.success) {
      const issues = (verified as { error: { issues: Array<{ path: (string | number)[]; message: string }> } }).error.issues;
      return { 
        valid: false, 
        error: issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") 
      };
    }

    return { valid: true };
  }
}

/**
 * Create a certified envelope for testing.
 * @public
 */
export function createCertifiedEnvelope(
  intent: ToolCallRequest,
  overrides: Partial<CertifiedContractEnvelope> = {},
): CertifiedContractEnvelope {
  return {
    intent,
    lease: createTestLease(),
    certifiedAt: Date.now(),
    attempt: 1,
    ...overrides,
  };
}