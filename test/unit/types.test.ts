import { describe, it, expect } from "vitest";
import { 
  AgentRuntimeError, 
  TransportFailure, 
  InferenceQualityError, 
  ToolFailure, 
  BudgetExhaustedError, 
  CognitiveOverloadError, 
  ToolExecutionError, 
  HumanGateTimeoutError, 
  DisputeResolutionError, 
  ConcurrencyDeniedError, 
  GateAbortedError, 
  GateSaturatedError,
  isTransientTransport,
  isGateAbortedError,
  isGateSaturatedError
} from "../../src/core/types.js";

describe("Core Types - Error Hierarchy", () => {
  it("AgentRuntimeError should capture stack trace and metadata", () => {
    const err = new AgentRuntimeError("test message", "TEST_CODE", "root cause");
    expect(err.message).toBe("test message");
    expect(err.code).toBe("TEST_CODE");
    expect(err.cause).toBe("root cause");
    expect(err.name).toBe("AgentRuntimeError");
  });

  it("TransportFailure should set correct code", () => {
    const err = new TransportFailure("network fail", 1000, new Error("socket"));
    expect(err.code).toBe("TRANSPORT_FAILURE");
    expect(err.retryAfterMs).toBe(1000);
  });

  it("InferenceQualityError should store violations", () => {
    const err = new InferenceQualityError("bad json", ["missing_field"], "raw string");
    expect(err.code).toBe("INFERENCE_QUALITY_ERROR");
    expect(err.violations).toContain("missing_field");
    expect(err.rawOutput).toBe("raw string");
  });

  it("ToolFailure should store category", () => {
    const err = new ToolFailure("denied", "denied");
    expect(err.category).toBe("denied");
  });

  it("BudgetExhaustedError should format message correctly", () => {
    const err = new BudgetExhaustedError("tokens", 100, 50);
    expect(err.message).toContain("Budget exhausted: tokens (100/50)");
  });

  it("CognitiveOverloadError should store limits", () => {
    const err = new CognitiveOverloadError(20, 15, new Error("loop"));
    expect(err.stepsExecuted).toBe(20);
    expect(err.limit).toBe(15);
  });

  it("ToolExecutionError should wrap original error", () => {
    const cause = new Error("disk full");
    const err = new ToolExecutionError("write_file", { path: "/tmp" }, cause);
    expect(err.toolName).toBe("write_file");
    expect(err.originalError).toBe(cause);
  });

  it("HumanGateTimeoutError should store timeoutMs", () => {
    const err = new HumanGateTimeoutError("approve_payment", 60000);
    expect(err.timeoutMs).toBe(60000);
  });

  it("DisputeResolutionError should store tier", () => {
    const err = new DisputeResolutionError(2, "conflict");
    expect(err.tier).toBe(2);
    expect(err.reason).toBe("conflict");
  });

  it("ConcurrencyDeniedError should store limits", () => {
    const err = new ConcurrencyDeniedError("gpu", 1, 0);
    expect(err.resourceClass).toBe("gpu");
    expect(err.requested).toBe(1);
  });

  it("GateAbortedError should set correct name", () => {
    const err = new GateAbortedError("cpu-lease");
    expect(err.name).toBe("GateAbortedError");
    expect(err.message).toContain("cpu-lease");
  });

  it("GateSaturatedError should store maxDepth", () => {
    const err = new GateSaturatedError("network", 10);
    expect(err.message).toContain("max depth: 10");
  });

  describe("Type Guards", () => {
    it("isTransientTransport should detect typical network errors", () => {
      expect(isTransientTransport(new Error("ECONNREFUSED"))).toBe(true);
      expect(isTransientTransport(new Error("socket hang up"))).toBe(true);
      expect(isTransientTransport(new Error("503 Service Unavailable"))).toBe(true);
      expect(isTransientTransport(new Error("Invalid API Key"))).toBe(false);
      expect(isTransientTransport("not an error")).toBe(false);
    });

    it("isGateAbortedError should correctly identify GateAbortedError", () => {
      expect(isGateAbortedError(new GateAbortedError("test"))).toBe(true);
      expect(isGateAbortedError(new Error("abort"))).toBe(false);
    });

    it("isGateSaturatedError should correctly identify GateSaturatedError", () => {
      expect(isGateSaturatedError(new GateSaturatedError("test", 5))).toBe(true);
      expect(isGateSaturatedError(new Error("sat"))).toBe(false);
    });
  });
});
