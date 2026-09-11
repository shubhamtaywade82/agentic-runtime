import { describe, it, expect } from "vitest";
import type { ToolCallRequest } from "../../src/core/types.js";
import { toolToCapability } from "../../src/capability/types.js";
import type { CapabilityDescriptor } from "../../src/capability/types.js";
import {
  AllowAllPolicy,
  createCapabilityPolicy,
} from "../../src/policy/types.js";
import {
  GrantLevelPolicy,
  CompositePolicy,
  createGrantLevelPolicy,
  GRANT_LEVEL_RANK,
  SERVER_TRUST_RANK,
} from "../../src/policy/grant-level-policy.js";
import {
  autoApprove,
  autoDeny,
  createApprovalProvider,
  requestApprovalWithTimeout,
  ApprovalProviderError,
  type ApprovalRequest,
  type ApprovalResult,
} from "../../src/policy/approval.js";

function request(
  capability: Partial<CapabilityDescriptor> & { name: string },
  overrides: Partial<{ toolCall: ToolCallRequest; objective: string; stepIndex: number; previousDenials: number }> = {},
) {
  const descriptor: CapabilityDescriptor = {
    id: `native:${capability.name}`,
    description: "test capability",
    kind: "tool",
    source: "native",
    ...capability,
  };
  return {
    capability: descriptor,
    toolCall: overrides.toolCall ?? { id: "c1", name: capability.name, arguments: {} },
    objective: overrides.objective ?? "test objective",
    stepIndex: overrides.stepIndex ?? 0,
    previousDenials: overrides.previousDenials ?? 0,
  };
}

function approvalRequest(scope: "standard" | "privileged" = "standard"): ApprovalRequest {
  return {
    capability: request({ name: "x" }).capability,
    reason: "r",
    scope,
    objective: "o",
    stepIndex: 0,
  };
}

describe("GrantLevelPolicy", () => {
  it("default mapping: auto allows, acknowledged+ asks, manual escalates scope", () => {
    const policy = new GrantLevelPolicy();

    const auto = policy.evaluate(request({ name: "read", grantLevel: "auto" }));
    expect(auto.type).toBe("ALLOW");

    const acknowledged = policy.evaluate(request({ name: "write", grantLevel: "acknowledged" }));
    expect(acknowledged.type).toBe("REQUIRE_APPROVAL");
    expect(acknowledged).toMatchObject({ scope: "standard" });

    const privileged = policy.evaluate(request({ name: "deploy", grantLevel: "acknowledged-privileged" }));
    expect(privileged.type).toBe("REQUIRE_APPROVAL");
    expect(privileged).toMatchObject({ scope: "privileged" });

    const manual = policy.evaluate(request({ name: "drop_db", grantLevel: "manual" }));
    expect(manual.type).toBe("REQUIRE_APPROVAL");
    expect(manual).toMatchObject({ scope: "privileged", reason: expect.stringContaining("manual") });
  });

  it("denylist wins over everything, allowlist bypasses grant levels", () => {
    const policy = new GrantLevelPolicy({
      denyTools: ["rm_rf"],
      allowTools: ["trusted_write"],
    });

    const denied = policy.evaluate(request({ name: "rm_rf", grantLevel: "auto" }));
    expect(denied).toMatchObject({ type: "DENY", reason: expect.stringContaining("denylisted") });

    const allowed = policy.evaluate(request({ name: "trusted_write", grantLevel: "manual" }));
    expect(allowed.type).toBe("ALLOW");
  });

  it("non-native tools below the trust floor require approval", () => {
    const policy = new GrantLevelPolicy({
      serverTrust: { communityServer: "community", officialServer: "official" },
    });

    const community = policy.evaluate(
      request({ name: "spotify_play", source: "mcp", serverId: "communityServer", grantLevel: "auto" }),
    );
    expect(community.type).toBe("REQUIRE_APPROVAL");
    expect(community.reason).toContain("community");

    const official = policy.evaluate(
      request({ name: "fs_read", source: "mcp", serverId: "officialServer", grantLevel: "auto" }),
    );
    expect(official.type).toBe("ALLOW");
  });

  it("servers missing from the trust map are unknown -> gated", () => {
    const policy = new GrantLevelPolicy();
    const unknown = policy.evaluate(
      request({ name: "mystery", source: "mcp", serverId: "mystery-server", grantLevel: "auto" }),
    );
    expect(unknown.type).toBe("REQUIRE_APPROVAL");
    expect(unknown.reason).toContain("unknown");
  });

  it("trust floor is configurable (community trusted explicitly)", () => {
    const policy = new GrantLevelPolicy({
      minTrustForAuto: "community",
      serverTrust: { local: "community" },
    });
    const decision = policy.evaluate(
      request({ name: "docker_ps", source: "mcp", serverId: "local", grantLevel: "auto" }),
    );
    expect(decision.type).toBe("ALLOW");
  });

  it("native tools are exempt from server-trust gating", () => {
    const policy = new GrantLevelPolicy();
    const decision = policy.evaluate(request({ name: "local_calc", source: "native", grantLevel: "auto" }));
    expect(decision.type).toBe("ALLOW");
  });

  it("approval threshold is configurable", () => {
    const policy = new GrantLevelPolicy({ approvalThreshold: "manual" });
    expect(policy.evaluate(request({ name: "w", grantLevel: "acknowledged" })).type).toBe("ALLOW");
    expect(policy.evaluate(request({ name: "w", grantLevel: "manual" })).type).toBe("REQUIRE_APPROVAL");
  });

  it("missing grantLevel defaults to auto", () => {
    const policy = new GrantLevelPolicy();
    const descriptor = toolToCapability({
      handle: "nogrant",
      caption: "no grant metadata",
      argsShape: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      resourceClass: "local-cpu",
      effects: "pure",
      grantLevel: "auto",
      invoke: async () => ({ toolCallId: "t", name: "nogrant", success: true, output: null, trustLevel: "unverified", executionTimeMs: 1 }),
    });
    const decision = policy.evaluate({
      capability: descriptor,
      toolCall: { id: "c", name: "nogrant", arguments: {} },
      objective: "o",
      stepIndex: 0,
      previousDenials: 0,
    });
    expect(decision.type).toBe("ALLOW");
  });
});

describe("CompositePolicy", () => {
  it("first REQUIRE_APPROVAL wins over later ones", () => {
    const policy = new CompositePolicy([
      createCapabilityPolicy(() => ({ type: "REQUIRE_APPROVAL", reason: "first", scope: "standard" as const })),
      createCapabilityPolicy(() => ({ type: "REQUIRE_APPROVAL", reason: "second", scope: "privileged" as const })),
    ]);
    expect(policy.evaluate(request({ name: "x" }))).toMatchObject({ type: "REQUIRE_APPROVAL", reason: "first" });
  });

  it("any DENY in the chain wins (fail-closed), even after an approval demand", () => {
    const policy = new CompositePolicy([
      createCapabilityPolicy(() => ({ type: "REQUIRE_APPROVAL", reason: "asks", scope: "standard" as const })),
      createCapabilityPolicy(() => ({ type: "DENY", reason: "no" })),
    ]);
    expect(policy.evaluate(request({ name: "x" }))).toMatchObject({ type: "DENY", reason: "no" });
  });

  it("ALLOW only when every policy allows", () => {
    const allowing = new CompositePolicy([
      new AllowAllPolicy(),
      new GrantLevelPolicy(),
    ]);
    expect(allowing.evaluate(request({ name: "auto_tool", grantLevel: "auto" })).type).toBe("ALLOW");
  });
});

describe("approval providers", () => {
  it("autoApprove / autoDeny / createApprovalProvider round-trips", async () => {
    expect(await autoApprove().requestApproval(approvalRequest())).toMatchObject({ approved: true });

    expect(await autoDeny().requestApproval(approvalRequest())).toMatchObject({ approved: false });

    const provider = createApprovalProvider(async (req) => ({
      approved: req.scope === "standard",
      note: `saw scope ${req.scope}`,
    }));
    const standard = await provider.requestApproval(approvalRequest());
    expect(standard).toMatchObject({ approved: true, note: "saw scope standard" });
  });

  it("requestApprovalWithTimeout denies on timeout (fail-closed) and clears the timer", async () => {
    const slow = createApprovalProvider(
      () => new Promise<ApprovalResult>(() => {}),
    );
    const result = await requestApprovalWithTimeout(slow, approvalRequest(), 30);
    expect(result.approved).toBe(false);
    expect(result.note).toContain("timed out");
  });

  it("provider throws surface as ApprovalProviderError", async () => {
    const boom = createApprovalProvider(async () => {
      throw new Error("ui crashed");
    });
    await expect(
      requestApprovalWithTimeout(boom, approvalRequest(), 1000),
    ).rejects.toBeInstanceOf(ApprovalProviderError);
  });

  it("fast answers beat the timeout", async () => {
    const result = await requestApprovalWithTimeout(autoApprove(), approvalRequest(), 1000);
    expect(result.approved).toBe(true);
  });
});

describe("rank tables", () => {
  it("grant and trust ranks are total orders", () => {
    expect(GRANT_LEVEL_RANK.auto).toBeLessThan(GRANT_LEVEL_RANK.acknowledged);
    expect(GRANT_LEVEL_RANK.acknowledged).toBeLessThan(GRANT_LEVEL_RANK["acknowledged-privileged"]);
    expect(GRANT_LEVEL_RANK["acknowledged-privileged"]).toBeLessThan(GRANT_LEVEL_RANK.manual);
    expect(SERVER_TRUST_RANK.official).toBeGreaterThan(SERVER_TRUST_RANK.verified);
    expect(SERVER_TRUST_RANK.verified).toBeGreaterThan(SERVER_TRUST_RANK.community);
    expect(SERVER_TRUST_RANK.community).toBeGreaterThan(SERVER_TRUST_RANK.unknown);
  });
});

describe("factories", () => {
  it("createGrantLevelPolicy returns a working policy", () => {
    const policy = createGrantLevelPolicy({ denyTools: ["never"] });
    expect(policy.evaluate(request({ name: "never" })).type).toBe("DENY");
  });
});
