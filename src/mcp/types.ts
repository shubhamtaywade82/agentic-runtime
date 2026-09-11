import type { JSONSchema7 } from "../core/types.js";
import type { ServerTrust } from "../policy/types.js";

// ============================================================================
// MCP domain types (server-reported shapes)
// ============================================================================

/**
 * Tool annotations as defined by MCP. Hints, not guarantees - servers may
 * lie; the policy layer treats them as advisory input.
 * @public
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A tool advertised by an MCP server.
 * @public
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema7;
  annotations?: McpToolAnnotations;
}

/**
 * A resource advertised by an MCP server.
 * @public
 */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/**
 * Contents of one read resource.
 * @public
 */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  /** UTF-8 text content, when the resource is textual. */
  text?: string;
  /** Base64-encoded content, when the resource is binary. */
  blob?: string;
}

/**
 * A prompt template advertised by an MCP server.
 * @public
 */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * One message inside a rendered prompt.
 * @public
 */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpContent;
}

/**
 * MCP content blocks. The runtime consumes text and resource-link blocks;
 * image/audio blocks are surfaced but not interpreted.
 * @public
 */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

/**
 * Result of tools/call.
 * @public
 */
export interface McpToolCallResult {
  content: McpContent[];
  /** Server-side execution failure (distinct from protocol errors). */
  isError?: boolean;
  /** Structured output (2025-06-18 servers). */
  structuredContent?: Record<string, unknown>;
}

/**
 * Server identity reported by the initialize handshake.
 * @public
 */
export interface McpServerInfo {
  name: string;
  version?: string;
  /** Protocol version the server actually speaks (negotiated). */
  protocolVersion: string;
}

/**
 * Server capability surface reported at initialization.
 * @public
 */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  completions?: Record<string, unknown>;
}

// ============================================================================
// Client configuration
// ============================================================================

/**
 * Declared side-effect surface of an MCP server. Supplied by the operator
 * at registration time (the protocol cannot discover it) and used to route
 * adapted tools into the correct Sentinel resource class and policy path.
 * @public
 */
export interface McpServerSideEffectsDeclaration {
  network: boolean;
  filesystem: boolean;
  process: boolean;
  database: boolean;
  /** Whether the server mutates state outside the local machine (APIs, SaaS). */
  externalMutation: boolean;
}

/**
 * Conservative default declaration: assume network access, no local
 * filesystem/process/database access, and possible external mutation.
 * Operators should tighten this per server.
 * @public
 */
export const CONSERVATIVE_SIDE_EFFECTS: McpServerSideEffectsDeclaration = {
  network: true,
  filesystem: false,
  process: false,
  database: false,
  externalMutation: true,
};

/**
 * MCP server registration configuration.
 *
 * - transport "stdio": `command` is required (npx/uvx style servers).
 * - transport "http": `url` is required (streamable HTTP endpoint).
 *
 * `toolNamePrefix` controls how tool handles are namespaced:
 * - undefined (default): `${serverId}__` prefix - collision-proof when
 *   multiple servers expose the same tool name (e.g. two "search" tools)
 * - null: raw tool names (single-server setups that want clean names)
 * - string: a custom prefix
 * @public
 */
export interface McpServerConfig {
  serverId: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  trust?: ServerTrust;
  sideEffects?: McpServerSideEffectsDeclaration;
  toolNamePrefix?: string | null;
}

/**
 * Live state of one registered MCP server.
 * @public
 */
export interface RegisteredMcpServer {
  serverId: string;
  config: McpServerConfig;
  serverInfo: McpServerInfo;
  capabilities: McpServerCapabilities;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}
