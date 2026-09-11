import {
  AgentRuntimeError,
  type EventSink,
  type ThoughtProcess,
  type ToolDefinition,
  type ChatMsg,
} from "../core/types.js";
import { ContextManager, createDefaultDigestionPipeline } from "../memory/context-manager.js";
import type { DigestionPipeline } from "../memory/context-manager.js";
import { AgentRunner } from "../loop/agent-runner.js";
import type { RunBudgets, RunResult } from "../loop/agent-runner.js";
import { CapabilityRouter } from "../capability/router.js";
import { TopKCapabilitySelector } from "../capability/selector.js";
import type { CapabilitySelector } from "../capability/selector.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import type { CapabilityPolicy } from "../policy/types.js";
import { GrantLevelPolicy } from "../policy/grant-level-policy.js";
import type { ApprovalProvider } from "../policy/approval.js";
import { ResourceSentinel } from "../sentinel/index.js";
import { ProgressiveDiscovery } from "../mcp/progressive-discovery.js";
import { McpServerRegistry } from "../mcp/registry.js";
import type { McpServerConfig, RegisteredMcpServer } from "../mcp/types.js";
import { StaticModelRouter } from "../router/types.js";
import type { ModelRouter } from "../router/types.js";

/**
 * Configuration for createAgentRuntime.
 * @public
 */
export interface AgentRuntimeConfig {
  /**
   * The single brain (model adapter). Mutually exclusive with `router`.
   */
  brain?: ThoughtProcess;
  /**
   * A model router (hybrid topologies). Mutually exclusive with `brain`.
   * StaticModelRouter and DeclarativeModelRouter both expose their default
   * brain, which becomes the primary brain for working-memory digestion.
   */
  router?: ModelRouter;
  /** Native tools to register. */
  tools?: ToolDefinition[];
  /**
   * MCP servers to connect at startup. Tools are adapted into the governed
   * catalogue and participate in progressive discovery.
   */
  mcp?: {
    servers: McpServerConfig[];
    /** Top-k capabilities mounted per run. Default 8. */
    limit?: number;
    /** Per-MCP-call timeout forwarded to adapted tools. */
    callTimeoutMs?: number;
  };
  /** Dispatch policy. Default: GrantLevelPolicy with MCP trust injected. */
  policy?: CapabilityPolicy;
  /** Human approval provider for REQUIRE_APPROVAL decisions. */
  approvals?: ApprovalProvider;
  /** Approval wait ceiling before fail-closed denial. Default 60s. */
  approvalTimeoutMs?: number;
  /** Run budgets (steps, wall clock, intents, tokens per step). */
  budgets?: Partial<RunBudgets>;
  /** The admin charter (system prompt). */
  charter?: string;
  /** Observability sink. Default: discard (noop). */
  sink?: EventSink;
  /** Hardware sentinel. Default: single-inference, 4-tool, depth-64 gates. */
  sentinel?: ResourceSentinel;
  /** Capability selector. Default: TopK(limit) when MCP is configured, else mount-all. */
  capabilitySelector?: CapabilitySelector;
  /** Working memory configuration. */
  context?: {
    /** Model context window in tokens. Default 8192. */
    modelCapacityTokenCeiling?: number;
    /** Verbatim tail retained under compaction. Default 10. */
    reserveFreshTailCount?: number;
    /** Style hint for digestion summaries. */
    digestStyleHint?: string;
    /** Custom digestion pipeline (defaults to the primary brain, no tools). */
    digestionPipeline?: DigestionPipeline;
  };
}

/**
 * The high-level runtime handle.
 * @public
 */
export interface AgentRuntime {
  /** One-shot run with a fresh context lane. */
  run(objective: string): Promise<RunResult>;
  /** Create a stateful session (context continuity across runs). */
  createSession(): AgentSession;
  /** Connect another MCP server at runtime (requires config.mcp). */
  addMcpServer(config: McpServerConfig): Promise<RegisteredMcpServer>;
  /** Every registered capability descriptor (native + MCP). */
  capabilities(): CapabilityDescriptor[];
  /** The live MCP trust map for policy injection ({ serverId: trust }). */
  trustMap(): Record<string, string>;
  /** Tear down MCP connections. */
  close(): Promise<void>;
}

/**
 * A stateful agent session: the context lane survives across runs (charter
 * pinned, history compacted by digestion), and each run gets fresh budgets
 * plus its own kill switch.
 * @public
 */
export interface AgentSession {
  /** Run one objective to completion; context accumulates across runs. */
  run(objective: string): Promise<RunResult>;
  /** Abort the active run (the run seals as CEDED). */
  abort(reason?: string): void;
  /** The live context lane (read-only view). */
  readonly lane: readonly ChatMsg[];
}

/**
 * Default charter when none is supplied.
 * @public
 */
export const DEFAULT_AGENT_CHARTER =
  "You are an autonomous agent. Choose tools when they help; ground every claim in tool evidence; " +
  "prefer the minimal viable action; finish with a concise, factual final report.";

/**
 * Default sentinel topology: one inference at a time (the documented
 * mitigation for cross-model GPU contention), four concurrent tools,
 * queue depth 64.
 * @public
 */
export const DEFAULT_SENTINEL_TOPOLOGY = {
  maxParallelInferences: 1,
  maxParallelTools: 4,
  maxQueueDepth: 64,
} as const;

class AgentRuntimeKernel implements AgentRuntime {
  readonly capabilityRouter: CapabilityRouter;
  readonly registry: McpServerRegistry;
  private readonly discovery: ProgressiveDiscovery | null;
  private readonly primaryBrain: ThoughtProcess;
  private readonly router: ModelRouter;
  private readonly policy: CapabilityPolicy | undefined;
  private readonly approvals: ApprovalProvider | undefined;
  private readonly approvalTimeoutMs: number | undefined;
  private readonly budgets: Partial<RunBudgets> | undefined;
  private readonly charter: string;
  private readonly sink: EventSink;
  private readonly sentinel: ResourceSentinel;
  private readonly capabilitySelector: CapabilitySelector | undefined;
  private readonly contextConfig: {
    modelCapacityTokenCeiling: number;
    reserveFreshTailCount: number;
    digestStyleHint: string;
    digestionPipeline?: DigestionPipeline;
  };

  constructor(
    config: AgentRuntimeConfig,
    primaryBrain: ThoughtProcess,
    discovery: ProgressiveDiscovery | null,
    capabilityRouter: CapabilityRouter,
    registry: McpServerRegistry,
  ) {
    this.primaryBrain = primaryBrain;
    this.router = config.router ?? new StaticModelRouter(primaryBrain);
    this.sink = config.sink ?? { emit: () => {} };
    this.sentinel =
      config.sentinel ?? new ResourceSentinel({ ...DEFAULT_SENTINEL_TOPOLOGY }, this.sink);
    this.capabilityRouter = capabilityRouter;
    this.registry = registry;
    this.discovery = discovery;
    this.policy = config.policy;
    this.approvals = config.approvals;
    this.approvalTimeoutMs = config.approvalTimeoutMs;
    this.budgets = config.budgets;
    this.charter = config.charter ?? DEFAULT_AGENT_CHARTER;
    this.capabilitySelector = config.capabilitySelector;
    this.contextConfig = {
      modelCapacityTokenCeiling: config.context?.modelCapacityTokenCeiling ?? 8_192,
      reserveFreshTailCount: config.context?.reserveFreshTailCount ?? 10,
      digestStyleHint: config.context?.digestStyleHint ?? "Concise factual digest of tool outcomes.",
      ...(config.context?.digestionPipeline !== undefined
        ? { digestionPipeline: config.context.digestionPipeline }
        : {}),
    };

    if (config.tools !== undefined && config.tools.length > 0) {
      this.capabilityRouter.registerNativeTools(config.tools);
    }
  }

  capabilities(): CapabilityDescriptor[] {
    return this.capabilityRouter.getIndex().list();
  }

  trustMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [serverId, trust] of Object.entries(this.registry.trustMap())) {
      out[serverId] = trust;
    }
    return out;
  }

  /**
   * Effective policy: the user-supplied one, or (when MCP servers exist)
   * the default GrantLevelPolicy seeded with the LIVE trust map so servers
   * connected later are governed correctly.
   */
  effectivePolicy(): CapabilityPolicy | undefined {
    if (this.policy !== undefined) return this.policy;
    if (this.registry.list().length === 0) return undefined;
    const registry = this.registry;
    return {
      evaluate: (request) =>
        new GrantLevelPolicy({ serverTrust: registry.trustMap() }).evaluate(request),
    };
  }

  newContext(): ContextManager {
    const pipeline =
      this.contextConfig.digestionPipeline ??
      createDefaultDigestionPipeline(this.primaryBrain, {
        mounting: { manifests: [] },
        killSwitch: new AbortController().signal,
        upperBoundTokenCount: 4_096,
      });
    return new ContextManager(
      {
        modelCapacityTokenCeiling: this.contextConfig.modelCapacityTokenCeiling,
        reserveFreshTailCount: this.contextConfig.reserveFreshTailCount,
        digestStyleHint: this.contextConfig.digestStyleHint,
      },
      pipeline,
    );
  }

  createRunner(
    context: ContextManager,
    laneMode: "replace" | "append",
    abortRef: { current: AgentRunner | null },
  ): AgentRunner {
    const runner = new AgentRunner(this.primaryBrain, this.capabilityRouter.getCatalogue(), context, {
      adminCharter: this.charter,
      ...(this.budgets !== undefined ? { budgets: this.budgets } : {}),
      sentinel: this.sentinel,
      ...(this.capabilitySelector !== undefined ? { capabilitySelector: this.capabilitySelector } : {}),
      ...(this.effectivePolicy() !== undefined ? { policy: this.effectivePolicy()! } : {}),
      ...(this.approvals !== undefined ? { approvals: this.approvals } : {}),
      ...(this.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: this.approvalTimeoutMs } : {}),
      router: this.router,
      laneMode,
      sink: this.sink,
    });
    abortRef.current = runner;
    return runner;
  }

  async run(objective: string): Promise<RunResult> {
    const abortRef: { current: AgentRunner | null } = { current: null };
    const runner = this.createRunner(this.newContext(), "replace", abortRef);
    return runner.run(objective);
  }

  createSession(): AgentSession {
    const context = this.newContext();
    context.pinCharter({ role: "system", content: this.charter });
    const abortRef: { current: AgentRunner | null } = { current: null };
    const createRunner = this.createRunner.bind(this);

    return {
      async run(objective: string): Promise<RunResult> {
        return createRunner(context, "append", abortRef).run(objective);
      },
      abort(reason?: string): void {
        abortRef.current?.getAbortController().abort(reason ?? "session abort");
      },
      get lane(): readonly ChatMsg[] {
        return context.lane;
      },
    };
  }

  async addMcpServer(config: McpServerConfig): Promise<RegisteredMcpServer> {
    if (this.discovery === null) {
      throw new AgentRuntimeError(
        "This runtime was created without MCP support; pass config.mcp to createAgentRuntime.",
        "MCP_CONFIG_INVALID",
      );
    }
    return this.discovery.connectServer(config);
  }

  async close(): Promise<void> {
    await this.discovery?.close();
  }
}

/**
 * Resolve the primary brain (used for working-memory digestion) from the
 * config: the explicit brain, or the router's default brain.
 */
function primaryBrainOf(config: AgentRuntimeConfig): ThoughtProcess {
  if (config.brain !== undefined) return config.brain;
  const router = config.router;
  if (router === undefined) {
    throw new AgentRuntimeError(
      "createAgentRuntime requires exactly one of config.brain or config.router.",
      "RUNTIME_CONFIG_INVALID",
    );
  }
  const candidate = (router as unknown as { singleBrain?: ThoughtProcess }).singleBrain;
  if (candidate !== undefined) return candidate;
  const declarative = (router as unknown as { defaultBrain?: ThoughtProcess }).defaultBrain;
  if (declarative !== undefined) return declarative;
  throw new AgentRuntimeError(
    "Cannot infer a primary brain from this router; pass config.brain alongside config.router " +
      "(the primary brain is used for working-memory digestion).",
    "RUNTIME_CONFIG_INVALID",
  );
}

/**
 * Create the high-level agent runtime.
 *
 * Wires brain (or router) + native tools + optional MCP servers (progressive
 * discovery) + policy + approvals + budgets + sentinel into one handle with
 * two execution shapes:
 *
 * - `runtime.run(objective)` - one-shot, fresh context, sealed FinalReport
 * - `runtime.createSession()` - context continuity across runs, abortable
 *
 * Fail-closed configuration: exactly one of `brain`/`router` is required;
 * MCP servers are connected (or the failure surfaces) before the runtime
 * handle is returned.
 *
 * @param config - the runtime configuration
 * @public
 */
export async function createAgentRuntime(config: AgentRuntimeConfig): Promise<AgentRuntime> {
  if (config.brain !== undefined && config.router !== undefined) {
    throw new AgentRuntimeError(
      "createAgentRuntime accepts config.brain OR config.router, not both.",
      "RUNTIME_CONFIG_INVALID",
    );
  }
  const primaryBrain = primaryBrainOf(config);

  const sink = config.sink ?? { emit: () => {} };
  const sentinel = config.sentinel ?? new ResourceSentinel({ ...DEFAULT_SENTINEL_TOPOLOGY }, sink);
  const capabilityRouter = new CapabilityRouter({ sink, sentinel });
  const registry = new McpServerRegistry({ sink });

  let discovery: ProgressiveDiscovery | null = null;
  let capabilitySelector = config.capabilitySelector;
  if (config.mcp !== undefined && config.mcp.servers.length > 0) {
    const limit = config.mcp.limit ?? 8;
    discovery = new ProgressiveDiscovery({
      registry,
      router: capabilityRouter,
      ...(capabilitySelector !== undefined
        ? { selector: capabilitySelector }
        : { selector: new TopKCapabilitySelector({ limit }) }),
      ...(config.mcp.callTimeoutMs !== undefined
        ? { callTimeoutMs: config.mcp.callTimeoutMs }
        : {}),
    });
    if (capabilitySelector === undefined) {
      capabilitySelector = new TopKCapabilitySelector({ limit });
    }
    for (const server of config.mcp.servers) {
      await discovery.connectServer(server);
    }
  }

  return new AgentRuntimeKernel(
    capabilitySelector !== undefined ? { ...config, capabilitySelector } : config,
    primaryBrain,
    discovery,
    capabilityRouter,
    registry,
  );
}
