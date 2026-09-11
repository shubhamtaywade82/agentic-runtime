import { spawn, type ChildProcess } from "node:child_process";
import { encodeJsonRpcMessage, parseJsonRpcMessage } from "./jsonrpc.js";
import type {
  JsonRpcClientMessage,
  JsonRpcErrorResponse,
  JsonRpcServerMessage,
  JsonRpcSuccessResponse,
} from "./jsonrpc.js";
import { McpTransportError, McpProtocolError } from "./errors.js";

/**
 * Listener wiring the transport to the client.
 * @public
 */
export interface McpTransportListeners {
  /** Every well-formed server message. */
  onMessage: (message: JsonRpcServerMessage) => void;
  /** Fatal transport trouble (spawn failure, dead stream). Rejects pending. */
  onTransportError?: (error: Error) => void;
  /** Transport closed (process exit, stream end). */
  onTransportClosed?: (hadError: boolean) => void;
}

/**
 * A byte pipe speaking MCP framing. Transports are dumb pipes: they frame,
 * parse and deliver; request/response correlation, timeouts and capability
 * negotiation live in the client.
 * @public
 */
export interface McpTransport {
  readonly kind: "stdio" | "http";
  start(listeners: McpTransportListeners): Promise<void>;
  send(
    message: JsonRpcClientMessage | JsonRpcSuccessResponse | JsonRpcErrorResponse,
    signal?: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

/**
 * Stdio transport options.
 * @public
 */
export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** stderr lines forwarded here (default: ignored). */
  onStderrLine?: (line: string) => void;
  /** Grace period before SIGKILL on close. Default 1500ms. */
  closeGraceMs?: number;
}

/**
 * StdioTransport - NDJSON JSON-RPC over a child process's stdin/stdout.
 *
 * Robustness policy:
 * - malformed frames are dropped (counted via `malformedFrames`), they must
 *   not kill the connection for the frames that follow
 * - child 'error' (spawn failure) and EPIPE escalate to onTransportError,
 *   which lets the client reject all pending requests
 * - close() ends stdin, waits the grace period, then SIGKILLs - no zombie
 *   processes, no leaked stdio handles
 * @public
 */
export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private child?: ChildProcess;
  private listeners?: McpTransportListeners;
  private buffer = "";
  private closed = false;
  private frames = 0;

  constructor(private readonly opts: StdioTransportOptions) {}

  /**
   * Spawn the server process and begin consuming stdout frames.
   * @public
   */
  async start(listeners: McpTransportListeners): Promise<void> {
    if (this.child !== undefined) throw new McpTransportError("stdio transport already started.");
    this.listeners = listeners;

    try {
      this.child = spawn(this.opts.command, this.opts.args ?? [], {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new McpTransportError(
        `Failed to spawn MCP server '${this.opts.command}': ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const child = this.child;

    // Race spawn success against spawn failure: on Linux spawn(ENOENT)
    // does not throw synchronously - it emits 'error' asynchronously.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener("error", onRaceError);
        resolve();
      };
      const onRaceError = (err: Error) => {
        child.removeListener("spawn", onSpawn);
        reject(
          new McpTransportError(
            `Failed to spawn MCP server '${this.opts.command}': ${err.message}`,
            err,
          ),
        );
      };
      child.once("error", onRaceError);
      child.once("spawn", onSpawn);
    });

    child.on("error", (err) => {
      this.reportError(new McpTransportError("MCP server process error.", err));
    });
    child.on("exit", (code, signal) => {
      this.reportClosed(
        !this.closed && code !== 0 && code !== null,
        `stdio transport exited (code=${String(code)}, signal=${String(signal)})`,
      );
    });

    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) this.opts.onStderrLine?.(line);
      }
    });
  }

  /**
   * Number of frames consumed. Exposed for health checks.
   * @public
   */
  get consumedFrames(): number {
    return this.frames;
  }

  /**
   * Number of malformed frames dropped.
   * @public
   */
  get malformedFrames(): number {
    return this.malformed;
  }

  private malformed = 0;

  /**
   * Write one NDJSON frame to the server's stdin.
   * @public
   */
  async send(
    message: JsonRpcClientMessage | JsonRpcSuccessResponse | JsonRpcErrorResponse,
    _signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed || this.child === undefined || this.child.stdin === undefined) {
      throw new McpTransportError("stdio transport is not open.");
    }
    const frame = encodeJsonRpcMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin!.write(frame, (err) => {
        if (err) {
          this.reportError(new McpTransportError("Write to MCP server stdin failed.", err));
          reject(new McpTransportError("Write to MCP server stdin failed.", err));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * End stdin, wait the grace period, then force-kill.
   * @public
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child === undefined) return;

    await new Promise<void>((resolve) => {
      const grace = this.opts.closeGraceMs ?? 1500;
      const finish = () => resolve();
      child.once("exit", finish);
      child.stdin?.end();
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
      }, grace);
      child.once("exit", () => clearTimeout(killer));
      // Resolve even if exit never fires (already-dead pipes).
      setTimeout(finish, grace + 250);
    });
  }

  private consume(text: string): void {
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.frames++;
      try {
        this.listeners?.onMessage(parseJsonRpcMessage(line));
      } catch (err) {
        this.malformed++;
        if (err instanceof McpProtocolError) continue; // drop malformed frame
        this.reportError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private reportError(err: Error): void {
    if (this.closed) return;
    this.listeners?.onTransportError?.(err);
  }

  private reportClosed(hadError: boolean, _detail: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners?.onTransportClosed?.(hadError);
    if (hadError) {
      this.listeners?.onTransportError?.(
        new McpTransportError("MCP server process exited unexpectedly."),
      );
    }
  }
}

/**
 * Streamable HTTP transport options.
 * @public
 */
export interface StreamableHttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  /** Per-request fetch timeout. Default 60s. */
  requestTimeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * StreamableHttpTransport - MCP over HTTP POST (the 2025-03-26+ transport).
 *
 * - Notifications: POST, 202 Accepted (body ignored)
 * - Requests: POST with Accept: application/json, text/event-stream;
 *   the response is either a single JSON document or an SSE stream that
 *   yields the response (plus any server-initiated notifications)
 * - Mcp-Session-Id is captured from responses and echoed on later requests
 * - close() issues a best-effort DELETE to terminate the session
 *
 * Not supported in v0.2: server-initiated long-lived GET streams
 * (server push without a client request), and session resumption.
 * @public
 */
export class StreamableHttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private listeners?: McpTransportListeners;
  private sessionId?: string;
  private closed = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: StreamableHttpTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * HTTP transports need no startup handshake; stores listeners only.
   * @public
   */
  async start(listeners: McpTransportListeners): Promise<void> {
    this.listeners = listeners;
  }

  /**
   * POST one message. For SSE responses, resolves once the response for
   * this request's id has been delivered (or the stream ends).
   * @public
   */
  async send(
    message: JsonRpcClientMessage | JsonRpcSuccessResponse | JsonRpcErrorResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) throw new McpTransportError("HTTP transport is closed.");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId !== undefined ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.opts.headers ?? {}),
    };

    const timeoutController = new AbortController();
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? 60_000;
    const timer = setTimeout(() => timeoutController.abort(), requestTimeoutMs);
    const composite = signal === undefined ? timeoutController.signal : anySignal(signal, timeoutController.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: composite,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal?.aborted) {
        const abortErr = new Error("MCP HTTP request aborted.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      throw new McpTransportError(
        `MCP HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    clearTimeout(timer);

    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader !== null) this.sessionId = sessionHeader;

    if (response.status === 202) {
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => "");
      throw new McpTransportError(`MCP endpoint returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const requestId =
        "id" in message && (typeof message.id === "number" || typeof message.id === "string")
          ? message.id
          : undefined;
      await this.consumeSseStream(response, requestId);
      return;
    }

    const bodyText = await response.text();
    const parsed = parseJsonRpcMessage(bodyText);
    this.listeners?.onMessage(parsed);
  }

  /**
   * Best-effort session termination (DELETE) with a hard timeout, so a
   * dead endpoint cannot hang close(). Never throws.
   * @public
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 5_000);
      try {
        await this.fetchImpl(this.opts.url, {
          method: "DELETE",
          headers: {
            ...(this.sessionId !== undefined ? { "mcp-session-id": this.sessionId } : {}),
            ...(this.opts.headers ?? {}),
          },
          signal: timeout.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Session termination is best-effort by design.
    }
  }

  /**
   * The negotiated Mcp-Session-Id, when the server issued one.
   * @public
   */
  get session(): string | undefined {
    return this.sessionId;
  }

  private async consumeSseStream(response: Response, requestId: number | string | undefined): Promise<void> {
    const body = response.body;
    if (body === null) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload.length === 0) continue;
        try {
          const message = parseJsonRpcMessage(payload);
          this.listeners?.onMessage(message);
          if (
            requestId !== undefined &&
            "id" in message &&
            message.id === requestId
          ) {
            done = true;
          }
        } catch {
          // Drop malformed SSE events; the response may still arrive.
        }
      }
    }
    try {
      await reader.cancel();
    } catch {
      // Stream already closed.
    }
  }
}

/**
 * Compose multiple abort signals into one (any signal aborts).
 * @public
 */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      continue;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}
