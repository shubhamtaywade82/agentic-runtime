import type {
  GrantLevel,
  JSONSchema7,
  ResourceClass,
  ToolDefinition,
} from "../core/types.js";

/**
 * Capability kinds exposed by capability sources.
 *
 * - "tool": an invocable action the model can call (native or MCP tool)
 * - "resource": contextual data the application can attach to context
 * - "prompt": a reusable prompt/workflow template
 * @public
 */
export const CAPABILITY_KINDS = ["tool", "resource", "prompt"] as const;

/** @public */
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/**
 * Where a capability originates.
 *
 * - "native": a ToolDefinition registered in-process by the host application
 * - "mcp": a tool/resource/prompt discovered from a connected MCP server
 * - "remote": any future remote capability source (reserved)
 * @public
 */
export const CAPABILITY_SOURCES = ["native", "mcp", "remote"] as const;

/** @public */
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

/**
 * Declarative side-effect surface of a capability, used by policy and
 * discovery. Independent of the Sentinel's ResourceClass, which governs
 * *concurrency routing*; this governs *trust decisions*.
 * @public
 */
export interface CapabilitySideEffects {
  filesystem?: "read" | "write" | undefined;
  network?: "none" | "read" | "write" | undefined;
  database?: "none" | "read" | "write" | undefined;
  process?: boolean | undefined;
}

/**
 * Discovery metadata that lets the capability index rank a capability
 * against an objective without loading its full schema.
 * @public
 */
export interface CapabilityDiscoverability {
  /** Search keywords (tokenized, case-insensitive). */
  keywords: string[];
  /** Coarse category, e.g. "coding", "web", "memory". */
  category?: string | undefined;
  /** 0-100, higher = more generally relevant. Default 50. */
  priority?: number | undefined;
}

/**
 * Normalized description of one addressable capability, independent of its
 * source. Native tools, MCP tools, MCP resources and MCP prompts are all
 * described by this shape so selectors, policy and the capability index can
 * reason over them uniformly.
 * @public
 */
export interface CapabilityDescriptor {
  /** Stable unique id, e.g. "native:echo" or "mcp:filesystem:read_file". */
  id: string;
  /** Invocation name (tool handle / resource URI / prompt name). */
  name: string;
  description: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  /** Present when source is not "native": the originating server id. */
  serverId?: string;
  version?: string;
  /** JSON Schema of the input (tools) when known. */
  inputSchema?: JSONSchema7;
  effects?: "pure" | "transactional";
  resourceClass?: ResourceClass;
  grantLevel?: GrantLevel;
  sideEffects?: CapabilitySideEffects;
  discoverability?: CapabilityDiscoverability;
  /** Named permissions the capability claims (policy-matchable). */
  permissions?: string[];
}

/**
 * Compose the canonical capability id for a source.
 * @public
 */
export function capabilityId(
  source: CapabilitySource,
  serverId: string | undefined,
  name: string,
): string {
  return serverId === undefined ? `${source}:${name}` : `${source}:${serverId}:${name}`;
}

/**
 * Project a native ToolDefinition into a CapabilityDescriptor.
 *
 * The projection is lossless for policy-relevant metadata (effects, resource
 * class, grant level, side effects, discoverability) and keeps the runtime's
 * single registration site: the capability router places the tool into the
 * ToolkitCatalogue and indexes the descriptor in one atomic step.
 * @public
 */
export function toolToCapability(
  tool: ToolDefinition,
  opts: { source?: CapabilitySource | undefined; serverId?: string | undefined } = {},
): CapabilityDescriptor {
  const source: CapabilitySource = opts.source ?? tool.source ?? "native";
  const serverId = opts.serverId ?? tool.serverId;
  const descriptor: CapabilityDescriptor = {
    id: capabilityId(source, serverId, tool.handle),
    name: tool.handle,
    description: tool.caption,
    kind: "tool",
    source,
    effects: tool.effects,
    resourceClass: tool.resourceClass,
    grantLevel: tool.grantLevel,
  };
  if (serverId !== undefined) descriptor.serverId = serverId;
  if (tool.version !== undefined) descriptor.version = tool.version;
  if (tool.sideEffects !== undefined) descriptor.sideEffects = tool.sideEffects;
  if (tool.discoverability !== undefined) descriptor.discoverability = tool.discoverability;
  if (tool.permissions !== undefined) descriptor.permissions = tool.permissions;
  return descriptor;
}
