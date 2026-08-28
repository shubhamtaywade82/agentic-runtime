import type {
  ExecutionStep,
  FinalReport,
  ToolCallRequest,
  ContractOutcome,
  ThoughtProcess,
  RequestSchedule,
} from "../core/types.js";
import { ContextManager } from "../memory/context-manager.js";
import { ToolDispatcher } from "../hands/tool-dispatcher.js";
import { RepeatCallBinder } from "../loop/repeat-call-binder.js";
import { ToolkitCatalogue, createTestLease } from "../hands/catalogue.js";
import { createCertifiedEnvelope } from "../hands/tool-dispatcher.js";
import { BudgetExhaustedError, CognitiveOverloadError } from "../core/types.js";

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
 * @public
 */
export type RunStatus = "ACHIEVED" | "PARTIAL" | "CEDED" | "FAILED";

/**
 * Run result with trace and final report.
 * @public
 */
export interface RunResult {
  status: RunStatus;
  finalReport: FinalReport | null;
  steps: ExecutionStep[];
  totalWallTimeMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  intentsDispatched: number;
}

/**
 * AgentRunner - The main execution engine for autonomous runs.
 * 
 * Implements the ReAct loop with budgets, deduplication, and salvage paths.
 * Replaces the former "ChiefFlywheel" with standard naming.
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
    },
  ) {
    this.brain = brain;
    this.catalogue = catalogue;
    this.contextManager = contextManager;
    this.budgets = { ...DEFAULT_RUN_BUDGETS, ...config.budgets };
    this.adminCharter = config.adminCharter;
    this.transparencyProfile = config.transparencyProfile ?? "internal-monologue";
    this.selfQuestionProfile = config.selfQuestionProfile ?? null;
    this.killSwitch = new AbortController();
    this.startTime = performance.now();
    
    this.dispatcher = new ToolDispatcher(catalogue, this.killSwitch.signal);
    this.binder = new RepeatCallBinder();
  }

  /**
   * Execute an autonomous run to completion or budget exhaustion.
   * @public
   */
  async run(objective: string): Promise<RunResult> {
    this.contextManager.replaceLane([
      { role: "system", content: this.adminCharter },
      { role: "user", content: objective },
    ]);

    let runStatus: RunStatus = "PARTIAL";
    let finalReport: FinalReport | null = null;

    try {
      // Main ReAct loop
      for (let stepIndex = 0; stepIndex < this.budgets.maxCogStepN; stepIndex++) {
        // Check budget exhaustion
        this.checkBudgets(stepIndex);

        // Schedule context digestion
        await this.contextManager.maybeDigest(JSON.stringify({ stepIndex }));

        // Build request schedule
        const schedule = this.buildSchedule(stepIndex);

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
        const toolResults: import("../core/types.js").ToolResult[] = [];
        
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
            throw new Error("Run aborted by kill switch");
          }
        }

        // Record step
        const step: ExecutionStep = {
          stepIndex,
          assistantTurn: turn,
          toolResults,
          startedAt: this.startTime + performance.now() - performance.now(), // approximate
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
          // Could implement final report generation here
          runStatus = "ACHIEVED";
          break;
        }
      }

      // If we exited loop without explicit completion, salvage
      if (runStatus === "PARTIAL") {
        const salvage = await this.salvageReport(objective);
        finalReport = salvage;
        runStatus = "PARTIAL";
      }

    } catch (err) {
      runStatus = this.classifyError(err);
    }

    return {
      status: runStatus,
      finalReport,
      steps: this.steps,
      totalWallTimeMs: performance.now() - this.startTime,
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
      intentsDispatched: this.intentsDispatched,
    };
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
    outcome: ContractOutcome
  ): import("../core/types.js").ToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      success: outcome.status === "SUCCESS",
      output: outcome.payload,
      trustLevel: "unverified",
      executionTimeMs: outcome.telemetry.executionMs,
    };
  }

  private async salvageReport(objective: string): Promise<FinalReport | null> {
    // Attempt to generate a partial report from completed work
    try {
      const schedule = this.buildSchedule(this.steps.length);
      const turn = await this.brain.digest(
        [
          ...this.contextManager.lane,
          { 
            role: "user", 
            content: `SALVAGE MODE: Time/budget exhausted. Synthesize a PARTIAL report from completed work.\nObjective: ${objective}` 
          },
        ],
        { ...schedule, upperBoundTokenCount: 4096 }
      );

      // Parse as FinalReport (simplified)
      return {
        status: "PARTIAL",
        objective,
        executiveSummary: turn.content.slice(0, 500),
        findings: [],
        disputes: [],
        metrics: {
          totalSteps: this.steps.length,
          totalToolCalls: this.intentsDispatched,
          totalWallTimeMs: performance.now() - this.startTime,
          totalTokensIn: this.totalTokensIn,
          totalTokensOut: this.totalTokensOut,
          sentinelAcquisitions: 0,
          sentinelRejections: 0,
        },
        seal: {
          timestamp: new Date().toISOString(),
          hash: "",
          runtimeVersion: "0.1.0",
        },
      } as FinalReport;
    } catch {
      return null;
    }
  }

  private classifyError(err: unknown): RunStatus {
    if (err instanceof CognitiveOverloadError || err instanceof BudgetExhaustedError) {
      return "PARTIAL";
    }
    return "FAILED";
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
  },
): AgentRunner {
  return new AgentRunner(brain, catalogue, contextManager, config);
}