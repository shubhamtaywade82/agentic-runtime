import { describe, it, expect } from "vitest";
import {
  encodeJsonRpcMessage,
  parseJsonRpcMessage,
  jsonRpcErrorResponse,
  jsonRpcSuccessResponse,
} from "../../src/mcp/jsonrpc.js";
import { McpProtocolError } from "../../src/mcp/errors.js";
import { McpClient, SUPPORTED_MCP_PROTOCOL_VERSIONS } from "../../src/mcp/client.js";
import { createLoopbackTransport, fakeMcpServerHandler } from "./mcp-loopback.js";
import type { McpTool } from "../../src/mcp/types.js";

const tools: McpTool[] = [
  {
    name: "read_file",
    description: "reads a file from disk",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_directory",
    description: "lists a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "git_status",
    description: "git repository status",
    annotations: { readOnlyHint: true },
  },
];

describe("JSON-RPC codec", () => {
  it("encodes with trailing newline and roundtrips", () => {
    const frame = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 7, method: "tools/list", params: { cursor: "2" } });
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.split("\n")).toHaveLength(2);
    // A method+id frame parsed as a server message is a server->client request.
    const parsed = parseJsonRpcMessage(frame.trim());
    expect(parsed).toMatchObject({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  });

  it("parses success, error, notification and request forms", () => {
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toMatchObject({ id: 1, result: { a: 1 } });
    const err = parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}');
    expect("error" in err && err.error.code).toBe(-32601);
    const notif = parseJsonRpcMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect("method" in notif && notif.method).toBe("notifications/initialized");
    const request = parseJsonRpcMessage('{"jsonrpc":"2.0","id":5,"method":"ping"}');
    expect("method" in request && request.method).toBe("ping");
  });

  it("rejects malformed JSON, non-objects and wrong versions", () => {
    expect(() => parseJsonRpcMessage("{oops")).toThrowError(McpProtocolError);
    expect(() => parseJsonRpcMessage("42")).toThrowError(/must be an object/);
    expect(() => parseJsonRpcMessage('{"id":1,"result":{}}')).toThrowError(/jsonrpc 2.0/);
    expect(() => parseJsonRpcMessage('{"jsonrpc":"2.0","id":1}')).toThrowError(/neither notification nor response/);
  });

  it("response builders produce conforming messages", () => {
    expect(jsonRpcSuccessResponse(3, { ok: true })).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    expect(jsonRpcErrorResponse(4, -32601, "nope")).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "nope" },
    });
  });
});

function clientWith(spec: Parameters<typeof fakeMcpServerHandler>[0], requestTimeoutMs = 2_000) {
  const transport = createLoopbackTransport(fakeMcpServerHandler(spec));
  const client = new McpClient({ serverId: "fake", transport, requestTimeoutMs });
  return { transport, client };
}

describe("McpClient - initialize handshake", () => {
  it("negotiates capabilities, records serverInfo, sends initialized notification", async () => {
    const { transport, client } = clientWith({ tools });
    const info = await client.connect();

    expect(info.name).toBe("fake-mcp");
    expect(info.protocolVersion).toBe("2025-06-18");
    expect(client.isConnected).toBe(true);
    expect(client.serverCapabilities?.tools).toBeDefined();

    const initialize = transport.sent.find((m) => "method" in m && m.method === "initialize");
    expect(initialize).toBeDefined();
    const initialized = transport.sent.find((m) => "method" in m && m.method === "notifications/initialized");
    expect(initialized).toBeDefined();
  });

  it("proposes the newest protocol version by default", async () => {
    const { transport, client } = clientWith({});
    await client.connect();
    const init = transport.sent.find((m) => "method" in m && m.method === "initialize");
    expect((init?.params as { protocolVersion?: string })?.protocolVersion).toBe(SUPPORTED_MCP_PROTOCOL_VERSIONS[0]);
  });

  it("double connect throws", async () => {
    const { client } = clientWith({});
    await client.connect();
    await expect(client.connect()).rejects.toThrowError(/already connected/);
  });
});

describe("McpClient - tools", () => {
  it("lists all tools across pagination cursors", async () => {
    const { client } = clientWith({ tools, toolsPageSize: 2 });
    await client.connect();
    const listed = await client.listTools();
    expect(listed.map((t) => t.name)).toEqual(["read_file", "list_directory", "git_status"]);
  });

  it("calls tools and flattens text content", async () => {
    const { client } = clientWith({ tools });
    await client.connect();
    const result = await client.callTool("read_file", { path: "/tmp/x" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("read_file") });
  });

  it("surfaces isError domain failures without throwing", async () => {
    const { client } = clientWith({
      tools,
      onToolCall: () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
    });
    await client.connect();
    const result = await client.callTool("read_file", {});
    expect(result.isError).toBe(true);
  });

  it("maps JSON-RPC error responses to McpProtocolError with rpcCode", async () => {
    const { client } = clientWith({ tools, toolCallRpcError: { code: -32000, message: "server exploded" } });
    await client.connect();
    const err = await client.callTool("read_file", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpProtocolError);
    expect((err as McpProtocolError).rpcCode).toBe(-32000);
    expect((err as McpProtocolError).message).toContain("server exploded");
  });

  it("times out and drops the pending entry", async () => {
    const { client } = clientWith({ tools, toolCallDelayMs: 500 }, 30);
    await client.connect();
    await expect(client.callTool("read_file", {})).rejects.toThrowError(/timed out/);
  }, 3_000);

  it("aborts in-flight calls with a structural AbortError and notifies the server", async () => {
    const { transport, client } = clientWith({ tools, toolCallDelayMs: 500 }, 5_000);
    await client.connect();

    const controller = new AbortController();
    const pending = client.callTool("read_file", {}, { signal: controller.signal });
    controller.abort();
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    const cancelled = transport.sent.find((m) => "method" in m && m.method === "notifications/cancelled");
    expect(cancelled).toBeDefined();
  }, 3_000);
});

describe("McpClient - resources, prompts, gating", () => {
  it("lists and reads resources", async () => {
    const { client } = clientWith({
      tools,
      resources: [{ uri: "file:///tmp/x", name: "x", description: "a file" }],
    });
    await client.connect();
    const resources = await client.listResources();
    expect(resources[0]?.uri).toBe("file:///tmp/x");
    const contents = await client.readResource("file:///tmp/x");
    expect(contents[0]?.text).toBe("contents-of:file:///tmp/x");
  });

  it("lists and renders prompts", async () => {
    const { client } = clientWith({ tools, prompts: [{ name: "code_review", description: "review code" }] });
    await client.connect();
    expect((await client.listPrompts())[0]?.name).toBe("code_review");
    const messages = await client.getPrompt("code_review", { language: "ts" });
    expect(messages[0]?.content).toMatchObject({ type: "text", text: "prompt:code_review" });
  });

  it("fails closed when the server does not advertise a capability", async () => {
    const { client } = clientWith({ tools, capabilities: { tools: {} } });
    await client.connect();
    await expect(client.listResources()).rejects.toThrowError(/does not advertise resources/);
    await expect(client.listPrompts()).rejects.toThrowError(/does not advertise prompts/);
  });
});

describe("McpClient - server->client traffic", () => {
  it("answers ping automatically", async () => {
    const { transport, client } = clientWith({ tools });
    await client.connect();
    transport.push({ jsonrpc: "2.0", id: 900, method: "ping" });
    // The reply is async but synchronous through the loopback.
    const pingReply = transport.sent.find((m) => "result" in m && (m as { id?: unknown }).id === 900);
    expect(pingReply).toMatchObject({ jsonrpc: "2.0", id: 900, result: {} });
  });

  it("declines unsupported server->client requests with -32601", async () => {
    const { transport, client } = clientWith({ tools });
    await client.connect();
    transport.push({
      jsonrpc: "2.0",
      id: 901,
      method: "sampling/createMessage",
      params: { maxTokens: 10 },
    });
    const decline = transport.sent.find((m) => "error" in m && (m as { id?: unknown }).id === 901);
    expect(decline).toMatchObject({ jsonrpc: "2.0", id: 901, error: { code: -32601 } });
  });

  it("forwards tools/list_changed notifications to the registered callback", async () => {
    const events: string[] = [];
    const transport = createLoopbackTransport(
      fakeMcpServerHandler({
        tools,
        afterInitialize: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      }),
    );
    const client = new McpClient({
      serverId: "fake",
      transport,
      onToolsChanged: (serverId) => events.push(`tools:${serverId}`),
    });
    await client.connect();
    expect(events).toEqual(["tools:fake"]);
  });

  it("drops responses to unknown/late request ids", async () => {
    const { transport, client } = clientWith({ tools });
    await client.connect();
    // No pending request with id 424242: this must be a silent no-op.
    expect(() =>
      transport.push({ jsonrpc: "2.0", id: 424242, result: { junk: true } }),
    ).not.toThrow();
  });
});
