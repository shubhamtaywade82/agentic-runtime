import type {
  AssistantTurn,
  ChatMsg,
  RequestSchedule,
  ThoughtProcess,
} from "../../src/core/types.js";

/**
 * A recorded inference call (messages + schedule), for asserting
 * No-Tools Guarantees, entropy overrides, and prompt structure.
 */
export interface RecordedCall {
  messages: ChatMsg[];
  schedule: RequestSchedule;
}

export type ScriptFn = (
  call: RecordedCall,
  index: number,
) => AssistantTurn | Promise<AssistantTurn>;

export interface ScriptedBrain extends ThoughtProcess {
  /** Every digest call, in order. */
  calls: RecordedCall[];
}

/**
 * Convenience constructor for AssistantTurn in tests.
 */
export function assistantTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    content: "",
    toolCalls: [],
    finishTag: "stop",
    usage: null,
    ...overrides,
  };
}

/**
 * A deterministic ThoughtProcess that scripts responses via a function and
 * records every call. Zero network - the core of offline deterministic tests.
 */
export function createScriptedBrain(script: ScriptFn): ScriptedBrain {
  const calls: RecordedCall[] = [];
  return {
    identityTag: "scripted:test",
    calls,
    async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
      calls.push({ messages, schedule });
      return script({ messages, schedule }, calls.length - 1);
    },
  };
}

/**
 * Standard seal metrics for tests (all schema-valid integers).
 */
export function testSealMetrics(overrides: Partial<Record<string, number>> = {}) {
  return {
    totalSteps: 2,
    totalToolCalls: 3,
    totalWallTimeMs: 1500,
    totalTokensIn: 400,
    totalTokensOut: 120,
    sentinelAcquisitions: 4,
    sentinelRejections: 1,
    ...overrides,
  };
}

/**
 * A schema-valid FinalReport-shaped JSON payload as a model would emit it.
 * `corruptions` mutate selected fields for negative tests.
 */
export function modelReportJson(
  corruptions: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    status: "ACHIEVED",
    objective: "corrupted-objective",
    executiveSummary:
      "A model-authored executive summary that comfortably exceeds fifty characters.",
    findings: [
      {
        claim: "The API returned 200 OK within the deadline.",
        evidenceRef: "receipt-abc123",
        confidence: 0.9,
      },
    ],
    disputes: [],
    metrics: {
      totalSteps: 999,
      totalToolCalls: 999,
      totalWallTimeMs: 999,
      totalTokensIn: 999,
      totalTokensOut: 999,
      sentinelAcquisitions: 999,
      sentinelRejections: 999,
    },
    seal: {
      timestamp: "2024-05-10T12:00:00.000Z",
      hash: "model-forged-hash",
      runtimeVersion: "model-forged-version",
    },
    ...corruptions,
  });
}
