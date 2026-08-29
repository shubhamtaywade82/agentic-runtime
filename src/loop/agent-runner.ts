import type {
  ExecutionStep,
  FinalReport,
  ToolCallRequest,
  ContractOutcome,
  ThoughtProcess,
  RequestSchedule,
  ToolResult,
} from "../core/types.js";
import {
  BudgetExhaustedError,
  CognitiveOverloadError,
  isBudgetExhaustedError,
  isCognitiveOverloadError,
  isGateAbortedError,
  isRunAbortedError,
  RunAbortedError,
} from "../core/types.js";
import { ContextManager } from "../memory/context-manager.js";
import { ToolDispatcher } from "../hands/tool-dispatcher.js";
import { RepeatCallBinder } from "../loop/repeat-call-binder.js";
import { ToolkitCatalogue, createTestLease } from "../hands/catalogue.js";
import { createCertifiedEnvelope } from "../hands/tool-dispatcher.js";
import type { ResourceSentinel } from "../sentinel/index.js";
import { SynthesisEngine } from "../synthesis/sealer.js";
import type { SealMetrics } from "../synthesis/sealer.js";

/**
 * Run budgets configuration.
 * @public
 */
export interface RunBudgets {
  /** Maximum cognitive steps (LLM turns) */
  maxCogStepN: number;
  /** Wall-clock time ceiling in milliseconds */
  wallTimeCeilMs: number;
  /** Hard limit on tool intent count */
  hardIntentCount: number;
  /** Maximum tokens per LLM call */
  maxTokensPerStep: number;
}

/**
 * Default run budgets.
 * @public
 */
export const DEFAULT_RUN_BUDGETS: RunBudgets = {
  maxCogStepN: 15,
  wallTimeCeilMs: 5 * 60 * 1000, // 5 minutes
  hardIntentCount: 20,
  maxTokensPerStep: 8000,
};

/**
 * Run status outcomes.
 *
 * - ACHIEVED: the model emitted a terminal answer.
 * - PARTIAL: internal budgets exhausted before a terminal answer.
 * - CEDED: control returned externally (kill switch / operator abort).
 * - FAILED: fatal error; only the degraded seal is available.
 * @public
 */
export type RunStatus = "ACHIEVED" | "PARTIAL" | "CEDED" | "FAILED";

/**
 * Run result with trace and final report.
 *
 * finalReport is non-null by contract: every run - success, budget
 * exhaustion, abort, or hard failure - terminates with exactly one sealed
 * artifact (model-authored seal, or the deterministic degraded seal).
 * @public
 */
export interface RunResult {
  status: RunStatus;
  finalReport: FinalReport;
  steps: ExecutionStep[];
  totalWallTimeMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  intentsDispatched: number;
}

/**
 * AgentRunner - The main execution engine for autonomous runs.
 *
 * Implements the ReAct loop with budgets, deduplication, and terminal
 * sealing. Replaces the former "ChiefFlywheel" with standard naming.
 *
 * Terminal sealing contract:
 * - ACHIEVED / PARTIAL / CEDED runs receive a model-authored seal via the
 *   SynthesisEngine (No-Tools Guarantee, grammar-constrained).
 * - FAILED runs receive the deterministic degraded seal (A5, zero network).
 * - If a model-authored seal itself fails, the run degrades rather than
 *   shipping an unsealed result.
 * @public
 */
export class AgentRunner {
  private readonly budgets: RunBudgets;
  private readonly brain: ThoughtProcess;
  private readonly catalogue: ToolkitCatalogue;
  private readonly dispatcher: ToolDispatcher;
  private readonly contextManager: ContextManager;
  private readonly binder: RepeatCallBinder;
  private readonly killSwitch: AbortController;
  private readonly startTime: number;
  private readonly adminCharter: string;
  private readonly transparencyProfile: "sketch" | "internal-monologue" | null;
  private readonly selfQuestionProfile: string | null;
  private readonly sentinel: ResourceSentinel | null;
  private readonly sealer: SynthesisEngine;

  private steps: ExecutionStep[] = [];
  private intentsDispatched = 0;
  private totalTokensIn = 0;
  private totalTokensOut = 0;

  constructor(
    brain: ThoughtProcess,
    catalogue: ToolkitCatalogue,
    contextManager: ContextManager,
    config: {
      budgets?: Partial<RunBudgets>;
      adminCharter: string;
      transparencyProfile?: "sketch" | "internal-monologue" | null;
      selfQuestionProfile?: string | null;
      /** Sentinel supplying terminal-report gate telemetry. Optional. */
      sentinel?: ResourceSentinel;
      /** Seal engine override (defaults to a SynthesisEngine over `brain`). */
      sealer?: SynthesisEngine;
    },
  ) {
    this.brain = brain;
    this.catalogue = catalogue;
    this.contextManager = contextManager;
    this.budgets = { ...DEFAULT_RUN_BUDGETS, ...config.budgets };
    this.adminCharter = config.adminCharter;
    this.transparencyProfile = config.transparencyProfile ?? "internal-monologue";
    this.selfQuestionProfile = config.selfQuestionProfile ?? null;
    this.sentinel = config.sentinel ?? null;
    this.sealer = config.sealer ?? new SynthesisEngine(brain);
    this.killSwitch = new AbortController();
    this.startTime = performance.now();

    this.dispatcher = new ToolDispatcher(catalogue, this.killSwitch.signal);
    this.binder = new RepeatCallBinder();
  }

  /**
   * Execute an autonomous run to completion or budget exhaustion.
   *
   * Every call terminates with exactly one sealed FinalReport.
   * @public
   */
  async run(objective: string): Promise<RunResult> {
    this.contextManager.replaceLane([
      { role: "system", content: this.adminCharter },
      { role: "user", content: objective },
    ]);

    // Default when the loop exhausts its step budget without a terminal
    // answer and without throwing: internal budgets ceded, salvage what ran.
    let runStatus: RunStatus = "PARTIAL";
    let fatalErr: unknown = null;

    try {
      // Main ReAct loop
      for (let stepIndex = 0; stepIndex < this.budgets.maxCogStepN; stepIndex++) {
        if (this.killSwitch.signal.aborted) {
          throw new RunAbortedError("kill switch fired before inference");
        }

        // Check budget exhaustion
        this.checkBudgets(stepIndex);

        // Schedule context digestion
        await this.contextManager.maybeDigest(JSON.stringify({ stepIndex }));

        // Build request schedule
        const schedule = this.buildSchedule(stepIndex);
        const stepStart = performance.now();

        // Probe for tool calls
        const turn = await this.brain.digest(this.contextManager.lane, schedule);

        // Track tokens
        if (turn.usage) {
          this.totalTokensIn += turn.usage.promptTokens;
          this.totalTokensOut += turn.usage.evalTokens;
        }

        // Handle truncation
        if (turn.finishTag === "length_truncated") {
          this.contextManager.append({
            role: "user",
            content:
              "Previous inference hit the token ceiling mid-emission. " +
              "Re-attempt with tighter scope: one tool call, minimized arguments, or a concise answer.",
          });
          continue;
        }

        // Process tool calls
        const toolResults: ToolResult[] = [];

        for (const toolCall of turn.toolCalls) {
          // Check budgets
          if (++this.intentsDispatched > this.budgets.hardIntentCount) {
            throw new BudgetExhaustedError("intents", this.intentsDispatched, this.budgets.hardIntentCount);
          }

          // Deduplication check
          const binderResult = this.binder.check(toolCall);
          if (!binderResult.allowed) {
            this.contextManager.append({ role: "user", content: binderResult.nudge });
            continue;
          }

          // Execute tool
          const envelope = createCertifiedEnvelope(toolCall, {
            lease: createTestLease(),
            certifiedAt: Date.now(),
            attempt: 1,
          });

          const outcome = await this.dispatcher.executeIntent(envelope);
          toolResults.push(this.outcomeToToolResult(toolCall, outcome));

          // Check for abort
          if (this.killSwitch.signal.aborted) {
            throw new RunAbortedError("kill switch fired during tool dispatch");
          }
        }

        // Record step
        const step: ExecutionStep = {
          stepIndex,
          assistantTurn: turn,
          toolResults,
          startedAt: stepStart,
          completedAt: performance.now(),
        };
        this.steps.push(step);

        // Add tool results to context
        for (const result of toolResults) {
          this.contextManager.append({
            role: "tool",
            content: result.output as string,
          });
        }

        // Check for final answer (no tool calls)
        if (turn.toolCalls.length === 0 && turn.finishTag === "stop") {
          runStatus = "ACHIEVED";
          break;
        }
      }
    } catch (err) {
      fatalErr = err;
      runStatus = this.classifyError(err);
    }

    // ---- Terminal sealing: every run ships exactly one sealed artifact ----
    const finalReport = await this.sealRun(objective, runStatus, fatalErr);
    // classifyError may have been overridden inside sealRun on seal failure.
    const sealedStatus = finalReport.status;

    return {
      status: sealedStatus,
      finalReport,
      steps: this.steps,
      totalWallTimeMs: performance.now() - this.startTime,
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
      intentsDispatched: this.intentsDispatched,
    };
  }

  /**
   * Route the run to its terminal seal.
   *
   * - FAILED: deterministic degraded seal (A5). The brain may itself be the
   *   failure source, so no inference is attempted.
   * - ACHIEVED / PARTIAL / CEDED: model-authored seal under the No-Tools
   *   Guarantee; on seal failure the run degrades (FAILED, or CEDED when
   *   the seal died because of an external abort).
   */
  private async sealRun(
    objective: string,
    runStatus: RunStatus,
    fatalErr: unknown,
  ): Promise<FinalReport> {
    const metrics = this.sealMetrics();

    if (runStatus === "FAILED") {
      return this.sealer.degradedSeal(objective, metrics, fatalErr);
    }

    try {
      return await this.sealer.seal({
        lane: this.contextManager.lane,
        status: runStatus,
        objective,
        baseSchedule: this.buildSchedule(this.steps.length),
        metrics,
      });
    } catch (sealErr) {
      const degradedStatus: "FAILED" | "CEDED" =
        this.killSwitch.signal.aborted || this.isAbortish(sealErr)
          ? "CEDED"
          : "FAILED";
      return this.sealer.degradedSeal(objective, this.sealMetrics(), sealErr, {
        status: degradedStatus,
      });
    }
  }

  private buildSchedule(stepIndex: number): RequestSchedule {
    // Determine which tools to mount based on current context
    // For now, mount all available tools
    const manifests = this.catalogue.manifests();

    return {
      mounting: { manifests },
      idleLiveSeconds: 1800,
      entropyOverride: 0.1,
      upperBoundTokenCount: this.budgets.maxTokensPerStep,
      killSwitch: this.killSwitch.signal,
      transcriptDigest: `run-${this.startTime}-step-${stepIndex}`,
    };
  }

  private checkBudgets(stepIndex: number): void {
    const elapsed = performance.now() - this.startTime;

    if (stepIndex >= this.budgets.maxCogStepN) {
      throw new CognitiveOverloadError(stepIndex, this.budgets.maxCogStepN);
    }

    if (elapsed >= this.budgets.wallTimeCeilMs) {
      throw new BudgetExhaustedError("wallclock", elapsed, this.budgets.wallTimeCeilMs);
    }
  }

  private outcomeToToolResult(
    toolCall: ToolCallRequest,
    outcome: ContractOutcome,
  ): ToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      success: outcome.status === "SUCCESS",
      output: outcome.payload,
      trustLevel: "unverified",
      executionTimeMs: outcome.telemetry.executionMs,
    };
  }

  /**
   * Terminal status classification.
   *
   * - External termination (kill switch) always wins: whatever error
   *   surfaced, the operator pulled the plug - that is CEDED, not FAILED.
   * - Internal budget exhaustion is PARTIAL: completed work is salvageable.
   * - Everything else is FAILED.
   */
  private classifyError(err: unknown): RunStatus {
    if (this.killSwitch.signal.aborted) return "CEDED";
    if (isRunAbortedError(err) || isGateAbortedError(err)) return "CEDED";
    if (isCognitiveOverloadError(err) || isBudgetExhaustedError(err)) return "PARTIAL";
    return "FAILED";
  }

  private isAbortish(err: unknown): boolean {
    if (isRunAbortedError(err) || isGateAbortedError(err)) return true;
    return err instanceof Error && /aborted|kill switch/i.test(err.message);
  }

  private sealMetrics(): SealMetrics {
    const counts = this.sentinelCounts();
    return {
      totalSteps: this.steps.length,
      totalToolCalls: this.intentsDispatched,
      totalWallTimeMs: Math.round(performance.now() - this.startTime),
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
      sentinelAcquisitions: counts.acquisitions,
      sentinelRejections: counts.rejections,
    };
  }

  private sentinelCounts(): { acquisitions: number; rejections: number } {
    if (!this.sentinel) return { acquisitions: 0, rejections: 0 };
    const stats = this.sentinel.aggregateStats();
    return {
      acquisitions: stats.grants,
      rejections: stats.refunds + stats.saturations,
    };
  }

  /**
   * Get the kill switch for external abortion.
   * @public
   */
  getAbortController(): AbortController {
    return this.killSwitch;
  }
}

/**
 * Factory to create an AgentRunner with defaults.
 * @public
 */
export function createAgentRunner(
  brain: ThoughtProcess,
  catalogue: ToolkitCatalogue,
  contextManager: ContextManager,
  config: {
    budgets?: Partial<RunBudgets>;
    adminCharter: string;
    transparencyProfile?: "sketch" | "internal-monologue" | null;
    selfQuestionProfile?: string | null;
    sentinel?: ResourceSentinel;
    sealer?: SynthesisEngine;
  },
): AgentRunner {
  return new AgentRunner(brain, catalogue, contextManager, config);
}
