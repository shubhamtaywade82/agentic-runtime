import type { ToolCallRequest } from "../core/types.js";

/**
 * Configuration for RepeatCallBinder.
 * @public
 */
export interface RepeatCallBinderConfig {
  /**
   * Maximum identical calls (same tool + same arguments) allowed within the
   * detection window before governance blocks the next one.
   *
   * With the default of 2, the first two identical calls pass and the third
   * is blocked. (Historical off-by-one note: the pre-window implementation
   * compared with `>=` and blocked the second call, contradicting this doc.)
   */
  maxConsecutiveIdentical?: number;
  /**
   * Sliding window of recent tool calls inspected for repetition.
   *
   * Window semantics catch both degenerate repetition (A, A, A) and
   * oscillation loops (A, B, A, B) that a single-slot trail cannot see.
   * Default: 8.
   */
  windowSize?: number;
}

/**
 * Default configuration.
 * @public
 */
export const DEFAULT_REPEAT_CALL_BINDER_CONFIG: RepeatCallBinderConfig = {
  maxConsecutiveIdentical: 2,
  windowSize: 8,
};

/**
 * RepeatCallBinder - Enforces governance against repeated identical tool calls.
 *
 * Tracks identical invocations (same tool + same args) inside a bounded
 * sliding window and injects a governance nudge when the allowance is
 * exceeded, forcing the agent to try a materially different approach.
 *
 * The window (not a single-slot trail) is what makes oscillation loops like
 * search(A), fetch(B), search(A), fetch(B) ... governable: each signature
 * accumulates occurrences inside the window even though no two *consecutive*
 * calls are identical.
 * @public
 */
export class RepeatCallBinder {
  private window: string[] = [];
  private readonly maxConsecutive: number;
  private readonly windowSize: number;

  constructor(config: RepeatCallBinderConfig = {}) {
    this.maxConsecutive =
      config.maxConsecutiveIdentical ?? DEFAULT_REPEAT_CALL_BINDER_CONFIG.maxConsecutiveIdentical!;
    this.windowSize = Math.max(
      config.windowSize ?? DEFAULT_REPEAT_CALL_BINDER_CONFIG.windowSize!,
      this.maxConsecutive + 1,
    );
  }

  /**
   * Check a tool call intent against repetition history.
   * Returns a governance nudge if the allowance is exceeded.
   * @public
   */
  check(intent: ToolCallRequest): { allowed: true } | { allowed: false; nudge: string } {
    const signature = this.computeSignature(intent);

    this.window.push(signature);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }

    const occurrences = this.window.filter((s) => s === signature).length;
    if (occurrences > this.maxConsecutive) {
      return {
        allowed: false,
        nudge:
          `Governance block: "${intent.name}" with identical arguments invoked ` +
          `${occurrences}x within the last ${this.window.length} calls.\n` +
          `The environment conditions did not change between attempts.\n` +
          `Mandate: choose a materially DIFFERENT angle (alternate identifiers, divide scope, sample differently), ` +
          `OR announce completion/state limitations.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Reset the binder state (e.g., on new run or manual intervention).
   * @public
   */
  reset(): void {
    this.window = [];
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
