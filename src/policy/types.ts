import type { CapabilityDescriptor } from "../capability/types.js";
import type { ToolCallRequest } from "../core/types.js";

/**
 * Trust classification for capability servers. Native tools are trusted by
 * construction (they were compiled into the host application); remote tools
 * carry the trust of their server.
 * @public
 */
export const SERVER_TRUST_LEVELS = ["official", "verified", "community", "unknown"] as const;

/** @public */
export type ServerTrust = (typeof SERVER_TRUST_LEVELS)[number];

/**
 * Scope of human approval demanded before execution proceeds.
 * - "standard": one human ack is enough.
 * - "privileged": destructive/privileged surface; the approver should
 *   understand the blast radius (production mutations, destructive fs ops).
 * @public
 */
export const APPROVAL_SCOPES = ["standard", "privileged"] as const;

/** @public */
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * The decision a policy renders for one capability invocation.
 *
 * - ALLOW: dispatch without human involvement.
 * - DENY: never dispatch; the denial reason is fed back to the model as a
 *   governance message so it can pivot.
 * - REQUIRE_APPROVAL: dispatch only after the approval provider confirms.
 * @public
 */
export type PolicyDecision =
  | { type: "ALLOW" }
  | { type: "DENY"; reason: string }
  | { type: "REQUIRE_APPROVAL"; reason: string; scope: ApprovalScope };

/**
 * Everything a policy may inspect for one invocation. The capability
 * descriptor is always available (native tools are projected on the fly),
 * so policies never need to know whether a tool is native or MCP.
 * @public
 */
export interface PolicyRequest {
  capability: CapabilityDescriptor;
  /** The concrete tool call the model emitted (name + arguments). */
  toolCall: ToolCallRequest;
  objective: string;
  stepIndex: number;
  /** How many prior policy denials the model already received this run. */
  previousDenials: number;
}

/**
 * CapabilityPolicy - the deterministic trust boundary for dispatch.
 *
 * Evaluated before every tool dispatch in the agent loop. Implementations
 * must be synchronous, pure and fast: no LLM calls, no network. Anything
 * requiring a human is expressed as REQUIRE_APPROVAL and resolved by the
 * (async) approval provider, not by the policy itself.
 * @public
 */
export interface CapabilityPolicy {
  evaluate(request: PolicyRequest): PolicyDecision;
}

/**
 * Always allow - the v0.1-compatible no-op policy.
 * @public
 */
export class AllowAllPolicy implements CapabilityPolicy {
  /**
   * Evaluate: ALLOW.
   * @public
   */
  evaluate(): PolicyDecision {
    return { type: "ALLOW" };
  }
}

/**
 * Create a policy from a bare evaluate function.
 * @public
 */
export function createCapabilityPolicy(
  evaluate: (request: PolicyRequest) => PolicyDecision,
): CapabilityPolicy {
  return { evaluate };
}
