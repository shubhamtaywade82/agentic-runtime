import type { ToolCallRequest } from "../core/types.js";

/**
 * Configuration for RepeatCallBinder.
 * @public
 */
export interface RepeatCallBinderConfig {
  /** Maximum consecutive identical calls before governance block */
  maxConsecutiveIdentical?: number;
}

/**
 * Default configuration.
 * @public
 */
export const DEFAULT_REPEAT_CALL_BINDER_CONFIG: RepeatCallBinderConfig = {
  maxConsecutiveIdentical: 2,
};

/**
 * RepeatCallBinder - Enforces governance against repeated identical tool calls.
 * 
 * Tracks consecutive identical invocations (same tool + same args) and
 * injects a governance nudge when the threshold is exceeded, forcing the
 * agent to try a materially different approach.
 * @public
 */
export class RepeatCallBinder {
  private trail: { signature: string; count: number } | null = null;
  private readonly maxConsecutive: number;

  constructor(config: RepeatCallBinderConfig = {}) {
    this.maxConsecutive = config.maxConsecutiveIdentical ?? DEFAULT_REPEAT_CALL_BINDER_CONFIG.maxConsecutiveIdentical!;
  }

  /**
   * Check a tool call intent against repetition history.
   * Returns a governance nudge if threshold exceeded.
   * @public
   */
  check(intent: ToolCallRequest): { allowed: true } | { allowed: false; nudge: string } {
    const signature = this.computeSignature(intent);
    
    if (this.trail && this.trail.signature === signature) {
      this.trail.count++;
      
      if (this.trail.count >= this.maxConsecutive) {
        return {
          allowed: false,
          nudge: 
            `Governance block: "${intent.name}" invoked identically ${this.trail.count}× running.\n` +
            `The environment conditions did not change between attempts.\n` +
            `Mandate: choose a materially DIFFERENT angle (alternate identifiers, divide scope, sample differently), ` +
            `OR announce completion/state limitations.`
        };
      }
    } else {
      this.trail = { signature, count: 1 };
    }
    
    return { allowed: true };
  }

  /**
   * Reset the binder state (e.g., on new run or manual intervention).
   * @public
   */
  reset(): void {
    this.trail = null;
  }

  /**
   * Compute stable signature for intent deduplication.
   * Normalizes argument order for consistent comparison.
   */
  private computeSignature(intent: ToolCallRequest): string {
    // Sort keys for stable JSON representation
    const sortedArgs = Object.keys(intent.arguments)
      .sort()
      .reduce((acc, key) => {
        acc[key] = intent.arguments[key];
        return acc;
      }, {} as Record<string, unknown>);
    
    return `${intent.name}:${JSON.stringify(sortedArgs)}`;
  }
}

/**
 * Create a RepeatCallBinder with default config.
 * @public
 */
export function createRepeatCallBinder(config?: RepeatCallBinderConfig): RepeatCallBinder {
  return new RepeatCallBinder(config);
}