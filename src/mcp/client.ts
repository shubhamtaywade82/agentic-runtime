import type { EventSink } from "../core/types.js";
import { McpProtocolError, McpTimeoutError, McpTransportError } from "./errors.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcServerMessage,
} from "./jsonrpc.js";
import { jsonRpcErrorResponse, jsonRpcSuccessResponse } from "./jsonrpc.js";
import type { McpTransport } from "./transport.js";
import type {
  McpContent,
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpResourceContents,
  McpServerCapabilities,
  McpServerInfo,
  McpTool,
  McpToolCallResult,
} from "./types.js";
import { MCP_METRICS, MCP_LABEL_KEYS } from "../observability/metrics.js";

/**
 * Protocol versions this client speaks, newest first.
 * @public
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/**
 * Client identity advertised during the initialize handshake.
 * @public
 */
export const MCP_CLIENT_INFO = { name: "@nemesis-oss/agentic-runtime", version: "0.2.0" } as const;

/**
 * Options for the MCP client.
 * @public
 */
export interface McpClientOptions {
  serverId: string;
  transport: McpTransport;
  /** Per-request timeout. Default 30s. */
  requestTimeoutMs?: number;
  /** Protocol version to propose. Default 2025-06-18. */
  protocolVersion?: string;
  sink?: EventSink;
  /** Called when the server signals notifications/tools/list_changed. */
  onToolsChanged?: (serverId: string) => void;
  /** Called when the server signals notifications/resources or prompts changed. */
  onCapabilitiesChanged?: (serverId: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * McpClient - JSON-RPC 2.0 MCP client with correlation, timeouts, abort
 * and capability negotiation.
 *
 * Lifecycle: connect() runs the initialize handshake (protocol version
 * negotiation + capability capture), then every list/call flows through
 * request() with per-request deadline and cancellation
 * (notifications/cancelled is sent best-effort on abort).
 *
 * Server->client traffic:
 * - "ping" requests are answered automatically
 * - other server->client requests (sampling, elicitation, roots) are
 *   declined with -32601 method-not-found - the honest v0.2 answer
 * - capability list-changed notifications invoke the registered callbacks
 * @public
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestTimeoutMs: number;
  private readonly proposedVersion: string;
  private connected = false;
  private serverInfo?: McpServerInfo;
  private capabilities?: McpServerCapabilities;

  constructor(private readonly opts: McpClientOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.proposedVersion = opts.protocolVersion ?? SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
  }

  /**
   * The negotiated server identity (after connect).
   * @public
   */
  get info(): McpServerInfo | undefined {
    return this.serverInfo;
  }

  /**
   * The server's advertised capabilities (after connect).
   * @public
   */
  get serverCapabilities(): McpServerCapabilities | undefined {
    return this.capabilities;
  }

  /**
   * Whether connect() has completed successfully.
   * @public
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Run the initialize handshake and mark the client connected.
   * @public
   */
  async connect(): Promise<McpServerInfo> {
    if (this.connected) {
      throw new McpProtocolError("Client already connected.");
    }
    await this.opts.transport.start({
      onMessage: (message) => this.handleMessage(message),
      onTransportError: (err) => this.failAllPending(err),
      onTransportClosed: () =>
        this.failAllPending(new McpTransportError("MCP transport closed before the request completed.")),
    });

    const result = (await this.request("initialize", {
      protocolVersion: this.proposedVersion,
      capabilities: {},
      clientInfo: { name: MCP_CLIENT_INFO.name, version: MCP_CLIENT_INFO.version },
    })) as {
      protocolVersion?: unknown;
      capabilities?: McpServerCapabilities;
      serverInfo?: { name?: unknown; version?: unknown };
    };

    if (result === null || typeof result !== "object" || typeof result.serverInfo?.name !== "string") {
      throw new McpProtocolError("Initialize response is missing serverInfo.name.");
    }
    const negotiated = typeof result.protocolVersion === "string" ? result.protocolVersion : this.proposedVersion;

    this.serverInfo = {
      name: result.serverInfo.name,
      ...(result.serverInfo.version !== undefined ? { version: String(result.serverInfo.version) } : {}),
      protocolVersion: negotiated,
    };
    this.capabilities = result.capabilities ?? {};
    this.connected = true;

    // Complete the handshake.
    await this.notify("notifications/initialized");
    this.opts.sink?.emit(MCP_METRICS.CONNECTED_TOTAL, {
      [MCP_LABEL_KEYS.SERVER]: this.opts.serverId,
      [MCP_LABEL_KEYS.TRANSPORT]: this.opts.transport.kind,
      protocolVersion: negotiated,
    });
    return this.serverInfo;
  }

  /**
   * Close the transport and reject pending requests.
   * @public
   */
  async close(): Promise<void> {
    this.connected = false;
    await this.opts.transport.close();
    this.failAllPending(new McpProtocolError("Client closed."));
  }

  // ------------------------------------------------------------- tools ---

  /**
   * List every tool (follows pagination cursors).
   * @public
   */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {};
      const result = (await this.request("tools/list", params)) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  /**
   * Call one tool. Resolves with the server's content result even when
   * isError is set (that is a domain-level failure, not a protocol one);
   * protocol-level failures reject.
   * @public
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpToolCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return this.coerceToolCallResult(result, name);
  }

  // -------------------------------------------------------- resources ---

  /**
   * List resources when the server advertises the capability.
   * @public
   */
  async listResources(): Promise<McpResource[]> {
    this.requireCapability("resources", "listResources");
    const resources: McpResource[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {};
      const result = (await this.request("resources/list", params)) as {
        resources?: McpResource[];
        nextCursor?: string;
      };
      resources.push(...(result.resources ?? []));
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    return resources;
  }

  /**
   * Read one resource's contents.
   * @public
   */
  async readResource(uri: string, opts: { signal?: AbortSignal } = {}): Promise<McpResourceContents[]> {
    this.requireCapability("resources", "readResource");
    const result = await this.request(
      "resources/read",
      { uri },
      opts.signal !== undefined ? { signal: opts.signal } : {},
    );
    return ((result as { contents?: McpResourceContents[] }).contents ?? []);
  }

  // ---------------------------------------------------------- prompts ---

  /**
   * List prompts when the server advertises the capability.
   * @public
   */
  async listPrompts(): Promise<McpPrompt[]> {
    this.requireCapability("prompts", "listPrompts");
    const prompts: McpPrompt[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {};
      const result = (await this.request("prompts/list", params)) as {
        prompts?: McpPrompt[];
        nextCursor?: string;
      };
      prompts.push(...(result.prompts ?? []));
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    return prompts;
  }

  /**
   * Render one prompt with arguments.
   * @public
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptMessage[]> {
    this.requireCapability("prompts", "getPrompt");
    const result = (await this.request("prompts/get", {
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    })) as { messages?: McpPromptMessage[] };
    return result.messages ?? [];
  }

  // --------------------------------------------------------- internals ---

  private request(
    method: string,
    params?: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;

      const pending: Pending = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(pending.timer);
          if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener("abort", pending.onAbort);
          }
          this.pending.delete(id);
          resolve(value);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(pending.timer);
          if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener("abort", pending.onAbort);
          }
          this.pending.delete(id);
          reject(err);
        },
        method,
        timeoutMs,
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
      };

      pending.timer = setTimeout(() => {
        pending.reject(new McpTimeoutError(method, timeoutMs));
      }, timeoutMs);

      if (opts.signal !== undefined) {
        const signal = opts.signal;
        pending.signal = signal;
        pending.onAbort = () => {
          pending.reject(this.abortError());
          // Best-effort cancellation notice; fire-and-forget by design.
          void this.notify("notifications/cancelled", { requestId: id }).catch(() => undefined);
        };
        if (signal.aborted) {
          pending.onAbort();
          return;
        }
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }

      this.pending.set(id, pending);

      const message: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.opts.transport.send(message, opts.signal).catch((err: unknown) => {
        pending.reject(err);
      });
    });
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.opts.transport.send(message);
  }

  private handleMessage(message: JsonRpcServerMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        // Server->client request: ping is answered, the rest declined.
        this.answerServerRequest(message.id, message.method, message.params);
        return;
      }
      // Pure notification from the server.
      switch (message.method) {
        case "notifications/tools/list_changed":
          this.opts.sink?.emit(MCP_METRICS.LIST_CHANGED_TOTAL, {
            [MCP_LABEL_KEYS.SERVER]: this.opts.serverId,
            capability: "tools",
          });
          this.opts.onToolsChanged?.(this.opts.serverId);
          return;
        case "notifications/resources/updated":
        case "notifications/resources/list_changed":
        case "notifications/prompts/list_changed":
        case "notifications/message":
          this.opts.onCapabilitiesChanged?.(this.opts.serverId);
          return;
        default:
          return; // Other server notifications are ignorable in v0.2.
      }
    }

    // Response to one of our requests.
    if (message.id !== null) {
      const pending = this.pending.get(message.id as number);
      if (pending === undefined) return; // Late/unknown response: drop.
      if ("error" in message) {
        pending.reject(
          new McpProtocolError(`MCP error on '${pending.method}': ${message.error.message}`, {
            rpcCode: message.error.code,
            ...(message.error.data !== undefined ? { rpcData: message.error.data } : {}),
          }),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private answerServerRequest(id: number | string, method: string, params?: Record<string, unknown>): void {
    if (method === "ping") {
      void this.opts.transport
        .send(jsonRpcSuccessResponse(id, {}))
        .catch(() => undefined);
      return;
    }
    // sampling/createMessage, elicitation/create, roots/list: unsupported.
    void this.opts.transport
      .send(
        jsonRpcErrorResponse(
          id,
          -32601,
          `agentic-runtime v0.2 does not support server->client method '${method}' (params: ${JSON.stringify(params ?? {}).slice(0, 200)}).`,
        ),
      )
      .catch(() => undefined);
  }

  private failAllPending(err: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(err);
    }
  }

  private requireCapability(capability: "resources" | "prompts", action: string): void {
    if (this.capabilities?.[capability] === undefined) {
      throw new McpProtocolError(
        `Server '${this.opts.serverId}' does not advertise ${capability}; ${action} is unavailable.`,
      );
    }
  }

  private coerceToolCallResult(result: unknown, toolName: string): McpToolCallResult {
    if (result === null || typeof result !== "object") {
      throw new McpProtocolError(`tools/call result for '${toolName}' is not an object.`);
    }
    const raw = result as {
      content?: unknown;
      isError?: unknown;
      structuredContent?: unknown;
    };
    const content = Array.isArray(raw.content) ? (raw.content as McpContent[]) : [];
    return {
      content,
      ...(raw.isError === true ? { isError: true } : {}),
      ...(raw.structuredContent !== null && typeof raw.structuredContent === "object"
        ? { structuredContent: raw.structuredContent as Record<string, unknown> }
        : {}),
    };
  }

  private abortError(): Error {
    const err = new Error("MCP request aborted.");
    err.name = "AbortError";
    return err;
  }
}
