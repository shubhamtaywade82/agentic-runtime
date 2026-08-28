import { ConcurrencyGate } from "./gate.js";
import { EventSink } from "../core/types.js";

/**
 * ResourceSentinel - Global registry for hardware bounds.
 * 
 * Features:
 * - Per-model brain gates (prevents cross-model contention)
 * - Classified hands gate (local-sandbox, external-network)
 * - Memoized gate creation
 * @public
 */
export class ResourceSentinel {
  private brainGates = new Map<string, ConcurrencyGate>();
  public readonly handsGate: ConcurrencyGate;
  public readonly defaultBrainParallelism: number;

  constructor(
    cfg: { 
      maxParallelTools: number; 
      maxParallelInferences: number; 
      maxQueueDepth: number;
    }, 
    sink: EventSink
  ) {
    this.handsGate = new ConcurrencyGate(
      cfg.maxParallelTools, 
      cfg.maxQueueDepth, 
      "hands", 
      sink
    );
    this.defaultBrainParallelism = cfg.maxParallelInferences;
  }

  /**
   * Get or create a per-model brain gate.
   * Prevents cross-model contention (e.g., Qwen workers vs Llama judges).
   * @public
   */
  brainGate(modelId: string, parallelism?: number, sink?: EventSink): ConcurrencyGate {
    let gate = this.brainGates.get(modelId);
    if (!gate) {
      gate = new ConcurrencyGate(
        parallelism ?? this.defaultBrainParallelism, 
        100, 
        `brain:${modelId}`, 
        sink ?? { emit: () => {} }
      );
      this.brainGates.set(modelId, gate);
    }
    return gate;
  }
}

export { ConcurrencyGate } from "./gate.js";
export type { Priority } from "./gate.js";