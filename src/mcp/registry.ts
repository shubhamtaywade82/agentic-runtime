import type { EventSink } from "../core/types.js";
import { McpConfigError } from "./errors.js";
import { McpClient } from "./client.js";
import { StdioTransport, StreamableHttpTransport } from "./transport.js";
import type { McpTransport } from "./transport.js";
import type { ServerTrust } from "../policy/types.js";
import type {
  McpServerConfig,
  McpServerSideEffectsDeclaration,
  RegisteredMcpServer,
} from "./types.js";
import { CONSERVATIVE_SIDE_EFFECTS } from "./types.js";
import { MCP_METRICS, MCP_LABEL_KEYS } from "../observability/metrics.js";

/**
 * Registry options.
 * @public
 */
export interface McpServerRegistryOptions {
  sink?: EventSink;
  /** Trust applied when a config declares none. Default "unknown". */
  defaultTrust?: ServerTrust;
}

interface RegistryEntry {
  registered: RegisteredMcpServer;
  client: McpClient;
}

/**
 * McpServerRegistry - connection lifecycle and inventory for MCP servers.
 *
 * connect() builds the transport (stdio or streamable HTTP), runs the
 * initialize handshake, snapshots the server's tools/resources/prompts and
 * records the policy metadata (trust + declared side effects) that the
 * tool adapter and policy engine consume. The live client is retained so
 * disconnect() can actually tear the connection down and adapters can
 * bridge calls through clientOf().
 *
 * Config validation is fail-closed: stdio requires command, http requires
 * url, and a duplicate serverId throws.
 * @public
 */
export class McpServerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly sink?: EventSink | undefined;
  private readonly defaultTrust: ServerTrust;

  constructor(opts: McpServerRegistryOptions = {}) {
    this.sink = opts.sink;
    this.defaultTrust = opts.defaultTrust ?? "unknown";
  }

  /**
   * Connect one MCP server and snapshot its capability surface.
   * @public
   */
  async connect(config: McpServerConfig): Promise<RegisteredMcpServer> {
    this.validate(config);
    if (this.entries.has(config.serverId)) {
      throw new McpConfigError(`MCP server '${config.serverId}' is already registered.`);
    }

    const client = new McpClient({
      serverId: config.serverId,
      transport: this.buildTransport(config),
      ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      ...(this.sink !== undefined ? { sink: this.sink } : {}),
      onToolsChanged: async (serverId) => {
        // Best-effort live refresh when the server signals a tool change.
        try {
          await this.refresh(serverId);
        } catch {
          // The caller-visible refresh() path surfaces errors; the
          // notification path only re-lists opportunistically.
        }
      },
    });

    const serverInfo = await client.connect();
    const capabilities = client.serverCapabilities ?? {};
    const tools = capabilities.tools !== undefined ? await client.listTools() : [];
    const resources = capabilities.resources !== undefined ? await client.listResources() : [];
    const prompts = capabilities.prompts !== undefined ? await client.listPrompts() : [];

    const registered: RegisteredMcpServer = {
      serverId: config.serverId,
      config,
      serverInfo,
      capabilities,
      tools,
      resources,
      prompts,
    };
    this.entries.set(config.serverId, { registered, client });
    return registered;
  }

  /**
   * Re-list one server's surface over its live connection (no new
   * handshake). Unknown serverId throws.
   * @public
   */
  async refresh(serverId: string): Promise<RegisteredMcpServer> {
    const entry = this.entries.get(serverId);
    if (entry === undefined) throw new McpConfigError(`Unknown MCP server '${serverId}'.`);
    const capabilities = entry.client.serverCapabilities ?? entry.registered.capabilities;
    const tools = capabilities.tools !== undefined ? await entry.client.listTools() : [];
    const resources = capabilities.resources !== undefined ? await entry.client.listResources() : [];
    const prompts = capabilities.prompts !== undefined ? await entry.client.listPrompts() : [];

    entry.registered = {
      ...entry.registered,
      capabilities,
      tools,
      resources,
      prompts,
    };
    return entry.registered;
  }

  /**
   * Disconnect one server and tear down its transport. Unknown ids are
   * ignored (idempotent).
   * @public
   */
  async disconnect(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (entry === undefined) return;
    this.entries.delete(serverId);
    await entry.client.close();
    this.sink?.emit(MCP_METRICS.DISCONNECTED_TOTAL, {
      [MCP_LABEL_KEYS.SERVER]: serverId,
    });
  }

  /**
   * Disconnect every registered server.
   * @public
   */
  async disconnectAll(): Promise<void> {
    for (const serverId of [...this.entries.keys()]) {
      await this.disconnect(serverId);
    }
  }

  /**
   * Registered server snapshot, or undefined.
   * @public
   */
  get(serverId: string): RegisteredMcpServer | undefined {
    return this.entries.get(serverId)?.registered;
  }

  /**
   * The live client for a connected server (adapter bridge).
   * @public
   */
  clientOf(serverId: string): McpClient | undefined {
    return this.entries.get(serverId)?.client;
  }

  /**
   * Inventory of every registered server.
   * @public
   */
  list(): RegisteredMcpServer[] {
    return [...this.entries.values()].map((entry) => entry.registered);
  }

  /**
   * Trust classification for policy injection:
   * `{ serverId: trust }` for every registered server.
   * @public
   */
  trustMap(): Record<string, ServerTrust> {
    const map: Record<string, ServerTrust> = {};
    for (const server of this.list()) {
      map[server.serverId] = this.trustOf(server.serverId);
    }
    return map;
  }

  /**
   * Effective trust for one server (connected or not).
   * @public
   */
  trustOf(serverId: string): ServerTrust {
    return this.entries.get(serverId)?.registered.config.trust ?? this.defaultTrust;
  }

  /**
   * Effective side-effect declaration for one server.
   * @public
   */
  sideEffectsOf(serverId: string): McpServerSideEffectsDeclaration {
    return this.entries.get(serverId)?.registered.config.sideEffects ?? CONSERVATIVE_SIDE_EFFECTS;
  }

  /**
   * Effective tool-name prefix for one server:
   * `${serverId}__` by default, null when the config opted out,
   * or the custom prefix.
   * @public
   */
  toolNamePrefixOf(serverId: string): string | null {
    const config = this.entries.get(serverId)?.registered.config;
    if (config === undefined || config.toolNamePrefix === undefined) return `${serverId}__`;
    return config.toolNamePrefix;
  }

  private validate(config: McpServerConfig): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.serverId)) {
      throw new McpConfigError(
        `serverId '${config.serverId}' must be alphanumeric/dash/dot (it is embedded in tool handles).`,
      );
    }
    if (config.transport === "stdio" && (config.command === undefined || config.command.length === 0)) {
      throw new McpConfigError(`stdio server '${config.serverId}' requires a command.`);
    }
    if (config.transport === "http" && (config.url === undefined || config.url.length === 0)) {
      throw new McpConfigError(`http server '${config.serverId}' requires a url.`);
    }
    if (config.transport !== "stdio" && config.transport !== "http") {
      throw new McpConfigError(
        `Unknown transport '${String(config.transport)}' for server '${config.serverId}'.`,
      );
    }
  }

  private buildTransport(config: McpServerConfig): McpTransport {
    if (config.transport === "stdio") {
      return new StdioTransport({
        command: config.command ?? "",
        ...(config.args !== undefined ? { args: config.args } : {}),
        ...(config.env !== undefined ? { env: config.env } : {}),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(this.sink !== undefined
          ? {
              onStderrLine: (line: string) =>
                this.sink!.emit(MCP_METRICS.SERVER_STDERR_LINE, {
                  [MCP_LABEL_KEYS.SERVER]: config.serverId,
                  line: line.slice(0, 500),
                }),
            }
          : {}),
      });
    }
    return new StreamableHttpTransport({
      url: config.url ?? "",
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
    });
  }
}
