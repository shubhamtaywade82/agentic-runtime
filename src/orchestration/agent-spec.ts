import type { ThoughtProcess } from "../core/types.js";
import { ToolkitCatalogue } from "../hands/catalogue.js";
import { ToolDispatcher } from "../hands/tool-dispatcher.js";
import { ContextManager } from "../memory/context-manager.js";
import { RepeatCallBinder } from "../loop/repeat-call-binder.js";

/**
 * Rights constraints for an agent specification.
 * Template members carry a payload after the colon (e.g. "max-tokens:4000",
 * "allowed-tools:search,read").
 * @public
 */
export type RightsConstraint =
  | "read-only"
  | "no-external-network"
  | "no-filesystem-write"
  | `max-tokens:${number}`
  | `max-wall-ms:${number}`
  | `allowed-tools:${string}`;

/**
 * Agent specification - defines an agent's role, capabilities, and constraints.
 * @public
 */
export interface AgentSpec {
  /** Unique codename for this agent role */
  codename: string;
  /** Human-readable description of the agent's duty scope */
  dutyScope: string;
  /** Constraint strings parsed by the runtime */
  rightsConstraints: RightsConstraint[];
  /** Hint for the agent's internal charter generation */
  curvatureFieldsHint: string;
  /** Tools this agent is allowed to use (handles) */
  allowedToolHandles: string[];
}

/**
 * Agent registry - manages available agent specifications.
 * @public
 */
export class AgentRegistry {
  private specs = new Map<string, AgentSpec>();
  private toolCatalogue: ToolkitCatalogue;

  constructor(toolCatalogue: ToolkitCatalogue) {
    this.toolCatalogue = toolCatalogue;
  }

  /**
   * Register an agent specification.
   * @public
   */
  register(spec: AgentSpec): this {
    this.specs.set(spec.codename, spec);
    return this;
  }

  /**
   * Get an agent specification by codename.
   * @public
   */
  get(codename: string): AgentSpec | undefined {
    return this.specs.get(codename);
  }

  /**
   * List all registered agent codenames.
   * @public
   */
  listCodenames(): string[] {
    return [...this.specs.keys()];
  }

  /**
   * Create a tool catalogue filtered to this agent's allowed tools.
   * @public
   */
  createFilteredCatalogue(codename: string): ToolkitCatalogue {
    const spec = this.specs.get(codename);
    if (!spec) throw new Error(`Unknown agent codename: ${codename}`);
    
    const filtered = new ToolkitCatalogue({ emit: () => {} });
    for (const handle of spec.allowedToolHandles) {
      const tool = this.toolCatalogue.get(handle);
      if (tool) filtered.place(tool);
    }
    return filtered;
  }
}

/**
 * Agent instance - a runtime instance of an AgentSpec with its own state.
 * @public
 */
export interface AgentInstance {
  spec: AgentSpec;
  catalogue: ToolkitCatalogue;
  dispatcher: ToolDispatcher;
  context: ContextManager;
  binder: RepeatCallBinder;
  killSwitch: AbortSignal;
}

/**
 * Create an agent instance from a spec.
 * @public
 */
export function createAgentInstance(
  spec: AgentSpec,
  toolCatalogue: ToolkitCatalogue,
  brain: ThoughtProcess,
  globalKillSwitch: AbortSignal,
  contextManagerConfig: ConstructorParameters<typeof ContextManager>[0],
  digestionPipeline: ConstructorParameters<typeof ContextManager>[1],
): AgentInstance {
  const catalogue = new ToolkitCatalogue({ emit: () => {} });
  for (const handle of spec.allowedToolHandles) {
    const tool = toolCatalogue.get(handle);
    if (tool) catalogue.place(tool);
  }

  const dispatcher = new ToolDispatcher(catalogue, globalKillSwitch);
  const context = new ContextManager(contextManagerConfig, digestionPipeline);
  const binder = new RepeatCallBinder();

  return {
    spec,
    catalogue,
    dispatcher,
    context,
    binder,
    killSwitch: globalKillSwitch,
  };
}

/**
 * Standard agent specs for common roles.
 * @public
 */
export const STANDARD_AGENT_SPECS: AgentSpec[] = [
  {
    codename: "researcher",
    dutyScope: "Information gathering and fact retrieval via search/read tools",
    rightsConstraints: ["read-only", "no-filesystem-write", "allowed-tools:search,read,fetch"],
    curvatureFieldsHint: "Prioritize primary sources; cite evidence precisely; flag uncertainty.",
    allowedToolHandles: ["search", "read", "fetch"],
  },
  {
    codename: "analyst",
    dutyScope: "Synthesis, pattern detection, and structured reasoning over gathered evidence",
    rightsConstraints: ["read-only", "no-external-network", "allowed-tools:compute,transform"],
    curvatureFieldsHint: "Ground every claim in cited receipts; quantify confidence; expose assumptions.",
    allowedToolHandles: ["compute", "transform"],
  },
  {
    codename: "auditor",
    dutyScope: "Validation, compliance checking, and adversarial review of peer outputs",
    rightsConstraints: ["read-only", "allowed-tools:validate,lint,audit"],
    curvatureFieldsHint: "Apply deterministic checks; reject on first violation; emit actionable diffs.",
    allowedToolHandles: ["validate", "lint", "audit"],
  },
  {
    codename: "planner",
    dutyScope: "Strategic decomposition and execution graph construction",
    rightsConstraints: ["read-only", "allowed-tools:plan,schedule,estimate"],
    curvatureFieldsHint: "Decompose into minimal independent steps; expose dependency graph; estimate budgets.",
    allowedToolHandles: ["plan", "schedule", "estimate"],
  },
];

/**
 * Create an AgentRegistry with standard specs.
 * @public
 */
export function createStandardAgentRegistry(toolCatalogue: ToolkitCatalogue): AgentRegistry {
  const registry = new AgentRegistry(toolCatalogue);
  for (const spec of STANDARD_AGENT_SPECS) {
    registry.register(spec);
  }
  return registry;
}