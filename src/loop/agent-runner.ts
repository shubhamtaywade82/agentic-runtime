import type {
  AssistantTurn,
  ExecutionStep,
  FinalReport,
  ToolCallRequest,
  ContractOutcome,
  ThoughtProcess,
  RequestSchedule,
  SandboxLease,
  ToolResult,
  EventSink,
  JSONSchema7,
} from "../core/types.js";
import {
  BudgetExhaustedError,
  CognitiveOverloadError,
  isBudgetExhaustedError,
  isCognitiveOverloadError,
  isGateAbortedError,
  isGateSaturatedError,
  isRunAbortedError,
  RunAbortedError,
} from "../core/types.js";
import { ContextManager } from "../memory/context-manager.js";
import { ToolDispatcher } from "../hands/tool-dispatcher.js";
import { RepeatCallBinder } from "../loop/repeat-call-binder.js";
import { ToolkitCatalogue, SMART_LIMIT_BYTES } from "../hands/catalogue.js";
import { createCertifiedEnvelope } from "../hands/tool-dispatcher.js";
import type { ResourceSentinel } from "../sentinel/index.js";
import { SynthesisEngine } from "../synthesis/sealer.js";
import type { SealMetrics } from "../synthesis/sealer.js";
import { toolToCapability } from "../capability/types.js";
import { manifestSchemaFor } from "../capability/router.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import type { CapabilitySelector } from "../capability/selector.js";
import type { CapabilityPolicy } from "../policy/types.js";
import { requestApprovalWithTimeout } from "../policy/approval.js";
import type { ApprovalProvider } from "../policy/approval.js";
import type { ModelRouter, ModelSelectionPhase } from "../router/types.js";
import { POLICY_METRICS, POLICY_LABEL_KEYS, CAPABILITY_METRICS } from "../observability/metrics.js";

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
 * Sentinel wiring (audit fix): when a sentinel is supplied, every loop
 * inference acquires a per-model brain-gate lease keyed by the brain's
 * identityTag, bounding inference concurrency and making
 * sentinelAcquisitions real telemetry instead of a hardcoded zero.
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
  private readonly configSealer: SynthesisEngine | null;
  private readonly capabilitySelector: CapabilitySelector | undefined;
  private readonly policy: CapabilityPolicy | undefined;
  private readonly approvals: ApprovalProvider | undefined;
  private readonly approvalTimeoutMs: number;
  private readonly router: ModelRouter | undefined;
  private readonly laneMode: "replace" | "append";
  private readonly sink: EventSink;

  private sealer: SynthesisEngine | null;
  private steps: ExecutionStep[] = [];
  private intentsDispatched = 0;
  private totalTokensIn = 0;
  private totalTokensOut = 0;
  private policyDenials = 0;
  private inferenceFailures = 0;
  private currentObjective = "";
  private lastMountedCount = 0;
  private readonly runId = crypto.randomUUID();

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
      /** Seal engine override (defaults to a SynthesisEngine over the brain). */
      sealer?: SynthesisEngine;
      /** v0.2: capability selector - narrows mounted manifests per step. */
      capabilitySelector?: CapabilitySelector;
      /** v0.2: dispatch policy gate evaluated before every tool call. */
      policy?: CapabilityPolicy;
      /** v0.2: human approval provider resolving REQUIRE_APPROVAL decisions. */
      approvals?: ApprovalProvider;
      /** v0.2: approval wait ceiling before fail-closed denial. Default 60s. */
      approvalTimeoutMs?: number;
      /** v0.2: model router selecting the brain per phase. */
      router?: ModelRouter;
      /** v0.2: "replace" (v0.1) or "append" (session continuity). */
      laneMode?: "replace" | "append";
      /** v0.2: sink for policy/capability events. Default: noop. */
      sink?: EventSink;
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
    this.capabilitySelector = config.capabilitySelector;
    this.policy = config.policy;
    this.approvals = config.approvals;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 60_000;
    this.router = config.router;
    this.laneMode = config.laneMode ?? "replace";
    this.sink = config.sink ?? { emit: () => {} };
    this.configSealer = config.sealer ?? null;
    // Without a router, the sealer binds to the single brain up front (v0.1
    // behavior). With a router, it is constructed lazily at seal time from
    // the router-selected "seal" brain.
    this.sealer = config.sealer ?? (config.router === undefined ? new SynthesisEngine(brain) : null);
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
    this.currentObjective = objective;
    if (this.laneMode === "append") {
      // Session continuity: prior lane content (charter, history) survives;
      // the objective is appended as the newest user turn.
      this.contextManager.append({ role: "user", content: objective });
    } else {
      this.contextManager.replaceLane([
        { role: "system", content: this.adminCharter },
        { role: "user", content: objective },
      ]);
    }

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
        this.checkBudgets();

        // Schedule context digestion
        await this.contextManager.maybeDigest(JSON.stringify({ stepIndex }));

        // Build request schedule (router- and selector-aware)
        const schedule = await this.buildSchedule(stepIndex);
        const stepStart = performance.now();

        // Probe for tool calls. Sentinel wiring (audit fix): loop inferences
        // flow through the per-model brain gate when a sentinel is supplied,
        // so inference concurrency is actually bounded by hardware config.
        // v0.2: with a model router, the gate keys on the SELECTED brain's
        // identityTag, so hybrid topologies stay per-model bounded.
        const brain = this.brainFor("step");
        const release = this.sentinel
          ? await this.sentinel
              .brainGate(brain.identityTag)
              .acquire("normal", this.killSwitch.signal)
          : null;
        let turn: AssistantTurn;
        try {
          turn = await brain.digest(this.contextManager.lane, schedule);
        } catch (err) {
          this.inferenceFailures++;
          throw err;
        } finally {
          release?.();
        }

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
          // Deduplication check FIRST (audit fix): governance nudges never
          // dispatch, so they must not consume the hard intent budget.
          const binderResult = this.binder.check(toolCall);
          if (!binderResult.allowed) {
            this.contextManager.append({ role: "user", content: binderResult.nudge });
            continue;
          }

          // v0.2 policy gate: denials and unapproved calls never dispatch,
          // so they consume no intent budget either - the model receives a
          // structured POLICY_DENIED observation and pivots.
          const policyDenial = await this.applyPolicy(toolCall);
          if (policyDenial !== null) {
            toolResults.push(policyDenial);
            continue;
          }

          // Budget check counts only calls that will actually dispatch.
          if (this.intentsDispatched >= this.budgets.hardIntentCount) {
            throw new BudgetExhaustedError(
              "intents",
              this.intentsDispatched + 1,
              this.budgets.hardIntentCount,
            );
          }
          this.intentsDispatched++;

          // Execute tool (audit fix: a run-scoped lease, not a test lease)
          const envelope = createCertifiedEnvelope(toolCall, {
            lease: this.mintRunLease(),
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

      // The loop exhausted its step budget without a terminal answer.
      // CognitiveOverloadError is now reachable (audit fix: the in-loop
      // check was dead code - the for-condition made it impossible to hit).
      // classifyError maps it to PARTIAL: completed work stays salvageable.
      if (runStatus !== "ACHIEVED") {
        throw new CognitiveOverloadError(this.steps.length, this.budgets.maxCogStepN);
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
    const sealer = this.sealerFor();

    if (runStatus === "FAILED") {
      return sealer.degradedSeal(objective, metrics, fatalErr);
    }

    try {
      return await sealer.seal({
        lane: this.contextManager.lane,
        status: runStatus,
        objective,
        baseSchedule: await this.buildSchedule(this.steps.length),
        metrics,
      });
    } catch (sealErr) {
      const degradedStatus: "FAILED" | "CEDED" =
        this.killSwitch.signal.aborted || this.isAbortish(sealErr)
          ? "CEDED"
          : "FAILED";
      return sealer.degradedSeal(objective, this.sealMetrics(), sealErr, {
        status: degradedStatus,
      });
    }
  }

  /**
   * The seal engine: config override > constructor-bound (no router) >
   * lazily constructed over the router-selected "seal" brain.
   */
  private sealerFor(): SynthesisEngine {
    if (this.sealer !== null) return this.sealer;
    if (this.configSealer !== null) return this.configSealer;
    this.sealer = new SynthesisEngine(this.brainFor("seal"));
    return this.sealer;
  }

  /**
   * Select the brain for a phase: the router decides when present, the
   * single brain otherwise.
   */
  private brainFor(phase: ModelSelectionPhase): ThoughtProcess {
    if (this.router === undefined) return this.brain;
    return this.router.select({
      phase,
      objective: this.currentObjective,
      stepIndex: this.steps.length,
      mountedToolCount: this.lastMountedCount || this.catalogue.slotNames().length,
      contextPressure: this.contextPressure(),
      inferenceFailures: this.inferenceFailures,
    });
  }

  private contextPressure(): number {
    return this.contextManager.contextPressure?.() ?? 0;
  }

  /**
   * Evaluate the dispatch policy for one tool call.
   * Returns null when dispatch may proceed; a failed ToolResult when the
   * call is denied (fail-closed: missing provider, timeout, provider error
   * and explicit rejection all deny).
   */
  private async applyPolicy(toolCall: ToolCallRequest): Promise<ToolResult | null> {
    if (this.policy === undefined) return null;

    const tool = this.catalogue.get(toolCall.name);
    const capability: CapabilityDescriptor =
      tool !== undefined
        ? toolToCapability(tool)
        : {
            id: `unknown:${toolCall.name}`,
            name: toolCall.name,
            description: "tool not registered in the catalogue",
            kind: "tool",
            source: "native",
          };

    const decision = this.policy.evaluate({
      capability,
      toolCall,
      objective: this.currentObjective,
      stepIndex: this.steps.length,
      previousDenials: this.policyDenials,
    });
    this.sink.emit(POLICY_METRICS.DECISIONS_TOTAL, {
      [POLICY_LABEL_KEYS.DECISION]: decision.type,
      tool: toolCall.name,
    });

    if (decision.type === "ALLOW") return null;
    if (decision.type === "DENY") {
      return this.policyDenialResult(toolCall, decision.reason);
    }

    // REQUIRE_APPROVAL
    if (this.approvals === undefined) {
      return this.policyDenialResult(
        toolCall,
        `${decision.reason} No approval provider is configured; the runtime fails closed.`,
      );
    }

    let approved = false;
    let note: string | undefined;
    try {
      const answer = await requestApprovalWithTimeout(
        this.approvals,
        {
          capability,
          reason: decision.reason,
          scope: decision.scope,
          objective: this.currentObjective,
          stepIndex: this.steps.length,
        },
        this.approvalTimeoutMs,
      );
      approved = answer.approved;
      note = answer.note;
      this.sink.emit(POLICY_METRICS.APPROVALS_TOTAL, {
        [POLICY_LABEL_KEYS.OUTCOME]: approved ? "approved" : "denied",
        [POLICY_LABEL_KEYS.SCOPE]: decision.scope,
      });
    } catch (err) {
      note = `Approval provider error (fail-closed denial): ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    if (approved) return null;
    return this.policyDenialResult(toolCall, note ?? decision.reason);
  }

  private policyDenialResult(toolCall: ToolCallRequest, reason: string): ToolResult {
    this.policyDenials++;
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      success: false,
      output:
        `POLICY_DENIED :: ${reason}\n` +
        `Mandate: choose a materially different tool or approach, or announce the limitation.`,
      error: reason,
      trustLevel: "verified",
      executionTimeMs: 0,
    };
  }

  private async buildSchedule(stepIndex: number): Promise<RequestSchedule> {
    const manifests = await this.mountedManifests();

    return {
      mounting: { manifests },
      idleLiveSeconds: 1800,
      entropyOverride: 0.1,
      upperBoundTokenCount: this.budgets.maxTokensPerStep,
      killSwitch: this.killSwitch.signal,
      transcriptDigest: `run-${this.runId}-step-${stepIndex}`,
    };
  }

  /**
   * v0.1 behavior mounts every catalogue manifest. v0.2 with a selector
   * narrows the mounted set per step (progressive discovery); unmounted
   * tools remain dispatchable and governed.
   */
  private async mountedManifests(): Promise<
    Array<{ name: string; description: string; parametersJsonSchema: JSONSchema7 }>
  > {
    if (this.capabilitySelector === undefined) {
      return this.catalogue.manifests();
    }

    const available: CapabilityDescriptor[] = [];
    for (const handle of this.catalogue.slotNames()) {
      const tool = this.catalogue.get(handle);
      if (tool !== undefined) available.push(toolToCapability(tool));
    }

    const mounted = await this.capabilitySelector.select({
      objective: this.currentObjective,
      context: this.contextManager.lane,
      available,
      stepIndex: this.steps.length,
    });

    const manifests: Array<{
      name: string;
      description: string;
      parametersJsonSchema: JSONSchema7;
    }> = [];
    for (const capability of mounted.capabilities) {
      if (capability.kind !== "tool") continue;
      const tool = this.catalogue.get(capability.name);
      if (tool === undefined) continue; // Selector returned a stale id: skip.
      manifests.push({
        name: tool.handle,
        description: tool.caption,
        parametersJsonSchema: manifestSchemaFor(tool.argsShape),
      });
    }

    this.lastMountedCount = manifests.length;
    this.sink.emit(CAPABILITY_METRICS.MOUNTED_SIZE, {
      rationale: mounted.rationale,
      size: manifests.length,
    });
    return manifests;
  }

  /**
   * Mint a run-scoped sandbox lease (audit fix: the runner used to hand
   * every tool call a fabricated test lease tagged "test-scratch").
   * Lease lifetime tracks the remaining wall-clock budget.
   */
  private mintRunLease(): SandboxLease {
    const remainingMs = this.budgets.wallTimeCeilMs - (performance.now() - this.startTime);
    return {
      tag: `run:${this.runId}`,
      leaseMs: Math.max(1, Math.round(remainingMs)),
      maxResultBytes: SMART_LIMIT_BYTES,
      auditTrailId: crypto.randomUUID(),
      canClobberDisc: false,
    };
  }

  private checkBudgets(): void {
    const elapsed = performance.now() - this.startTime;

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
   *   This includes brain-gate saturation (resource ceiling, not corruption).
   * - Everything else is FAILED.
   */
  private classifyError(err: unknown): RunStatus {
    if (this.killSwitch.signal.aborted) return "CEDED";
    if (isRunAbortedError(err) || isGateAbortedError(err)) return "CEDED";
    if (isGateSaturatedError(err)) return "PARTIAL";
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
    capabilitySelector?: CapabilitySelector;
    policy?: CapabilityPolicy;
    approvals?: ApprovalProvider;
    approvalTimeoutMs?: number;
    router?: ModelRouter;
    laneMode?: "replace" | "append";
    sink?: EventSink;
  },
): AgentRunner {
  return new AgentRunner(brain, catalogue, contextManager, config);
}
