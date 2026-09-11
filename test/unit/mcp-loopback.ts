import type {
  JsonRpcClientMessage,
  JsonRpcServerMessage,
} from "../../src/mcp/jsonrpc.js";
import type { McpTransport, McpTransportListeners } from "../../src/mcp/transport.js";
import type {
  McpContent,
  McpResource,
  McpServerCapabilities,
  McpTool,
} from "../../src/mcp/types.js";

/**
 * In-memory transport pair: the "server" is a plain handler function that
 * receives every client message and can push replies (or server-initiated
 * requests/notifications) back. Zero I/O - deterministic offline tests of
 * the full JSON-RPC client.
 */
export interface LoopbackTransport extends McpTransport {
  /** Every message the client sent, in order. */
  sent: JsonRpcClientMessage[];
  /** Push a server-side message (request, notification or response). */
  push: (message: JsonRpcServerMessage) => void;
}

export type LoopbackHandler = (
  message: JsonRpcClientMessage,
  reply: (message: JsonRpcServerMessage) => void,
) => void | Promise<void>;

export function createLoopbackTransport(handler: LoopbackHandler): LoopbackTransport {
  const sent: JsonRpcClientMessage[] = [];
  let listeners: McpTransportListeners | undefined;

  return {
    kind: "stdio",
    sent,
    push: (message: JsonRpcServerMessage) => listeners?.onMessage(message),
    async start(l) {
      listeners = l;
    },
    async send(message) {
      sent.push(message);
      await handler(message, (reply) => listeners?.onMessage(reply));
    },
    async close() {
      listeners = undefined;
    },
  };
}

/**
 * A canned MCP server implementation over the loopback transport:
 * initialize handshake, paginated tools/list, tools/call, resources and
 * prompts - enough surface to exercise the whole client.
 */
export interface FakeMcpServerSpec {
  tools?: McpTool[];
  resources?: McpResource[];
  prompts?: Array<{ name: string; description?: string }>;
  capabilities?: McpServerCapabilities;
  serverName?: string;
  /** Tool-call behavior; default: text echo of name + args. */
  onToolCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => { content: McpContent[]; isError?: boolean; structuredContent?: Record<string, unknown> };
  /** JSON-RPC error to return for tools/call instead of a result. */
  toolCallRpcError?: { code: number; message: string };
  /** Pagination page size for tools/list. */
  toolsPageSize?: number;
  /** Delay before answering tools/call (timeout/abort tests). */
  toolCallDelayMs?: number;
  /** Extra server->client message to push right after initialize. */
  afterInitialize?: JsonRpcServerMessage;
}

export function fakeMcpServerHandler(spec: FakeMcpServerSpec = {}): LoopbackHandler {
  const tools = spec.tools ?? [];
  const pageSize = spec.toolsPageSize ?? 1_000;
  let listChangedPushed = false;

  return (message, reply) => {
    if (message.method === "initialize") {
      const id = (message as { id?: number | string }).id;
      reply({
        jsonrpc: "2.0",
        id: id as number,
        result: {
          protocolVersion: "2025-06-18",
          capabilities:
            spec.capabilities ?? { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: spec.serverName ?? "fake-mcp", version: "9.9.9" },
        },
      });
      if (spec.afterInitialize !== undefined && !listChangedPushed) {
        listChangedPushed = true;
        reply(spec.afterInitialize);
      }
      return;
    }

    if (message.method === "notifications/initialized") return;
    if (message.method === "notifications/cancelled") return;

    const id = (message as { id?: number | string }).id as number;

    if (message.method === "tools/list") {
      const cursor = (message.params?.cursor as string | undefined) ?? undefined;
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = tools.slice(start, start + pageSize);
      const nextCursor = start + pageSize < tools.length ? String(start + pageSize) : undefined;
      reply({ jsonrpc: "2.0", id, result: { tools: page, ...(nextCursor !== undefined ? { nextCursor } : {}) } });
      return;
    }

    if (message.method === "tools/call") {
      const name = message.params?.name as string;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (spec.toolCallRpcError !== undefined) {
        reply({
          jsonrpc: "2.0",
          id,
          error: { code: spec.toolCallRpcError.code, message: spec.toolCallRpcError.message },
        });
        return;
      }
      const answer =
        spec.onToolCall?.(name, args) ??
        { content: [{ type: "text" as const, text: `echo:${name}:${JSON.stringify(args)}` }] };
      const deliver = () => reply({ jsonrpc: "2.0", id, result: answer });
      if (spec.toolCallDelayMs !== undefined && spec.toolCallDelayMs > 0) {
        setTimeout(deliver, spec.toolCallDelayMs);
        return;
      }
      deliver();
      return;
    }

    if (message.method === "resources/list") {
      reply({
        jsonrpc: "2.0",
        id,
        result: { resources: spec.resources ?? [] },
      });
      return;
    }

    if (message.method === "resources/read") {
      const uri = message.params?.uri as string;
      reply({
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri, text: `contents-of:${uri}` }] },
      });
      return;
    }

    if (message.method === "prompts/list") {
      reply({ jsonrpc: "2.0", id, result: { prompts: spec.prompts ?? [] } });
      return;
    }

    if (message.method === "prompts/get") {
      const name = message.params?.name as string;
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          messages: [{ role: "user", content: { type: "text", text: `prompt:${name}` } }],
        },
      });
      return;
    }

    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `no handler for ${String(message.method)}` } });
  };
}
