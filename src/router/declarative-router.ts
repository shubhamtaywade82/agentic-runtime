import type { ThoughtProcess } from "../core/types.js";
import type { ModelSelectionRequest, ModelRouter, ModelSelectionPhase } from "./types.js";

/**
 * One declarative routing rule. Every condition present in `when` must hold
 * for the rule to match. Rules are evaluated in order; the first match
 * wins; the default brain handles everything else.
 * @public
 */
export interface RoutingRule {
  when: {
    /** Restrict this rule to specific selection phases. */
    phase?: ModelSelectionPhase | readonly ModelSelectionPhase[];
    /** Case-insensitive substring or regex test against the objective. */
    objectiveMatches?: string | RegExp;
    /** Match when at least this many capabilities are mounted. */
    minMountedTools?: number;
    /** Match when context pressure exceeds this value (0..1). */
    contextPressureAbove?: number;
    /** Match after this step index. */
    stepIndexAbove?: number;
    /** Match after this many consecutive inference failures (fallback). */
    minInferenceFailures?: number;
  };
  brain: ThoughtProcess;
  /** Human-readable rationale (surfaced in observability). */
  description?: string;
}

/**
 * DeclarativeModelRouter - deterministic ordered rules, no LLM calls.
 *
 * Typical hybrid topology:
 *   rules: [
 *     { when: { phase: "seal" }, brain: gemma },                      // heavy synthesis
 *     { when: { contextPressureAbove: 0.8 }, brain: gemma },          // big window
 *     { when: { minInferenceFailures: 2 }, brain: gemma },            // fallback
 *     { when: { objectiveMatches: /deploy|production/ }, brain: gemma },
 *   ],
 *   default: minicpm
 *
 * The router never mutates run state; it is pure selection.
 * @public
 */
export class DeclarativeModelRouter implements ModelRouter {
  readonly routerTag: string;

  constructor(
    private readonly opts: {
      default: ThoughtProcess;
      rules: readonly RoutingRule[];
      tag?: string;
    },
  ) {
    this.routerTag = opts.tag ?? `declarative:${opts.default.identityTag}+${opts.rules.length}`;
  }

  /**
   * Select the first matching rule's brain; the default when none match.
   * @public
   */
  select(request: ModelSelectionRequest): ThoughtProcess {
    for (const rule of this.opts.rules) {
      if (this.matches(rule, request)) {
        return rule.brain;
      }
    }
    return this.opts.default;
  }

  /**
   * The default brain (used when no rule matches).
   * @public
   */
  get defaultBrain(): ThoughtProcess {
    return this.opts.default;
  }

  private matches(rule: RoutingRule, request: ModelSelectionRequest): boolean {
    const when = rule.when;

    if (when.phase !== undefined) {
      const phases = Array.isArray(when.phase) ? when.phase : [when.phase];
      if (!phases.includes(request.phase)) return false;
    }
    if (when.objectiveMatches !== undefined) {
      const pattern =
        typeof when.objectiveMatches === "string"
          ? new RegExp(when.objectiveMatches, "i")
          : new RegExp(when.objectiveMatches.source, when.objectiveMatches.flags.includes("i")
              ? when.objectiveMatches.flags
              : `${when.objectiveMatches.flags}i`);
      if (!pattern.test(request.objective)) return false;
    }
    if (when.minMountedTools !== undefined && request.mountedToolCount < when.minMountedTools) {
      return false;
    }
    if (when.contextPressureAbove !== undefined && request.contextPressure <= when.contextPressureAbove) {
      return false;
    }
    if (when.stepIndexAbove !== undefined && request.stepIndex <= when.stepIndexAbove) {
      return false;
    }
    if (when.minInferenceFailures !== undefined && request.inferenceFailures < when.minInferenceFailures) {
      return false;
    }
    return true;
  }
}

/**
 * Create a declarative model router.
 * @public
 */
export function createDeclarativeModelRouter(opts: {
  default: ThoughtProcess;
  rules: readonly RoutingRule[];
  tag?: string;
}): DeclarativeModelRouter {
  return new DeclarativeModelRouter(opts);
}
