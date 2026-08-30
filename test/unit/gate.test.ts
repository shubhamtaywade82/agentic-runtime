import { describe, it, expect } from "vitest";
import { ConcurrencyGate } from "../../src/sentinel/gate.js";
import {
  GateAbortedError,
  GateSaturatedError,
  isGateAbortedError,
  isGateSaturatedError,
  isRunAbortedError,
  isBudgetExhaustedError,
  isCognitiveOverloadError,
  isInferenceQualityError,
  RunAbortedError,
  BudgetExhaustedError,
  CognitiveOverloadError,
  InferenceQualityError,
} from "../../src/core/types.js";
import type { EventSink } from "../../src/core/types.js";
import { GATE_METRICS, GATE_LABEL_KEYS } from "../../src/observability/metrics.js";

function recordingSink(): { sink: EventSink; events: Array<{ name: string; payload: Record<string, unknown> }> } {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    sink: {
      emit(name: string, payload: Record<string, unknown>) {
        events.push({ name, payload });
      },
    },
  };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

describe("ConcurrencyGate - A7 fast-path telemetry", () => {
  it("emits runtime_gate_wait_ms with waitedMs=0 on the fast path (healthy runs stay visible)", async () => {
    const { sink, events } = recordingSink();
    const gate = new ConcurrencyGate(1, 10, "hands", sink);

    const release = await gate.acquire("critical", neverAbort());

    const wait = events.find((e) => e.name === GATE_METRICS.WAIT_MS);
    const grant = events.find((e) => e.name === GATE_METRICS.GRANTS_TOTAL);
    expect(wait).toBeDefined();
    expect(wait?.payload).toMatchObject({
      [GATE_LABEL_KEYS.GATE]: "hands",
      [GATE_LABEL_KEYS.PRIORITY]: "critical",
      waitedMs: 0,
    });
    expect(grant).toBeDefined();
    expect(grant?.payload).toMatchObject({ [GATE_LABEL_KEYS.GATE]: "hands", active: 1 });

    release();
  });

  it("emits runtime_gate_wait_ms with the real queue delay on the congested path", async () => {
    const { sink, events } = recordingSink();
    const gate = new ConcurrencyGate(1, 10, "hands", sink);

    const first = await gate.acquire("normal", neverAbort());
    const queued = gate.acquire("normal", neverAbort());
    // Let the queued waiter park, then free the slot.
    await new Promise((r) => setTimeout(r, 10));
    first();

    const release = await queued;
    const wait = events.find((e) => e.name === GATE_METRICS.WAIT_MS);
    expect(wait).toBeDefined();
    expect(wait?.payload.waitedMs).toBeGreaterThanOrEqual(0);
    // Both fast-path and queued acquisitions emit exactly one wait sample each.
    expect(events.filter((e) => e.name === GATE_METRICS.WAIT_MS)).toHaveLength(2);
    release();
  });

  it("emits runtime_gate_saturation_total when the queue ceiling rejects", async () => {
    const { sink, events } = recordingSink();
    const gate = new ConcurrencyGate(1, 0, "hands", sink);

    await expect(gate.acquire("normal", neverAbort())).rejects.toThrow(GateSaturatedError);

    const saturation = events.find((e) => e.name === GATE_METRICS.SATURATION_TOTAL);
    expect(saturation).toBeDefined();
    expect(saturation?.payload).toMatchObject({ [GATE_LABEL_KEYS.GATE]: "hands", maxDepth: 0 });
  });

  it("counts saturations and grants in lifetime stats", async () => {
    const { sink } = recordingSink();
    const gate = new ConcurrencyGate(1, 0, "hands", sink);

    await expect(gate.acquire("normal", neverAbort())).rejects.toThrow(GateSaturatedError);
    // maxQueueDepth 0: even the very first acquisition saturates.
    expect(gate.stats()).toMatchObject({ grants: 0, saturations: 1, refunds: 0 });
  });

  it("tracks grants, active, and queued in stats", async () => {
    const { sink } = recordingSink();
    const gate = new ConcurrencyGate(2, 10, "brain:test", sink);

    const r1 = await gate.acquire("normal", neverAbort());
    const r2 = await gate.acquire("normal", neverAbort());
    const queued = gate.acquire("normal", neverAbort());
    await new Promise((r) => setTimeout(r, 5));

    expect(gate.stats()).toMatchObject({
      grants: 2,
      active: 2,
      queued: 1,
      saturations: 0,
    });

    r1();
    const r3 = await queued;
    expect(gate.stats()).toMatchObject({ grants: 3, active: 2, queued: 0 });
    r2();
    r3();
    expect(gate.stats()).toMatchObject({ active: 0 });
  });
});

describe("Structural error predicates - A6", () => {
  it("recognizes duck-typed gate errors (cross-instance safety)", () => {
    // A structurally identical error from a second module instance
    // (dual-bundle hazard) must still be recognized.
    const duckTyped = new Error("Aborted while awaiting hands compute lease.");
    duckTyped.name = "GateAbortedError";

    expect(isGateAbortedError(duckTyped)).toBe(true);
    expect(isGateAbortedError(new GateAbortedError("hands"))).toBe(true);
    expect(isGateAbortedError(new Error("unrelated"))).toBe(false);
    expect(isGateAbortedError("not an error")).toBe(false);
  });

  it("recognizes duck-typed saturation errors", () => {
    const duckTyped = new Error("Gate hands queue saturated");
    duckTyped.name = "GateSaturatedError";
    expect(isGateSaturatedError(duckTyped)).toBe(true);
    expect(isGateSaturatedError(new GateSaturatedError("hands", 100))).toBe(true);
    expect(isGateSaturatedError(new GateAbortedError("hands"))).toBe(false);
  });

  it("recognizes duck-typed run abort, budget, overload, and inference errors", () => {
    const fakeAbort = new Error("Run aborted");
    fakeAbort.name = "RunAbortedError";
    expect(isRunAbortedError(fakeAbort)).toBe(true);
    expect(isRunAbortedError(new RunAbortedError())).toBe(true);

    const fakeBudget = new Error("Budget exhausted");
    fakeBudget.name = "BudgetExhaustedError";
    expect(isBudgetExhaustedError(fakeBudget)).toBe(true);
    expect(isBudgetExhaustedError(new BudgetExhaustedError("intents", 5, 20))).toBe(true);

    const fakeOverload = new Error("Cognitive step limit exceeded");
    fakeOverload.name = "CognitiveOverloadError";
    expect(isCognitiveOverloadError(fakeOverload)).toBe(true);
    expect(isCognitiveOverloadError(new CognitiveOverloadError(20, 15))).toBe(true);

    const fakeQuality = new Error("bad json");
    fakeQuality.name = "InferenceQualityError";
    expect(isInferenceQualityError(fakeQuality)).toBe(true);
    expect(isInferenceQualityError(new InferenceQualityError("bad", ["x"]))).toBe(true);
  });

  it("rejects plain errors and non-error values for every predicate", () => {
    const plain = new Error("plain");
    for (const predicate of [isGateAbortedError, isGateSaturatedError, isRunAbortedError]) {
      expect(predicate(plain)).toBe(false);
      expect(predicate(null)).toBe(false);
      expect(predicate(undefined)).toBe(false);
      expect(predicate({ name: "GateAbortedError" })).toBe(false);
    }
  });
});
