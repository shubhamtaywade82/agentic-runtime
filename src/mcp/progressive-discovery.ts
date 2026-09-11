import type { ChatMsg } from "../core/types.js";
import type { CapabilityRouter } from "../capability/router.js";
import type { MountedCapabilities, CapabilitySelector } from "../capability/selector.js";
import { TopKCapabilitySelector } from "../capability/selector.js";
import { tokenizeForSearch } from "../capability/capability-index.js";
import { capabilityId } from "../capability/types.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import { mcpToolsToToolDefinitions } from "./adapters.js";
import { McpServerRegistry } from "./registry.js";
import type { McpServerConfig, RegisteredMcpServer } from "./types.js";

/**
 * Progressive discovery options.
 * @public
 */
export interface ProgressiveDiscoveryOptions {
  registry: McpServerRegistry;
  router: CapabilityRouter;
  /** Selector deciding which capabilities the model sees. Default TopK(8). */
  selector?: CapabilitySelector;
  /** Per-MCP-call timeout forwarded to adapted tools. */
  callTimeoutMs?: number;
}

/**
 * ProgressiveDiscovery - connects MCP servers, registers their tools as
 * governed runtime capabilities, and narrows what the model *sees* per run.
 *
 * Flow:
 *   connectServer()  -> registry.connect -> adapt tools -> router.register
 *   selectFor()      -> selector over the router's index (objective + lane)
 *   disconnectServer -> registry.disconnect -> router.forgetServer
 *
 * Context efficiency is the point: a small model facing 300 MCP tools
 * mounts the top-k relevant ones per step while every registered tool
 * stays dispatchable, gated and fenced.
 * @public
 */
export class ProgressiveDiscovery {
  private readonly registry: McpServerRegistry;
  private readonly router: CapabilityRouter;
  private readonly selector: CapabilitySelector;
  private readonly callTimeoutMs: number | undefined;

  constructor(opts: ProgressiveDiscoveryOptions) {
    this.registry = opts.registry;
    this.router = opts.router;
    this.selector = opts.selector ?? new TopKCapabilitySelector({ limit: 8 });
    this.callTimeoutMs = opts.callTimeoutMs;
  }

  /**
   * The underlying server registry (for direct resource/prompt access).
   * @public
   */
  getRegistry(): McpServerRegistry {
    return this.registry;
  }

  /**
   * Connect a server and register its full capability surface.
   * @public
   */
  async connectServer(config: McpServerConfig): Promise<RegisteredMcpServer> {
    const server = await this.registry.connect(config);
    this.registerServerCapabilities(server);
    return server;
  }

  /**
   * Disconnect a server and drop its discovery surface.
   * @public
   */
  async disconnectServer(serverId: string): Promise<void> {
    await this.registry.disconnect(serverId);
    this.router.forgetServer(serverId);
  }

  /**
   * Disconnect everything.
   * @public
   */
  async close(): Promise<void> {
    for (const server of this.registry.list()) {
      await this.disconnectServer(server.serverId);
    }
  }

  /**
   * Re-register a server's capabilities after a live refresh (or a
   * tools/list_changed notification). The old discovery surface is dropped
   * first so tool sets never double-register.
   * @public
   */
  async refreshServer(serverId: string): Promise<RegisteredMcpServer> {
    const server = await this.registry.refresh(serverId);
    this.router.forgetServer(serverId);
    this.registerServerCapabilities(server);
    return server;
  }

  /**
   * Select the mounted capability set for an objective.
   * @public
   */
  async selectFor(objective: string, context: readonly ChatMsg[] = []): Promise<MountedCapabilities> {
    return this.selector.select({
      objective,
      context,
      available: this.router.getIndex().list(),
    });
  }

  /**
   * Mount manifests for an objective (convenience for AgentRunner wiring).
   * @public
   */
  async manifestsFor(objective: string, context: readonly ChatMsg[] = []) {
    const mounted = await this.selectFor(objective, context);
    return {
      mounted,
      manifests: this.router.manifestsFor(mounted),
    };
  }

  private registerServerCapabilities(server: RegisteredMcpServer): void {
    const client = this.registry.clientOf(server.serverId);
    if (client === undefined) return;

    const toolPrefix = this.registry.toolNamePrefixOf(server.serverId);
    const toolDefinitions = mcpToolsToToolDefinitions(server.tools, {
      serverId: server.serverId,
      client,
      trust: this.registry.trustOf(server.serverId),
      sideEffects: this.registry.sideEffectsOf(server.serverId),
      ...(server.serverInfo.version !== undefined ? { serverVersion: server.serverInfo.version } : {}),
      ...(this.callTimeoutMs !== undefined ? { callTimeoutMs: this.callTimeoutMs } : {}),
      ...(toolPrefix !== null ? { toolNamePrefix: toolPrefix } : {}),
    });
    this.router.registerTools(toolDefinitions, "mcp", server.serverId);

    // Resources and prompts participate in discovery (kind-filtered) even
    // though the loop only mounts tools in v0.2.
    const descriptors: CapabilityDescriptor[] = [
      ...server.resources.map(
        (resource): CapabilityDescriptor => ({
          id: capabilityId("mcp", server.serverId, resource.uri),
          name: resource.uri,
          description: resource.description ?? resource.name ?? resource.uri,
          kind: "resource",
          source: "mcp",
          serverId: server.serverId,
          resourceClass: "local-cpu",
          effects: "pure",
          grantLevel: "auto",
          discoverability: {
            keywords: ["resource", ...tokenizeForSearch(resource.name ?? resource.uri)],
            category: server.serverId,
          },
        }),
      ),
      ...server.prompts.map(
        (prompt): CapabilityDescriptor => ({
          id: capabilityId("mcp", server.serverId, prompt.name),
          name: prompt.name,
          description: prompt.description ?? prompt.name,
          kind: "prompt",
          source: "mcp",
          serverId: server.serverId,
          resourceClass: "local-cpu",
          effects: "pure",
          grantLevel: "auto",
          discoverability: {
            keywords: ["prompt", ...tokenizeForSearch(prompt.name)],
            category: server.serverId,
          },
        }),
      ),
    ];
    if (descriptors.length > 0) {
      this.router.registerDescriptors(descriptors);
    }
  }
}
