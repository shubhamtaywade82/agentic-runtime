import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "../../src/core/types.js";
import {
  CapabilityIndex,
  scoreCapabilities,
  tokenizeForSearch,
  DEFAULT_CAPABILITY_PRIORITY,
} from "../../src/capability/capability-index.js";
import {
  toolToCapability,
  capabilityId,
  type CapabilityDescriptor,
} from "../../src/capability/types.js";
import { CapabilityRouter } from "../../src/capability/router.js";
import {
  StaticCapabilitySelector,
  TopKCapabilitySelector,
} from "../../src/capability/selector.js";

const noopSink = { emit: () => {} };

function nativeTool(overrides: Partial<ToolDefinition<{ x: number }>> = {}): ToolDefinition<{ x: number }> {
  return {
    handle: "echo",
    caption: "echoes its input back",
    argsShape: z.object({ x: z.number() }),
    resourceClass: "external-network",
    effects: "pure",
    grantLevel: "auto",
    invoke: async () => ({
      toolCallId: "c1",
      name: "echo",
      success: true,
      output: "echoed",
      trustLevel: "unverified",
      executionTimeMs: 1,
    }),
    ...overrides,
  };
}

function descriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: "native:echo",
    name: "echo",
    description: "echoes its input back",
    kind: "tool",
    source: "native",
    ...overrides,
  };
}

describe("capabilityId + toolToCapability", () => {
  it("composes canonical ids per source", () => {
    expect(capabilityId("native", undefined, "echo")).toBe("native:echo");
    expect(capabilityId("mcp", "filesystem", "read_file")).toBe("mcp:filesystem:read_file");
  });

  it("projects native tool metadata losslessly for policy", () => {
    const tool = nativeTool({
      source: "mcp",
      serverId: "filesystem",
      version: "1.0.0",
      sideEffects: { filesystem: "read", network: "none" },
      discoverability: { keywords: ["file", "read"], category: "coding", priority: 80 },
      permissions: ["fs.read"],
    });
    const d = toolToCapability(tool);

    expect(d.id).toBe("mcp:filesystem:echo");
    expect(d.kind).toBe("tool");
    expect(d.source).toBe("mcp");
    expect(d.serverId).toBe("filesystem");
    expect(d.effects).toBe("pure");
    expect(d.resourceClass).toBe("external-network");
    expect(d.grantLevel).toBe("auto");
    expect(d.sideEffects).toEqual({ filesystem: "read", network: "none" });
    expect(d.discoverability?.keywords).toEqual(["file", "read"]);
    expect(d.permissions).toEqual(["fs.read"]);
  });

  it("defaults to native source when unspecified", () => {
    const d = toolToCapability(nativeTool());
    expect(d.source).toBe("native");
    expect(d.id).toBe("native:echo");
    expect(d.serverId).toBeUndefined();
    expect(d.sideEffects).toBeUndefined();
  });

  it("explicit opts override tool-declared provenance", () => {
    const tool = nativeTool({ source: "native" });
    const d = toolToCapability(tool, { source: "mcp", serverId: "git" });
    expect(d.source).toBe("mcp");
    expect(d.serverId).toBe("git");
    expect(d.id).toBe("mcp:git:echo");
  });
});

describe("tokenizeForSearch", () => {
  it("splits, lowercases, drops stop words and short tokens", () => {
    expect(tokenizeForSearch("The Quick-Brown fox42 a of")).toEqual(["quick", "brown", "fox42"]);
  });
});

describe("scoreCapabilities", () => {
  const tools: CapabilityDescriptor[] = [
    descriptor({ id: "native:read_file", name: "read_file", description: "reads a file from disk", discoverability: { keywords: ["file", "read", "disk"], category: "coding" } }),
    descriptor({ id: "native:web_search", name: "web_search", description: "searches the web", discoverability: { keywords: ["search", "web", "internet"], category: "web" } }),
    descriptor({ id: "native:sql", name: "sql_query", description: "runs a database query", discoverability: { keywords: ["database", "sql", "query"], category: "data" } }),
  ];

  it("ranks name and keyword matches above description matches", () => {
    const ranked = scoreCapabilities("search the web", tools);
    expect(ranked[0]?.descriptor.id).toBe("native:web_search");
    expect(ranked[0]?.matchedTerms).toContain("search");
    expect(ranked[0]?.matchedTerms).toContain("web");
  });

  it("excludes non-matching capabilities entirely", () => {
    const ranked = scoreCapabilities("database query", tools);
    expect(ranked.map((r) => r.descriptor.id)).toEqual(["native:sql"]);
  });

  it("prefix matches score half weight and still rank", () => {
    const ranked = scoreCapabilities("file", tools);
    expect(ranked[0]?.descriptor.id).toBe("native:read_file");
  });

  it("ties break deterministically by id", () => {
    const a = descriptor({ id: "native:b", name: "thing" });
    const b = descriptor({ id: "native:a", name: "thing" });
    const ranked = scoreCapabilities("thing", [a, b]);
    expect(ranked.map((r) => r.descriptor.id)).toEqual(["native:a", "native:b"]);
  });

  it("empty query falls back to priority ordering", () => {
    const pool = [
      descriptor({ id: "native:low", name: "x1", discoverability: { keywords: ["k"], priority: 10 } }),
      descriptor({ id: "native:high", name: "x2", discoverability: { keywords: ["k"], priority: 90 } }),
    ];
    const ranked = scoreCapabilities("", pool);
    expect(ranked[0]?.descriptor.id).toBe("native:high");
    expect(ranked[0]?.score).toBeCloseTo(0.9, 5);
  });

  it("unmatched priority does not leak zero-term capabilities into term queries", () => {
    const ranked = scoreCapabilities("zzz_nonexistent", tools);
    expect(ranked).toHaveLength(0);
  });
});

describe("CapabilityIndex", () => {
  it("registers, lists, filters, gets", () => {
    const index = new CapabilityIndex().register(
      descriptor({ id: "native:t", name: "t" }),
      descriptor({ id: "mcp:s:r", name: "r", kind: "resource", source: "mcp", serverId: "s" }),
      descriptor({ id: "mcp:s:p", name: "p", kind: "prompt", source: "mcp", serverId: "s" }),
    );
    expect(index.size).toBe(3);
    expect(index.list({ kinds: ["resource"] }).map((d) => d.id)).toEqual(["mcp:s:r"]);
    expect(index.list({ sources: ["mcp"] })).toHaveLength(2);
    expect(index.get("native:t")?.name).toBe("t");
  });

  it("fail-closed: duplicate ids throw", () => {
    const index = new CapabilityIndex().register(descriptor());
    expect(() => index.register(descriptor())).toThrowError(/already registered/);
  });

  it("unregisterServer removes exactly that server's descriptors", () => {
    const index = new CapabilityIndex().register(
      descriptor({ id: "mcp:s:r", source: "mcp", serverId: "s" }),
      descriptor({ id: "mcp:other:r", source: "mcp", serverId: "other" }),
      descriptor({ id: "native:t" }),
    );
    index.unregisterServer("s");
    expect(index.list().map((d) => d.id).sort()).toEqual(["mcp:other:r", "native:t"]);
  });

  it("search applies limit and kind filters", () => {
    const index = new CapabilityIndex().register(
      descriptor({ id: "native:file_read", name: "file_read", discoverability: { keywords: ["file"] } }),
      descriptor({ id: "native:file_write", name: "file_write", discoverability: { keywords: ["file"] } }),
      descriptor({ id: "native:web", name: "web_search", discoverability: { keywords: ["web"] } }),
    );
    const results = index.search("file", { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.descriptor.name).toBe("file_read");
  });

  it("default priority constant is 50", () => {
    expect(DEFAULT_CAPABILITY_PRIORITY).toBe(50);
  });
});

describe("CapabilityRouter", () => {
  it("registers native tools into catalogue + index + manifests atomically", () => {
    const router = new CapabilityRouter({ sink: noopSink });
    const registered = router.registerNativeTools([nativeTool()]);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.descriptor.id).toBe("native:echo");
    expect(router.getCatalogue().slotNames()).toEqual(["echo"]);
    expect(router.getIndex().size).toBe(1);
    expect(router.allManifests()).toHaveLength(1);
    expect(router.allManifests()[0]?.parametersJsonSchema).toBeDefined();
  });

  it("registered tool executes through the existing governed catalogue", async () => {
    const router = new CapabilityRouter({ sink: noopSink });
    router.registerNativeTools([nativeTool()]);
    const result = await router.getCatalogue().forwardIntent(
      { id: "c1", name: "echo", arguments: { x: 1 } },
      {
        tag: "test", leaseMs: 1000, maxResultBytes: 1000,
        auditTrailId: "a", canClobberDisc: false,
      },
      new AbortController().signal,
    );
    expect(result.type).toBe("ok");
    expect(result.body).toContain("untrusted-data");
  });

  it("registers adapted (mcp) tools with correct ids", () => {
    const router = new CapabilityRouter({ sink: noopSink });
    const registered = router.registerTools([nativeTool({ source: "mcp", serverId: "filesystem" })], "mcp", "filesystem");
    expect(registered[0]?.descriptor.id).toBe("mcp:filesystem:echo");
    expect(router.allManifests()[0]?.name).toBe("echo");
  });

  it("manifestsFor maps selector output to manifests and skips unknowns", () => {
    const router = new CapabilityRouter({ sink: noopSink });
    router.registerNativeTools([nativeTool()]);

    const manifests = router.manifestsFor({
      capabilities: [
        descriptor({ id: "native:echo" }),
        descriptor({ id: "native:ghost" }),
        descriptor({ id: "native:res", kind: "resource" }),
      ],
      rationale: "test",
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe("echo");
  });

  it("forgetServer drops that server's discovery surface only", () => {
    const router = new CapabilityRouter({ sink: noopSink });
    router.registerTools([nativeTool({ source: "mcp", serverId: "fs" })], "mcp", "fs");
    router.registerNativeTools([nativeTool({ handle: "calc", caption: "calculator" })]);

    router.forgetServer("fs");

    expect(router.getIndex().size).toBe(1);
    expect(router.allManifests().map((m) => m.name)).toEqual(["calc"]);
    // Catalogue keeps placed tools: dispatch-safe degradation.
    expect(router.getCatalogue().slotNames().sort()).toEqual(["calc", "echo"]);
  });

  it("propagates fail-closed catalogue validation (gpu-inference without targetModelId)", () => {
    const router = new CapabilityRouter({ sink: noopSink });
    expect(() =>
      router.registerNativeTools([nativeTool({ resourceClass: "gpu-inference" })]),
    ).toThrowError(/targetModelId/);
  });

  it("emits registration metric events", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const router = new CapabilityRouter({ sink: { emit: (name, payload) => events.push({ name, payload }) } });
    router.registerNativeTools([nativeTool()]);
    const registration = events.find((e) => e.name === "runtime_capability_registrations_total");
    expect(registration?.payload.source).toBe("native");
    expect(registration?.payload.kind).toBe("tool");
  });
});

describe("selectors", () => {
  const pool: CapabilityDescriptor[] = [
    descriptor({ id: "native:read_file", name: "read_file", description: "reads files", discoverability: { keywords: ["file", "read"] } }),
    descriptor({ id: "native:write_file", name: "write_file", description: "writes files", discoverability: { keywords: ["file", "write"] } }),
    descriptor({ id: "native:web_fetch", name: "web_fetch", description: "fetches urls", discoverability: { keywords: ["web", "url", "http"] } }),
    descriptor({ id: "mcp:git:status", name: "git_status", source: "mcp", serverId: "git", description: "git repository status", discoverability: { keywords: ["git", "repo"] } }),
    descriptor({ id: "mcp:fs:list", name: "list_directory", kind: "resource", source: "mcp", serverId: "fs", description: "lists directories" }),
  ];

  it("StaticCapabilitySelector mounts every tool-kind capability", async () => {
    const selector = new StaticCapabilitySelector();
    const mounted = await selector.select({ objective: "anything", context: [], available: pool });
    expect(mounted.capabilities).toHaveLength(4); // excludes the resource
    expect(mounted.rationale).toContain("static");
  });

  it("TopKCapabilitySelector ranks and limits by objective + lane tail", async () => {
    const selector = new TopKCapabilitySelector({ limit: 2 });
    const mounted = await selector.select({
      objective: "read the file and check git status",
      context: [
        { role: "user", content: "please use file tools" },
        { role: "assistant", content: "I will inspect the repository." },
      ],
      available: pool,
    });
    expect(mounted.capabilities).toHaveLength(2);
    const names = mounted.capabilities.map((c) => c.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("list_directory");
    expect(mounted.rationale).toContain("topk");
  });

  it("TopK with limit above pool size mounts all matching tools", async () => {
    const selector = new TopKCapabilitySelector({ limit: 10, kinds: ["tool", "resource"] });
    const mounted = await selector.select({
      objective: "file git web",
      context: [],
      available: [
        ...pool.slice(0, 4),
        descriptor({ id: "mcp:fs:list", name: "list_directory", kind: "resource", source: "mcp", serverId: "fs", description: "lists directories", discoverability: { keywords: ["file", "directory"] } }),
      ],
    });
    expect(mounted.capabilities.length).toBe(5);
  });

  it("selectors are deterministic across calls", async () => {
    const selector = new TopKCapabilitySelector({ limit: 3 });
    const input = { objective: "file operations", context: [] as const, available: pool };
    const a = await selector.select(input);
    const b = await selector.select(input);
    expect(a.capabilities.map((c) => c.id)).toEqual(b.capabilities.map((c) => c.id));
  });
});
