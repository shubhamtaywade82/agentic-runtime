import type { ThoughtProcess } from "../core/types.js";

/**
 * Why the runtime is selecting a model right now.
 *
 * - "step": a main-loop reasoning turn
 * - "seal": terminal report synthesis (No-Tools Guarantee context)
 * - "summarize": context digestion (compaction) turn
 * - "dispute": tier-3 judge arbitration
 * @public
 */
export const MODEL_SELECTION_PHASES = ["step", "seal", "summarize", "dispute"] as const;

/** @public */
export type ModelSelectionPhase = (typeof MODEL_SELECTION_PHASES)[number];

/**
 * Deterministic factors a router may consult. No LLM is involved in the
 * routing decision itself - routing must stay cheap, predictable and
 * replayable for tests.
 * @public
 */
export interface ModelSelectionRequest {
  phase: ModelSelectionPhase;
  objective: string;
  stepIndex: number;
  /** Capabilities currently mounted for this turn. */
  mountedToolCount: number;
  /** Estimated context window pressure, 0..1. */
  contextPressure: number;
  /** Consecutive inference failures observed so far this run. */
  inferenceFailures: number;
}

/**
 * ModelRouter - selects the ThoughtProcess (brain) for each inference.
 *
 * This is the seam that enables hybrid local/cloud topologies (e.g.
 * MiniCPM for cheap steps, Gemma for heavy ones) without polluting
 * adapters with model-aware branching: the adapter stays single-model,
 * the router composes adapters.
 * @public
 */
export interface ModelRouter {
  select(request: ModelSelectionRequest): ThoughtProcess;
  /** Stable identity for observability and gate telemetry. */
  readonly routerTag: string;
}

/**
 * Single-model router - the v0.1-compatible default.
 * @public
 */
export class StaticModelRouter implements ModelRouter {
  readonly routerTag: string;

  constructor(private readonly brain: ThoughtProcess, tag?: string) {
    this.routerTag = tag ?? `static:${brain.identityTag}`;
  }

  /**
   * Select: always the configured brain.
   * @public
   */
  select(): ThoughtProcess {
    return this.brain;
  }
}

/**
 * Create a single-model router.
 * @public
 */
export function createStaticModelRouter(brain: ThoughtProcess, tag?: string): StaticModelRouter {
  return new StaticModelRouter(brain, tag);
}
