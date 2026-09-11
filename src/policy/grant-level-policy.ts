import type { GrantLevel } from "../core/types.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import type { PolicyDecision, PolicyRequest, ServerTrust, CapabilityPolicy } from "./types.js";

/**
 * Grant-level rank used for threshold comparison:
 * auto (0) < acknowledged (1) < acknowledged-privileged (2) < manual (3).
 * @public
 */
export const GRANT_LEVEL_RANK: Record<GrantLevel, number> = {
  auto: 0,
  acknowledged: 1,
  "acknowledged-privileged": 2,
  manual: 3,
};

/**
 * Server-trust rank used for threshold comparison:
 * official (3) > verified (2) > community (1) > unknown (0).
 * @public
 */
export const SERVER_TRUST_RANK: Record<ServerTrust, number> = {
  official: 3,
  verified: 2,
  community: 1,
  unknown: 0,
};

/**
 * Configuration for the default grant-level policy.
 * @public
 */
export interface GrantLevelPolicyConfig {
  /** Tool handles that bypass all requirements (explicit operator opt-in). */
  allowTools?: readonly string[];
  /** Tool handles that are always denied (explicit operator opt-out). */
  denyTools?: readonly string[];
  /**
   * Grant levels at or above this rank require approval.
   * Default: "acknowledged" (everything beyond auto-approve asks a human).
   */
  approvalThreshold?: GrantLevel;
  /**
   * Trust classification per serverId. Servers absent from this map are
   * treated as "unknown".
   */
  serverTrust?: Readonly<Record<string, ServerTrust>>;
  /**
   * Minimum server trust for non-native tools to run without approval.
   * Default: "verified" - community and unknown servers always ask.
   */
  minTrustForAuto?: ServerTrust;
}

/**
 * GrantLevelPolicy - the default deterministic policy.
 *
 * Decision order (first match wins):
 * 1. denylisted handle -> DENY
 * 2. allowlisted handle -> ALLOW
 * 3. non-native tool from a server below the trust floor -> REQUIRE_APPROVAL
 * 4. grant level at/above the approval threshold -> REQUIRE_APPROVAL
 *    (scope escalates to "privileged" at acknowledged-privileged and above)
 * 5. otherwise -> ALLOW
 *
 * Examples (defaults):
 * - Filesystem read (auto) -> ALLOW
 * - Filesystem write (acknowledged) -> approval, standard scope
 * - Git push / destructive tools (manual) -> approval, privileged scope
 * - Community-server tool with no grant metadata -> approval
 * @public
 */
export class GrantLevelPolicy implements CapabilityPolicy {
  private readonly allowTools: ReadonlySet<string>;
  private readonly denyTools: ReadonlySet<string>;
  private readonly approvalThreshold: GrantLevel;
  private readonly serverTrust: Readonly<Record<string, ServerTrust>>;
  private readonly minTrustForAuto: ServerTrust;

  constructor(config: GrantLevelPolicyConfig = {}) {
    this.allowTools = new Set(config.allowTools ?? []);
    this.denyTools = new Set(config.denyTools ?? []);
    this.approvalThreshold = config.approvalThreshold ?? "acknowledged";
    this.serverTrust = config.serverTrust ?? {};
    this.minTrustForAuto = config.minTrustForAuto ?? "verified";
  }

  /**
   * Evaluate one invocation request.
   * @public
   */
  evaluate(request: PolicyRequest): PolicyDecision {
    const { capability, toolCall } = request;

    if (this.denyTools.has(toolCall.name)) {
      return {
        type: "DENY",
        reason: `Tool '${toolCall.name}' is denylisted by operator policy.`,
      };
    }

    if (this.allowTools.has(toolCall.name)) {
      return { type: "ALLOW" };
    }

    const trust = this.trustOf(capability);
    if (capability.source !== "native" && SERVER_TRUST_RANK[trust] < SERVER_TRUST_RANK[this.minTrustForAuto]) {
      return {
        type: "REQUIRE_APPROVAL",
        reason:
          `Capability '${capability.id}' originates from server '${capability.serverId ?? "?"}' ` +
        `with trust '${trust}' (floor: '${this.minTrustForAuto}').`,
        scope: "standard",
      };
    }

    const grantLevel = capability.grantLevel ?? "auto";
    if (GRANT_LEVEL_RANK[grantLevel] >= GRANT_LEVEL_RANK[this.approvalThreshold]) {
      return {
        type: "REQUIRE_APPROVAL",
        reason:
          `Tool '${toolCall.name}' declares grant level '${grantLevel}' ` +
        `(threshold: '${this.approvalThreshold}').`,
        scope: GRANT_LEVEL_RANK[grantLevel] >= GRANT_LEVEL_RANK["acknowledged-privileged"] ? "privileged" : "standard",
      };
    }

    return { type: "ALLOW" };
  }

  private trustOf(capability: CapabilityDescriptor): ServerTrust {
    if (capability.source === "native") return "official";
    if (capability.serverId === undefined) return "unknown";
    return this.serverTrust[capability.serverId] ?? "unknown";
  }
}

/**
 * Create the default grant-level policy.
 * @public
 */
export function createGrantLevelPolicy(config: GrantLevelPolicyConfig = {}): GrantLevelPolicy {
  return new GrantLevelPolicy(config);
}

/**
 * CompositePolicy - evaluates a chain of policies.
 *
 * DENY short-circuits immediately; the first REQUIRE_APPROVAL wins; ALLOW
 * only if every policy allows. Ordering is the caller's governance choice
 * (typically: denylist, compliance, grant levels).
 * @public
 */
export class CompositePolicy implements CapabilityPolicy {
  private readonly policies: readonly CapabilityPolicy[];

  constructor(policies: readonly CapabilityPolicy[]) {
    this.policies = [...policies];
  }

  /**
   * Evaluate the chain against one request.
   * @public
   */
  evaluate(request: PolicyRequest): PolicyDecision {
    let sawApproval: PolicyDecision | undefined;
    for (const policy of this.policies) {
      const decision = policy.evaluate(request);
      if (decision.type === "DENY") return decision;
      if (decision.type === "REQUIRE_APPROVAL" && sawApproval === undefined) {
        sawApproval = decision;
      }
    }
    return sawApproval ?? { type: "ALLOW" };
  }
}

/**
 * Create a composite policy from a chain.
 * @public
 */
export function createCompositePolicy(policies: readonly CapabilityPolicy[]): CompositePolicy {
  return new CompositePolicy(policies);
}
