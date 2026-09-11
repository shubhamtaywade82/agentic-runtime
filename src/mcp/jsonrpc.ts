import { McpProtocolError } from "./errors.js";

/**
 * JSON-RPC 2.0 request (expects a response).
 * @public
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 notification (no response expected).
 * @public
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 server->client request (method + id; expects a response
 * from the client, e.g. ping or sampling/createMessage).
 * @public
 */
export interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 success response.
 * @public
 */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

/**
 * JSON-RPC 2.0 error response.
 * @public
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

/** Messages the client sends. @public */
export type JsonRpcClientMessage = JsonRpcRequest | JsonRpcNotification;

/** Messages the server sends. @public */
export type JsonRpcServerMessage =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcServerRequest
  | JsonRpcNotification;

/**
 * Encode a client message as one NDJSON frame (trailing newline included).
 * MCP stdio framing is newline-delimited JSON - one message per line.
 * Accepts responses too (client answering server->client requests).
 * @public
 */
export function encodeJsonRpcMessage(
  message: JsonRpcClientMessage | JsonRpcSuccessResponse | JsonRpcErrorResponse,
): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parse one line/frame into a server message.
 * Throws McpProtocolError on malformed JSON or non-conforming shapes.
 * @public
 */
export function parseJsonRpcMessage(line: string): JsonRpcServerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    throw new McpProtocolError(`Malformed JSON-RPC frame: ${String(line).slice(0, 120)}`, {
      cause: err,
    });
  }
  return coerceServerMessage(raw);
}

/**
 * Coerce a parsed value into a JsonRpcServerMessage.
 * @public
 */
export function coerceServerMessage(raw: unknown): JsonRpcServerMessage {
  if (raw === null || typeof raw !== "object") {
    throw new McpProtocolError("JSON-RPC message must be an object.");
  }
  const msg = raw as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0") {
    throw new McpProtocolError("JSON-RPC message must declare jsonrpc 2.0.");
  }
  if (typeof msg.method === "string") {
    // Notification (no id) or server->client request (id present).
    if (msg.id !== null && (typeof msg.id === "number" || typeof msg.id === "string")) {
      const request: JsonRpcServerRequest = {
        jsonrpc: "2.0",
        id: msg.id,
        method: msg.method,
      };
      if (msg.params !== undefined) request.params = msg.params as Record<string, unknown>;
      return request;
    }
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: msg.method,
    };
    if (msg.params !== undefined) notification.params = msg.params as Record<string, unknown>;
    return notification;
  }
  if (msg.result !== undefined) {
    if (msg.id === null || typeof msg.id === "number" || typeof msg.id === "string") {
      return { jsonrpc: "2.0", id: msg.id as number | string, result: msg.result };
    }
    throw new McpProtocolError("JSON-RPC success response requires an id.");
  }
  if (typeof msg.error === "object" && msg.error !== null) {
    const error = msg.error as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      throw new McpProtocolError("JSON-RPC error response requires numeric code and message.");
    }
    return {
      jsonrpc: "2.0",
      id: (msg.id === null || typeof msg.id === "number" || typeof msg.id === "string"
        ? msg.id
        : null) as number | string | null,
      error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
    };
  }
  throw new McpProtocolError("JSON-RPC message is neither notification nor response.");
}

/**
 * Build a JSON-RPC error response (client answering an unsupported
 * server->client request).
 * @public
 */
export function jsonRpcErrorResponse(
  id: number | string,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Build a JSON-RPC success response (client answering a server->client
 * request such as ping).
 * @public
 */
export function jsonRpcSuccessResponse(
  id: number | string,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}
