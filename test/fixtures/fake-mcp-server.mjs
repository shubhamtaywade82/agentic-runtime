#!/usr/bin/env node
/**
 * Minimal MCP server over stdio for tests and manual experiments.
 *
 * Protocol: NDJSON JSON-RPC 2.0 on stdin/stdout (MCP stdio transport).
 * Surface: initialize, tools/list, tools/call (echo), notifications/initialized.
 *
 * Usage:
 *   node test/fixtures/fake-mcp-server.mjs
 *   npx @modelcontextprotocol/inspector node test/fixtures/fake-mcp-server.mjs
 */
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "read_file",
    description: "Reads a file from the allowed directories",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Writes a file into the allowed directories",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: false },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Malformed frame: drop silently (client counts it).
  }

  const { id, method, params } = message;
  if (method === undefined) return; // Response routed to somebody else.

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fake-fs", version: "1.0.0" },
        },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const name = params?.name ?? "unknown";
      const args = params?.arguments ?? {};
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `echo:${name}:${JSON.stringify(args)}` }],
        },
      });
      return;
    }
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
  }
});

// Die with the parent (test runner) instead of lingering.
process.stdin.on("end", () => process.exit(0));
