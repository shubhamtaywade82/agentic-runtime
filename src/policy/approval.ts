import { AgentRuntimeError } from "../core/types.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import type { ApprovalScope } from "./types.js";

/**
 * A human-approval request raised by a REQUIRE_APPROVAL policy decision.
 * @public
 */
export interface ApprovalRequest {
  capability: CapabilityDescriptor;
  reason: string;
  scope: ApprovalScope;
  objective: string;
  stepIndex: number;
}

/**
 * The human's answer.
 * @public
 */
export interface ApprovalResult {
  approved: boolean;
  /** Optional note fed back to the model on denial (guidance for pivoting). */
  note?: string;
}

/**
 * ApprovalProvider - the human-in-the-loop boundary.
 *
 * Implementations may prompt a CLI user, open a web approval dialog, page
 * an on-call operator, or auto-approve in sandboxed deployments. Approval
 * is async by nature; the agent loop awaits it with a timeout and treats
 * timeouts as denials (fail-closed).
 * @public
 */
export interface ApprovalProvider {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}

/**
 * Wrap a plain async function as an ApprovalProvider.
 * @public
 */
export function createApprovalProvider(
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalResult>,
): ApprovalProvider {
  return { requestApproval };
}

/**
 * Approve everything (sandboxed demos / tests only).
 * @public
 */
export function autoApprove(): ApprovalProvider {
  return {
    async requestApproval(): Promise<ApprovalResult> {
      return { approved: true };
    },
  };
}

/**
 * Deny everything (dry-run mode: every gated tool call is refused).
 * @public
 */
export function autoDeny(note?: string): ApprovalProvider {
  return {
    async requestApproval(): Promise<ApprovalResult> {
      return { approved: false, note: note ?? "Operator denied all approvals (dry-run policy)." };
    },
  };
}

/**
 * Error thrown when an approval provider misbehaves (throws or returns a
 * malformed result). Treated as denial upstream - fail-closed.
 * @public
 */
export class ApprovalProviderError extends AgentRuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "APPROVAL_PROVIDER_ERROR", cause);
    this.name = "ApprovalProviderError";
  }
}

/**
 * Race an approval request against a timeout. Timeouts resolve to denial
 * (fail-closed) rather than rejecting, so the loop can feed the reason
 * back to the model instead of crashing the run.
 * @public
 */
export async function requestApprovalWithTimeout(
  provider: ApprovalProvider,
  request: ApprovalRequest,
  timeoutMs: number,
): Promise<ApprovalResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ApprovalResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            approved: false,
            note: `Approval timed out after ${timeoutMs}ms (fail-closed denial).`,
          }),
        timeoutMs,
      );
    });

    const answer = await Promise.race([
      safeRequest(provider, request),
      timeout,
    ]);
    return answer;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function safeRequest(
  provider: ApprovalProvider,
  request: ApprovalRequest,
): Promise<ApprovalResult> {
  try {
    const result = await provider.requestApproval(request);
    if (typeof result?.approved === "boolean") return result;
    throw new ApprovalProviderError("Approval provider returned a malformed result.");
  } catch (err) {
    if (err instanceof ApprovalProviderError) throw err;
    throw new ApprovalProviderError(
      `Approval provider threw: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
