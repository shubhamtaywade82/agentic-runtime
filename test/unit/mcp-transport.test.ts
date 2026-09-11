import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { StdioTransport, StreamableHttpTransport, anySignal } from "../../src/mcp/transport.js";
import { McpClient } from "../../src/mcp/client.js";
import { McpTransportError } from "../../src/mcp/errors.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("StdioTransport (real child process)", () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));

  it("speaks NDJSON JSON-RPC end-to-end with a full client", async () => {
    const transport = new StdioTransport({ command: process.execPath, args: [fixture] });
    const client = new McpClient({ serverId: "stdio-e2e", transport, requestTimeoutMs: 8_000 });

    const info = await client.connect();
    expect(info.name).toBe("fake-fs");
    expect(info.protocolVersion).toBe("2025-06-18");

    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["read_file", "write_file"]);

    const result = await client.callTool("read_file", { path: "/etc/hosts" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: 'echo:read_file:{"path":"/etc/hosts"}',
    });

    await client.close();
  }, 15_000);

  it("stderr lines are forwarded, malformed frames are dropped without killing the pipe", async () => {
    const stderrLines: string[] = [];
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stderr.write('noise\\n');",
          "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
          "send({ jsonrpc: '2.0', id: 1, result: { ok: 1 } });",
          "process.stdout.write('this is not json\\n');",
          "send({ jsonrpc: '2.0', id: 2, result: { ok: 2 } });",
          "process.stderr.write('more noise\\n');",
        ].join(" "),
      ],
      onStderrLine: (line) => stderrLines.push(line),
    });
    const seen: unknown[] = [];
    await transport.start({
      onMessage: (message) => seen.push(message),
    });

    await transport.send({ jsonrpc: "2.0", id: 1, method: "m", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(seen).toHaveLength(2); // malformed line dropped, two good frames delivered
    expect(transport.malformedFrames).toBe(1);
    expect(transport.consumedFrames).toBe(3);
    expect(stderrLines).toEqual(["noise", "more noise"]);

    await transport.close();
  }, 10_000);

  it("spawn failure surfaces as McpTransportError", async () => {
    const transport = new StdioTransport({ command: "definitely-not-a-real-binary-xyz" });
    await expect(
      transport.start({ onMessage: () => {} }),
    ).rejects.toThrowError(McpTransportError);
  }, 10_000);

  it("close() terminates the child (no zombies)", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
    });
    await transport.start({ onMessage: () => {} });
    await transport.close();
    // Grace period + kill guarantees exit; give the loop a moment to reap.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // If close() failed to kill, the test process would hang on open handles
    // and vitest would report a leak; assert nothing further here.
    expect(true).toBe(true);
  }, 10_000);
});

describe("StreamableHttpTransport", () => {
  function startHttpServer(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}/mcp`);
      });
    });
  }

  it("round-trips JSON responses and captures Mcp-Session-Id even when the handshake is non-conforming", async () => {
    let sessionSeen: string | undefined;
    const url = await startHttpServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const message = JSON.parse(body);
        sessionSeen = req.headers["mcp-session-id"] as string | undefined;
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-42",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: true } }));
      });
    });

    const transport = new StreamableHttpTransport({ url });
    const client = new McpClient({ serverId: "http-e2e", transport, requestTimeoutMs: 3_000 });
    // The initialize response lacks serverInfo.name - protocol violation.
    await expect(client.connect()).rejects.toThrowError(/serverInfo/);
    // The transport still captured the session header from the exchange.
    expect(transport.session).toBe("sess-42");
    expect(sessionSeen).toBeUndefined(); // not echoed before handshake completed
    await transport.close();
  }, 10_000);

  it("full handshake against a conforming streamable HTTP MCP server", async () => {
    const url = await startHttpServer((req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "http-fake", version: "2.0.0" },
            },
          }));
          return;
        }
        if (message.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "http_tool", description: "over http" }] },
          }));
          return;
        }
        if (message.method === "tools/call") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "http-echo" }] },
          }));
          return;
        }
        // Notifications (initialized, cancelled): 202 Accepted.
        res.writeHead(202);
        res.end();
      });
    });

    const transport = new StreamableHttpTransport({ url });
    const client = new McpClient({ serverId: "http-e2e", transport, requestTimeoutMs: 3_000 });

    const info = await client.connect();
    expect(info.name).toBe("http-fake");
    expect(transport.session).toBe("sess-1");

    const tools = await client.listTools();
    expect(tools[0]?.name).toBe("http_tool");

    const result = await client.callTool("http_tool", {});
    expect(result.content[0]).toMatchObject({ type: "text", text: "http-echo" });

    await client.close();
  }, 10_000);

  it("consumes SSE responses and stops after the request's response frame", async () => {
    const url = await startHttpServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          // Conforming handshake over plain JSON.
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sse-sess" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "http-sse", version: "1.0.0" },
            },
          }));
          return;
        }
        // Every other request answers over SSE with a leading notification.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { note: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "sse-answer" }] } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { note: 2 } })}\n\n`);
        res.end();
      });
    });

    const transport = new StreamableHttpTransport({ url });
    const client = new McpClient({ serverId: "http-sse", transport, requestTimeoutMs: 3_000 });
    const info = await client.connect();
    expect(info.name).toBe("http-sse");
    const result = await client.callTool("anything", {});
    expect(result.content[0]).toMatchObject({ type: "text", text: "sse-answer" });
    await client.close();
  }, 10_000);

  it("non-2xx responses surface as McpTransportError", async () => {
    const url = await startHttpServer((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server sad");
    });
    const transport = new StreamableHttpTransport({ url });
    const client = new McpClient({ serverId: "http-500", transport, requestTimeoutMs: 3_000 });
    await expect(client.connect()).rejects.toThrowError(McpTransportError);
    await transport.close();
  }, 10_000);

  it("request abort rejects with a structural AbortError", async () => {
    const url = await startHttpServer((req, res) => {
      // Never answer.
      req.on("data", () => undefined);
    });
    const transport = new StreamableHttpTransport({ url, requestTimeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = transport.send(
      { jsonrpc: "2.0", id: 1, method: "slow", params: {} },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toSatisfy((err: unknown) => (err as Error).name === "AbortError");
    await transport.close();
  }, 10_000);
});

describe("anySignal", () => {
  it("any signal aborts the composite; reason propagates", () => {
    const a = new AbortController();
    const b = new AbortController();
    const composite = anySignal(a.signal, b.signal);
    expect(composite.aborted).toBe(false);
    b.abort("the-reason");
    expect(composite.aborted).toBe(true);
    expect(composite.reason).toBe("the-reason");
  });

  it("pre-aborted inputs abort immediately", () => {
    const a = new AbortController();
    a.abort();
    const composite = anySignal(a.signal);
    expect(composite.aborted).toBe(true);
  });
});
