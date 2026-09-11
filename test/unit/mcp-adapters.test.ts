import { describe, it, expect } from "vitest";
import { jsonSchemaContract } from "../../src/mcp/schema-contract.js";
import {
  mcpToolsToToolDefinitions,
  extractMcpOutput,
  resourceClassForMcpTool,
  grantLevelForMcpTool,
} from "../../src/mcp/adapters.js";
import { McpClient } from "../../src/mcp/client.js";
import { createLoopbackTransport, fakeMcpServerHandler } from "./mcp-loopback.js";
import { ToolkitCatalogue, createTestLease } from "../../src/hands/catalogue.js";
import { McpServerRegistry } from "../../src/mcp/registry.js";
import { CapabilityRouter } from "../../src/capability/router.js";
import { ProgressiveDiscovery } from "../../src/mcp/progressive-discovery.js";
import { McpConfigError } from "../../src/mcp/errors.js";
import { TopKCapabilitySelector } from "../../src/capability/selector.js";
import type { McpServerSideEffectsDeclaration, McpTool } from "../../src/mcp/types.js";
import { CONSERVATIVE_SIDE_EFFECTS } from "../../src/mcp/types.js";

const noopSink = { emit: () => {} };

const fsTool: McpTool = {
  name: "read_file",
  description: "Reads a file from the allowed directories",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  annotations: { readOnlyHint: true },
};

const destructiveTool: McpTool = {
  name: "delete_file",
  description: "Deletes a file permanently",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  annotations: { destructiveHint: true },
};

const fsSideEffects: McpServerSideEffectsDeclaration = {
  network: false,
  filesystem: true,
  process: false,
  database: false,
  externalMutation: false,
};

describe("jsonSchemaContract", () => {
  const contract = jsonSchemaContract(fsTool.inputSchema);

  it("accepts valid arguments and passes them through", () => {
    const result = contract.safeParse({ path: "/tmp/x" });
    expect(result).toMatchObject({ success: true, data: { path: "/tmp/x" } });
  });

  it("rejects missing required properties with zod-shaped issues", () => {
    const result = contract.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({ path: ["path"], message: expect.stringContaining("required") });
    }
  });

  it("rejects wrong types with path + message", () => {
    const result = contract.safeParse({ path: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("expected string");
    }
  });

  it("validates nested objects, arrays, enums and additionalProperties:false", () => {
    const nested = jsonSchemaContract({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { kind: { type: "string", enum: ["file", "dir"] } },
          required: ["kind"],
          additionalProperties: false,
        },
        tags: { type: "array", items: { type: "string" } },
        count: { type: "integer" },
      },
      required: ["filter", "tags"],
    });

    expect(nested.safeParse({ filter: { kind: "file" }, tags: ["a"], count: 3 }).success).toBe(true);
    expect(nested.safeParse({ filter: { kind: "bin" }, tags: [] }).success).toBe(false);
    expect(nested.safeParse({ filter: { kind: "file", extra: 1 }, tags: [] }).success).toBe(false);
    expect(nested.safeParse({ filter: { kind: "file" }, tags: [1] }).success).toBe(false);
    expect(nested.safeParse({ filter: { kind: "file" }, tags: [], count: 1.5 }).success).toBe(false);
  });

  it("a missing schema yields a permissive pass-through contract", () => {
    const permissive = jsonSchemaContract(undefined);
    expect(permissive.safeParse({ anything: true }).success).toBe(true);
  });

  it("non-object arguments are rejected (matches brain coercion guarantees)", () => {
    expect(contract.safeParse("nope").success).toBe(false);
    expect(contract.safeParse([1]).success).toBe(false);
  });
});

describe("mcp adapter mappings", () => {
  it("resource class follows side-effect precedence and readOnlyHint", () => {
    expect(resourceClassForMcpTool(fsSideEffects, { readOnlyHint: true })).toBe("filesystem-read");
    expect(resourceClassForMcpTool(fsSideEffects, undefined)).toBe("filesystem-write");
    expect(resourceClassForMcpTool(CONSERVATIVE_SIDE_EFFECTS, undefined)).toBe("external-network");
    expect(
      resourceClassForMcpTool({ network: false, filesystem: false, process: true, database: false, externalMutation: false }, undefined),
    ).toBe("local-sandbox");
    expect(
      resourceClassForMcpTool({ network: false, filesystem: false, process: false, database: true, externalMutation: true }, undefined),
    ).toBe("external-database");
    expect(
      resourceClassForMcpTool({ network: false, filesystem: false, process: false, database: false, externalMutation: false }, undefined),
    ).toBe("local-cpu");
  });

  it("grant level escalates on destructive hints, rewards verified read-only", () => {
    expect(grantLevelForMcpTool({ destructiveHint: true }, "official")).toBe("manual");
    expect(grantLevelForMcpTool({ readOnlyHint: true }, "verified")).toBe("auto");
    expect(grantLevelForMcpTool({ readOnlyHint: true }, "community")).toBe("acknowledged");
    expect(grantLevelForMcpTool(undefined, "official")).toBe("acknowledged");
  });

  it("extractMcpOutput flattens text, structured and binary placeholders", () => {
    expect(extractMcpOutput([{ type: "text", text: "a" }, { type: "text", text: "b" }], undefined)).toBe("a\nb");
    expect(extractMcpOutput([], { rows: 3 })).toEqual({ rows: 3 });
    expect(extractMcpOutput([{ type: "image", data: "x", mimeType: "image/png" }], undefined)).toBe("[image image/png]");
    expect(
      extractMcpOutput(
        [{ type: "text", text: "hello" }, { type: "resource_link", uri: "file:///x" }],
        undefined,
      ),
    ).toContain("hello");
  });
});

describe("mcpToolsToToolDefinitions", () => {
  async function makeClient(tools: McpTool[]) {
    const transport = createLoopbackTransport(fakeMcpServerHandler({ tools }));
    const client = new McpClient({ serverId: "filesystem", transport });
    await client.connect();
    return client;
  }

  it("adapts tools into governed ToolDefinitions with metadata", async () => {
    const client = await makeClient([fsTool, destructiveTool]);
    const defs = mcpToolsToToolDefinitions([fsTool, destructiveTool], {
      serverId: "filesystem",
      client,
      trust: "official",
      sideEffects: fsSideEffects,
      serverVersion: "1.2.3",
    });

    const read = defs[0];
    expect(read?.handle).toBe("filesystem__read_file");
    expect(read?.caption).toContain("Reads a file");
    expect(read?.resourceClass).toBe("filesystem-read");
    expect(read?.effects).toBe("pure");
    expect(read?.grantLevel).toBe("auto");
    expect(read?.source).toBe("mcp");
    expect(read?.serverId).toBe("filesystem");
    expect(read?.version).toBe("1.2.3");
    expect(read?.sideEffects?.filesystem).toBe("read");
    expect(read?.discoverability?.keywords).toContain("read_file");

    const del = defs[1];
    expect(del?.handle).toBe("filesystem__delete_file");
    expect(del?.resourceClass).toBe("filesystem-write");
    expect(del?.effects).toBe("transactional");
    expect(del?.grantLevel).toBe("manual");
  });

  it("custom and raw prefixes are honored", async () => {
    const client = await makeClient([fsTool]);
    const custom = mcpToolsToToolDefinitions([fsTool], {
      serverId: "fs",
      client,
      trust: "verified",
      sideEffects: fsSideEffects,
      toolNamePrefix: "myfs.",
    });
    const raw = mcpToolsToToolDefinitions([fsTool], {
      serverId: "fs",
      client,
      trust: "verified",
      sideEffects: fsSideEffects,
      toolNamePrefix: null,
    });
    expect(custom[0]?.handle).toBe("myfs.read_file");
    expect(raw[0]?.handle).toBe("read_file");
  });

  it("adapted tools execute end-to-end through the governed catalogue (validation + fencing)", async () => {
    const transport = createLoopbackTransport(fakeMcpServerHandler({ tools: [fsTool] }));
    const client = new McpClient({ serverId: "filesystem", transport });
    await client.connect();

    const defs = mcpToolsToToolDefinitions([fsTool], {
      serverId: "filesystem",
      client,
      trust: "verified",
      sideEffects: fsSideEffects,
    });
    const catalogue = new ToolkitCatalogue(noopSink).place(defs[0]!);

    const ok = await catalogue.forwardIntent(
      { id: "c1", name: "filesystem__read_file", arguments: { path: "/etc/hosts" } },
      createTestLease(),
      new AbortController().signal,
    );
    expect(ok.type).toBe("ok");
    expect(ok.body).toContain("untrusted-data");
    expect(ok.body).toContain("read_file");

    // Invalid arguments produce structured validation feedback for the model.
    const bad = await catalogue.forwardIntent(
      { id: "c2", name: "filesystem__read_file", arguments: { path: 123 } },
      createTestLease(),
      new AbortController().signal,
    );
    expect(bad.type).toBe("fail");
    expect(bad.body).toContain("Argument credential rejection");
    expect(bad.body).toContain("expected string");
  });

  it("server-side isError maps to a failed ToolResult, protocol errors to execution failures", async () => {
    const failing = createLoopbackTransport(
      fakeMcpServerHandler({ tools: [fsTool], onToolCall: () => ({ content: [{ type: "text", text: "fs error" }], isError: true }) }),
    );
    const client = new McpClient({ serverId: "filesystem", transport: failing });
    await client.connect();
    const defs = mcpToolsToToolDefinitions([fsTool], {
      serverId: "filesystem",
      client,
      trust: "verified",
      sideEffects: fsSideEffects,
    });

    const result = await defs[0]!.invoke({ path: "/x" }, createTestLease(), new AbortController().signal);
    expect(result.success).toBe(false);
    expect(result.output).toBe("fs error");
    expect(result.trustLevel).toBe("unverified");
  });

  it("abort propagates as a structural AbortError through the adapted invoke", async () => {
    const transport = createLoopbackTransport(fakeMcpServerHandler({ tools: [fsTool], toolCallDelayMs: 10_000 }));
    const client = new McpClient({ serverId: "filesystem", transport, requestTimeoutMs: 30_000 });
    await client.connect();
    const defs = mcpToolsToToolDefinitions([fsTool], {
      serverId: "filesystem",
      client,
      trust: "verified",
      sideEffects: fsSideEffects,
    });

    const controller = new AbortController();
    const pending = defs[0]!.invoke({ path: "/x" }, createTestLease(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toSatisfy((err: unknown) => (err as Error).name === "AbortError");
  }, 5_000);
});

describe("McpServerRegistry", () => {
  function makeRegistry() {
    return new McpServerRegistry({ sink: noopSink, defaultTrust: "unknown" });
  }

  it("fail-closed config validation", async () => {
    const registry = makeRegistry();
    await expect(
      registry.connect({ serverId: "bad id!", transport: "stdio", command: "x" }),
    ).rejects.toThrowError(McpConfigError);
    await expect(registry.connect({ serverId: "ok", transport: "stdio" })).rejects.toThrowError(/requires a command/);
    await expect(registry.connect({ serverId: "ok", transport: "http" })).rejects.toThrowError(/requires a url/);
  });

  it("connect snapshots tools/resources/prompts and exposes policy metadata", async () => {
    // Loopback transport cannot be injected via config (config builds its own
    // transport), so this test validates the live stdio path instead.
    const registry = makeRegistry();
    const server = await registry.connect({
      serverId: "fakefs",
      transport: "stdio",
      command: process.execPath,
      args: ["/home/z/my-project/agentic-runtime/test/fixtures/fake-mcp-server.mjs"],
      trust: "verified",
      sideEffects: fsSideEffects,
    });

    expect(server.serverInfo.name).toBe("fake-fs");
    expect(server.tools.map((t) => t.name).sort()).toEqual(["read_file", "write_file"]);
    expect(registry.trustOf("fakefs")).toBe("verified");
    expect(registry.sideEffectsOf("fakefs")).toEqual(fsSideEffects);
    expect(registry.toolNamePrefixOf("fakefs")).toBe("fakefs__");
    expect(registry.clientOf("fakefs")).toBeDefined();

    await registry.disconnect("fakefs");
    expect(registry.get("fakefs")).toBeUndefined();
    // Idempotent disconnect.
    await registry.disconnect("fakefs");
  }, 10_000);

  it("duplicate serverIds throw", async () => {
    const registry = makeRegistry();
    await registry.connect({
      serverId: "dup",
      transport: "stdio",
      command: process.execPath,
      args: ["/home/z/my-project/agentic-runtime/test/fixtures/fake-mcp-server.mjs"],
    });
    await expect(
      registry.connect({
        serverId: "dup",
        transport: "stdio",
        command: process.execPath,
        args: ["/home/z/my-project/agentic-runtime/test/fixtures/fake-mcp-server.mjs"],
      }),
    ).rejects.toThrowError(/already registered/);
    await registry.disconnectAll();
  }, 10_000);

  it("unknown servers fall back to default trust and conservative side effects", () => {
    const registry = makeRegistry();
    expect(registry.trustOf("ghost")).toBe("unknown");
    expect(registry.sideEffectsOf("ghost")).toEqual(CONSERVATIVE_SIDE_EFFECTS);
    expect(registry.toolNamePrefixOf("ghost")).toBe("ghost__");
  });
});

describe("ProgressiveDiscovery", () => {
  it("registers a server's tools into the router with discovery metadata", async () => {
    const registry = new McpServerRegistry({ sink: noopSink });
    const router = new CapabilityRouter({ sink: noopSink });
    const discovery = new ProgressiveDiscovery({
      registry,
      router,
      selector: new TopKCapabilitySelector({ limit: 2 }),
    });

    router.registerNativeTools([
      {
        handle: "local_calc",
        caption: "local calculator",
        argsShape: jsonSchemaContract(undefined),
        resourceClass: "local-cpu",
        effects: "pure",
        grantLevel: "auto",
        invoke: async () => ({ toolCallId: "t", name: "local_calc", success: true, output: 1, trustLevel: "unverified", executionTimeMs: 1 }),
      },
    ]);

    const server = await discovery.connectServer({
      serverId: "filesystem",
      transport: "stdio",
      command: process.execPath,
      args: ["/home/z/my-project/agentic-runtime/test/fixtures/fake-mcp-server.mjs"],
      trust: "verified",
      sideEffects: fsSideEffects,
    });
    expect(server.tools).toHaveLength(2);

    // Router catalogue gained the namespaced tools; index gained descriptors.
    expect(router.getCatalogue().slotNames().sort()).toEqual(["filesystem__read_file", "filesystem__write_file", "local_calc"]);
    expect(router.getIndex().size).toBe(3);

    // Progressive selection narrows to the objective-relevant subset.
    const { mounted, manifests } = await discovery.manifestsFor("read the file at /etc/hosts");
    expect(mounted.capabilities.map((c) => c.name)).toContain("filesystem__read_file");
    expect(manifests.map((m) => m.name)).toContain("filesystem__read_file");

    // Disconnect drops the discovery surface but keeps governance intact.
    await discovery.disconnectServer("filesystem");
    expect(router.getIndex().size).toBe(1);
    expect(router.getCatalogue().slotNames()).toHaveLength(3);
  }, 10_000);

  it("refreshServer re-registers after a tools/list_changed round trip", async () => {
    const registry = new McpServerRegistry({ sink: noopSink });
    const router = new CapabilityRouter({ sink: noopSink });
    const discovery = new ProgressiveDiscovery({ registry, router });

    await discovery.connectServer({
      serverId: "filesystem",
      transport: "stdio",
      command: process.execPath,
      args: ["/home/z/my-project/agentic-runtime/test/fixtures/fake-mcp-server.mjs"],
      sideEffects: fsSideEffects,
    });
    expect(router.getIndex().list({ sources: ["mcp"] })).toHaveLength(2);

    await discovery.refreshServer("filesystem");
    // No duplicate registration after refresh.
    expect(router.getIndex().list({ sources: ["mcp"] })).toHaveLength(2);

    await discovery.close();
    expect(router.getIndex().list({ sources: ["mcp"] })).toHaveLength(0);
  }, 10_000);
});
