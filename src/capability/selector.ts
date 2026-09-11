import type { ChatMsg } from "../core/types.js";
import type { CapabilityDescriptor, CapabilityKind } from "./types.js";
import { scoreCapabilities } from "./capability-index.js";

/**
 * Input to capability selection: what the agent is doing, what it has seen,
 * and which capabilities are addressable right now.
 * @public
 */
export interface CapabilitySelectionInput {
  objective: string;
  context: readonly ChatMsg[];
  available: readonly CapabilityDescriptor[];
  /** Estimated context pressure 0..1 (used to shrink mounts). */
  contextPressure?: number;
  stepIndex?: number;
}

/**
 * The outcome of one selection pass.
 * @public
 */
export interface MountedCapabilities {
  capabilities: readonly CapabilityDescriptor[];
  /** Human-readable rationale for observability and debugging. */
  rationale: string;
}

/**
 * CapabilitySelector - decides which capabilities are presented to the model
 * on a given step. This is the seam that replaces the v0.1 "mount all tools"
 * behavior: small-context models (e.g. 2B-class) get a focused active toolset
 * while the full catalogue stays registered, dispatched and governed.
 * @public
 */
export interface CapabilitySelector {
  select(input: CapabilitySelectionInput): Promise<MountedCapabilities>;
}

/**
 * Mounts every registered tool capability - the v0.1-compatible default.
 * @public
 */
export class StaticCapabilitySelector implements CapabilitySelector {
  /**
   * Select all tool-kind capabilities.
   * @public
   */
  async select(input: CapabilitySelectionInput): Promise<MountedCapabilities> {
    const tools = input.available.filter((c) => c.kind === "tool");
    return {
      capabilities: tools,
      rationale: `static: mounted all ${tools.length} registered tool capabilities`,
    };
  }
}

/**
 * Options for the top-k selector.
 * @public
 */
export interface TopKCapabilitySelectorOptions {
  /** Maximum capabilities mounted per step. Default 8. */
  limit?: number;
  /** How many trailing context messages feed the search query. Default 6. */
  contextWindow?: number;
  /** Restrict selection to these kinds. Default: tools only. */
  kinds?: readonly CapabilityKind[];
}

/**
 * TopKCapabilitySelector - progressive discovery for small-context models.
 *
 * Ranks capabilities against (objective + trailing context) using the
 * deterministic offline scorer - no LLM call, no network - and mounts the
 * top-k. Everything else stays dispatchable but invisible to the model,
 * so context cost is bounded by k, not by catalogue size.
 * @public
 */
export class TopKCapabilitySelector implements CapabilitySelector {
  private readonly limit: number;
  private readonly contextWindow: number;
  private readonly kinds: readonly CapabilityKind[];

  constructor(opts: TopKCapabilitySelectorOptions = {}) {
    this.limit = opts.limit ?? 8;
    this.contextWindow = opts.contextWindow ?? 6;
    this.kinds = opts.kinds ?? ["tool"];
  }

  /**
   * Select the top-k capabilities for the current objective and lane tail.
   * @public
   */
  async select(input: CapabilitySelectionInput): Promise<MountedCapabilities> {
    const pool = input.available.filter((c) => this.kinds.includes(c.kind));
    const tail = input.context.slice(-this.contextWindow);
    const query = [input.objective, ...tail.map((m) => m.content ?? "")].join("\n");

    const ranked = scoreCapabilities(query, pool);
    const selected = ranked.slice(0, this.limit);
    const names = selected.map((s) => s.descriptor.name).join(", ");

    return {
      capabilities: selected.map((s) => s.descriptor),
      rationale:
        `topk: mounted ${selected.length}/${pool.length} capabilities ` +
        `by relevance (query terms from objective + last ${tail.length} messages): [${names}]`,
    };
  }
}

/**
 * Create the default v0.1-compatible selector (mount everything).
 * @public
 */
export function createStaticCapabilitySelector(): StaticCapabilitySelector {
  return new StaticCapabilitySelector();
}

/**
 * Create a progressive-discovery selector.
 * @public
 */
export function createTopKCapabilitySelector(
  opts: TopKCapabilitySelectorOptions = {},
): TopKCapabilitySelector {
  return new TopKCapabilitySelector(opts);
}
