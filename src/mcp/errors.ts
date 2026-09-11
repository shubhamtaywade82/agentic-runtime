import { AgentRuntimeError } from "../core/types.js";

/**
 * Invalid MCP server configuration (missing command/url, bad transport).
 * @public
 */
export class McpConfigError extends AgentRuntimeError {
  constructor(message: string) {
    super(message, "MCP_CONFIG_INVALID");
    this.name = "McpConfigError";
  }
}

/**
 * Transport-level failure: spawn failure, process exit, HTTP failure,
 * write to a dead stream. Transient by default (servers can be restarted).
 * @public
 */
export class McpTransportError extends AgentRuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "MCP_TRANSPORT_ERROR", cause);
    this.name = "McpTransportError";
  }
}

/**
 * A client request exceeded its deadline.
 * @public
 */
export class McpTimeoutError extends AgentRuntimeError {
  constructor(method: string, timeoutMs: number) {
    super(`MCP request '${method}' timed out after ${timeoutMs}ms.`, "MCP_TIMEOUT");
    this.name = "McpTimeoutError";
  }
}

/**
 * Protocol violation: malformed framing, invalid JSON-RPC, or a JSON-RPC
 * error response. Carries the server's JSON-RPC error code when present.
 * @public
 */
export class McpProtocolError extends AgentRuntimeError {
  /** JSON-RPC error code from the server, when the failure is an error response. */
  public readonly rpcCode?: number;
  /** Raw JSON-RPC error data payload, when present. */
  public readonly rpcData?: unknown;

  constructor(message: string, opts: { rpcCode?: number; rpcData?: unknown; cause?: unknown } = {}) {
    super(message, "MCP_PROTOCOL_ERROR", opts.cause);
    this.name = "McpProtocolError";
    if (opts.rpcCode !== undefined) this.rpcCode = opts.rpcCode;
    if (opts.rpcData !== undefined) this.rpcData = opts.rpcData;
  }
}
