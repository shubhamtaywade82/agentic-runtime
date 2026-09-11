import type { ResourceClass, ToolDefinition, ToolResult } from "../core/types.js";
import { ToolInvocationError } from "../hands/catalogue.js";
import { tokenizeForSearch } from "../capability/capability-index.js";
import type { McpServerSideEffectsDeclaration, McpTool } from "./types.js";
import type { ServerTrust } from "../policy/types.js";
import { jsonSchemaContract } from "./schema-contract.js";
import type { McpClient } from "./client.js";
import type { McpContent } from "./types.js";

/**
 * Options for the MCP -> runtime tool adapter.
 * @public
 */
export interface McpToolAdapterOptions {
  serverId: string;
  client: McpClient;
  trust: ServerTrust;
  sideEffects: McpServerSideEffectsDeclaration;
  serverVersion?: string;
  /** Per-call MCP timeout. Default: client default (30s). */
  callTimeoutMs?: number;
  /**
   * Handle prefix applied to every adapted tool. The registry default is
   * `${serverId}__` so two servers exposing the same tool name cannot
   * silently overwrite each other in the ToolkitCatalogue.
   */
  toolNamePrefix?: string;
}

/**
 * Map a server's declared side-effect surface and tool annotations onto the
 * Sentinel's concurrency resource class.
 *
 * Precedence: database > filesystem > network > process > compute.
 * Read-vs-write splits use the tool's readOnlyHint annotation.
 * @public
 */
export function resourceClassForMcpTool(
  sideEffects: McpServerSideEffectsDeclaration,
  annotations: McpTool["annotations"],
): ResourceClass {
  if (sideEffects.database) return "external-database";
  if (sideEffects.filesystem) {
    return annotations?.readOnlyHint === true ? "filesystem-read" : "filesystem-write";
  }
  if (sideEffects.network) return "external-network";
  if (sideEffects.process) return "local-sandbox";
  return "local-cpu";
}

/**
 * Map annotations + server trust onto the HumanProtocol grant level.
 *
 * - destructiveHint -> manual (privileged human gate)
 * - readOnlyHint on a verified-or-better server -> auto
 * - everything else -> acknowledged
 * @public
 */
export function grantLevelForMcpTool(
  annotations: McpTool["annotations"],
  trust: ServerTrust,
): "auto" | "acknowledged" | "manual" {
  if (annotations?.destructiveHint === true) return "manual";
  if (annotations?.readOnlyHint === true && (trust === "official" || trust === "verified")) {
    return "auto";
  }
  return "acknowledged";
}

/**
 * Adapt MCP server tools into runtime ToolDefinitions.
 *
 * The adapted tool is a first-class governed citizen: it flows through the
 * ToolkitCatalogue's strict argument validation (JSON-Schema contract),
 * Sentinel resource-class gating, deadline guards, output fencing and
 * truncation exactly like a native tool. Invocation bridges to
 * `client.callTool`; aborts propagate as structural AbortErrors so the
 * dispatcher classifies them as CEDED, not tool failure.
 * @public
 */
export function mcpToolsToToolDefinitions(
  tools: readonly McpTool[],
  opts: McpToolAdapterOptions,
): ToolDefinition<Record<string, unknown>>[] {
  // null = raw names (explicit opt-out); undefined = collision-proof default.
  const prefix =
    opts.toolNamePrefix === null ? "" : (opts.toolNamePrefix ?? `${opts.serverId}__`);
  return tools.map((tool) => adaptOne(tool, opts, prefix));
}

function adaptOne(
  tool: McpTool,
  opts: McpToolAdapterOptions,
  prefix: string,
): ToolDefinition<Record<string, unknown>> {
  const handle = `${prefix}${tool.name}`;
  const annotations = tool.annotations;

  const definition: ToolDefinition<Record<string, unknown>> = {
    handle,
    caption: tool.description ?? `MCP tool '${tool.name}' from server '${opts.serverId}'`,
    argsShape: jsonSchemaContract(tool.inputSchema),
    resourceClass: resourceClassForMcpTool(opts.sideEffects, annotations),
    effects:
      annotations?.readOnlyHint === true || annotations?.idempotentHint === true
        ? "pure"
        : "transactional",
    grantLevel: grantLevelForMcpTool(annotations, opts.trust),
    ...(opts.callTimeoutMs !== undefined ? { timeoutMs: opts.callTimeoutMs } : {}),
    source: "mcp",
    serverId: opts.serverId,
    ...(opts.serverVersion !== undefined ? { version: opts.serverVersion } : {}),
    sideEffects: {
      ...(opts.sideEffects.filesystem
        ? { filesystem: annotations?.readOnlyHint === true ? ("read" as const) : ("write" as const) }
        : {}),
      ...(opts.sideEffects.network
        ? { network: opts.sideEffects.externalMutation ? ("write" as const) : ("read" as const) }
        : {}),
      ...(opts.sideEffects.database
        ? { database: opts.sideEffects.externalMutation ? ("write" as const) : ("read" as const) }
        : {}),
      ...(opts.sideEffects.process ? { process: true } : {}),
    },
    discoverability: {
      keywords: [
        tool.name,
        ...tool.name.split(/[_\-.]+/),
        ...(tool.description ? tokenizeForSearch(tool.description).slice(0, 12) : []),
      ],
      category: opts.serverId,
    },
    invoke: async (args, _lease, cancelToken): Promise<ToolResult> => {
      try {
        const result = await opts.client.callTool(tool.name, args, {
          signal: cancelToken,
          ...(opts.callTimeoutMs !== undefined ? { timeoutMs: opts.callTimeoutMs } : {}),
        });
        return {
          toolCallId: `mcp-${opts.serverId}-${tool.name}`,
          name: handle,
          success: result.isError !== true,
          output: extractMcpOutput(result.content, result.structuredContent),
          ...(result.isError === true
            ? {
                error: `MCP server reported execution failure for tool '${tool.name}'.`,
              }
            : {}),
          trustLevel: "unverified",
          executionTimeMs: 0,
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new ToolInvocationError(
          `MCP tool '${tool.name}' on server '${opts.serverId}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "execution",
        );
      }
    },
  };
  return definition;
}

/**
 * Flatten MCP content blocks into a model-consumable output value.
 *
 * Text blocks join with newlines; structuredContent (when present and the
 * only signal) serializes as JSON; image/audio blocks summarize as
 * placeholders (the runtime does not interpret binary content).
 * @public
 */
export function extractMcpOutput(
  content: readonly McpContent[],
  structuredContent: Record<string, unknown> | undefined,
): unknown {
  const texts: string[] = [];
  const summaries: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "resource":
        if (block.resource.text !== undefined) {
          texts.push(block.resource.text);
        } else {
          summaries.push(`[resource ${block.resource.uri}]`);
        }
        break;
      case "resource_link":
        summaries.push(`[resource_link ${block.uri}]`);
        break;
      case "image":
        summaries.push(`[image ${block.mimeType}]`);
        break;
      case "audio":
        summaries.push(`[audio ${block.mimeType}]`);
        break;
    }
  }
  const text = texts.join("\n");
  if (text.length > 0) {
    return summaries.length > 0 ? `${text}\n${summaries.join(" ")}` : text;
  }
  if (structuredContent !== undefined) return structuredContent;
  if (summaries.length > 0) return summaries.join(" ");
  return "";
}
