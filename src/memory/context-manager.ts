import type {
  ChatMsg,
  ThoughtProcess,
  RequestSchedule,
} from "../core/types.js";

/**
 * Digestion pipeline for context compaction.
 * Summarizes older tool observations to prevent attention degradation.
 * @public
 */
export interface DigestionPipeline {
  summarize(section: ChatMsg[], extra?: string): Promise<string>;
}

/**
 * Configuration for ContextManager.
 * @public
 */
export interface ContextManagerConfig {
  /** Model context window capacity in tokens */
  modelCapacityTokenCeiling: number;
  /** Always retain this many newest messages verbatim */
  reserveFreshTailCount: number;
  /** Style hint for summarization */
  digestStyleHint: string;
  /** Pressure threshold (0-1) to trigger digestion */
  compactionThreshold?: number;
}

/**
 * Default compaction threshold (85% of capacity)
 * @public
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.85;

/**
 * ContextManager - Manages the agent's working memory and context window.
 * 
 * Implements sliding window with summarization:
 * - Retains recent messages verbatim
 * - Summarizes older tool observations into high-level digests
 * - Tracks token pressure and triggers compaction proactively
 * - Pinned charter lines survive all digestion cycles
 * @public
 */
export class ContextManager {
  /** The active message lane */
  public lane: ChatMsg[] = [];
  
  /** Pinned charter lines that survive digestion */
  private readonly pinLines: ChatMsg[] = [];
  
  /** Count of digestion cycles performed */
  public digestions = 0;
  
  private readonly config: Required<ContextManagerConfig>;
  private readonly pipeline: DigestionPipeline;

  constructor(
    config?: Partial<ContextManagerConfig>,
    pipeline?: DigestionPipeline,
    initialMessages: ChatMsg[] = [],
  ) {
    this.config = {
      modelCapacityTokenCeiling: config?.modelCapacityTokenCeiling ?? 8192,
      reserveFreshTailCount: config?.reserveFreshTailCount ?? 10,
      digestStyleHint: config?.digestStyleHint ?? "Summarize tool observations concisely.",
      compactionThreshold: config?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    };
    this.pipeline = pipeline ?? {
      summarize: async (section: ChatMsg[]) => section.map((m) => m.content ?? "").join("\n"),
    };
    this.lane = [...initialMessages];
  }

  /**
   * Pin a charter line that survives all digestion cycles.
   * @public
   */
  pinCharter(message: ChatMsg): void {
    this.pinLines.push(message);
    this.lane.unshift(message);
  }

  /**
   * Add a message to the active lane.
   * @public
   */
  append(message: ChatMsg): void {
    this.lane.push(message);
  }

  /**
   * Replace the entire lane (e.g., on run restart).
   * @public
   */
  replaceLane(messages: ChatMsg[]): void {
    this.lane = [...this.pinLines, ...messages];
  }

  /**
   * Get current estimated token count of the lane.
   * Rough heuristic: ~4 chars per token + 24 overhead per message.
   * @public
   */
  estimateTokens(): number {
    return this.lane.reduce(
      (sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4) + 24,
      0,
    );
  }

  /**
   * Check if context pressure exceeds threshold.
   * @public
   */
  isPressureHigh(): boolean {
    const pressure = this.estimateTokens();
    return pressure >= this.config.compactionThreshold * this.config.modelCapacityTokenCeiling;
  }

  /**
   * Current context pressure as a 0..1 ratio of estimated tokens to the
   * model capacity. Consumed by model routers (context-pressure routing)
   * and observability.
   * @public
   */
  contextPressure(): number {
    if (this.config.modelCapacityTokenCeiling <= 0) return 0;
    return Math.min(1, this.estimateTokens() / this.config.modelCapacityTokenCeiling);
  }

  /**
   * Schedule a digestion cycle if pressure is high.
   * Summarizes oldest tool messages while preserving recent context.
   * @public
   */
  async maybeDigest(scratchpadFootprint: string): Promise<void> {
    if (!this.isPressureHigh()) return;

    const tailLock = Math.min(this.config.reserveFreshTailCount, this.lane.length);
    // Find tool messages in the "cold zone" (excluding pinned + recent tail)
    const coldZone = this.lane
      .slice(this.pinLines.length, -tailLock)
      .filter((m) => m.role === "tool");

    if (coldZone.length < 2) return; // Not enough to summarize

    const summary = await this.pipeline.summarize(coldZone, 
      this.config.digestStyleHint + "\nScratchpad snapshot: " + scratchpadFootprint
    );

    const deadZones = new Set(coldZone);
    this.digestions++;
    
    this.lane = [
      ...this.pinLines,
      { 
        role: "user", 
        content: `[DIGESTION EVENTS=${this.digestions}] Prior zone compressed below:\n${summary}` 
      },
      ...this.lane.filter((m) => !deadZones.has(m)),
    ];
  }

  /**
   * Get a snapshot of the current lane for checkpointing.
   * @public
   */
  snapshot(): ChatMsg[] {
    return [...this.lane];
  }

  /**
   * Restore lane from snapshot.
   * @public
   */
  restore(snapshot: ChatMsg[]): void {
    this.lane = snapshot;
  }

  /**
   * Format lane for synthesis engine (verified receipts only).
   * @public
   */
  formatForSynthesis(): string {
    return this.lane
      .filter((m) => m.role === "tool" || m.role === "assistant")
      .map((m) => `${m.role}: ${m.content?.slice(0, 2000)}`)
      .join("\n---\n");
  }
}

/**
 * Default digestion pipeline using the brain with no tools mounted.
 * @public
 */
export function createDefaultDigestionPipeline(
  brain: ThoughtProcess,
  schedule: RequestSchedule,
): DigestionPipeline {
  return {
    async summarize(section: ChatMsg[], extra?: string): Promise<string> {
      const prompt = `Summarize the following tool observations into a concise digest. 
Focus on outcomes, not raw data. Preserve key findings and anomalies.
${extra ? `\nAdditional context: ${extra}` : ""}

${section.map(m => `${m.role}: ${m.content}`).join("\n")}`;

      const turn = await brain.digest(
        [{ role: "user", content: prompt }],
        { ...schedule, mounting: { manifests: [] } } // No tools for summarization
      );
      
      return turn.content;
    },
  };
}