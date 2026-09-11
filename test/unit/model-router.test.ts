import { describe, it, expect } from "vitest";
import { createScriptedBrain } from "./scripted-brain.js";
import {
  StaticModelRouter,
  createStaticModelRouter,
  MODEL_SELECTION_PHASES,
  type ModelSelectionRequest,
} from "../../src/router/types.js";
import { DeclarativeModelRouter, createDeclarativeModelRouter } from "../../src/router/declarative-router.js";

function selection(overrides: Partial<ModelSelectionRequest> = {}): ModelSelectionRequest {
  return {
    phase: "step",
    objective: "investigate the latency spike",
    stepIndex: 0,
    mountedToolCount: 4,
    contextPressure: 0.2,
    inferenceFailures: 0,
    ...overrides,
  };
}

const minicpm = createScriptedBrain(() => ({ content: "", toolCalls: [], finishTag: "stop", usage: null }));
const gemma = createScriptedBrain(() => ({ content: "", toolCalls: [], finishTag: "stop", usage: null }));

describe("StaticModelRouter", () => {
  it("always returns the configured brain with a stable tag", () => {
    const router = new StaticModelRouter(minicpm);
    const other = createScriptedBrain(() => ({ content: "", toolCalls: [], finishTag: "stop", usage: null }));
    expect(router.select(selection())).toBe(minicpm);
    expect(router.select(selection({ phase: "seal", contextPressure: 0.99 }))).toBe(minicpm);
    expect(router.select(selection())).not.toBe(other);
    expect(router.routerTag).toBe(`static:${minicpm.identityTag}`);
  });

  it("factory and custom tag", () => {
    const router = createStaticModelRouter(gemma, "hybrid-default");
    expect(router.routerTag).toBe("hybrid-default");
    expect(router.select(selection())).toBe(gemma);
  });
});

describe("DeclarativeModelRouter", () => {
  it("first matching rule wins; default handles the rest", () => {
    const router = new DeclarativeModelRouter({
      default: minicpm,
      rules: [
        { when: { phase: "seal" }, brain: gemma, description: "heavy synthesis" },
        { when: { contextPressureAbove: 0.8 }, brain: gemma },
        { when: { minInferenceFailures: 2 }, brain: gemma },
      ],
    });

    expect(router.select(selection({ phase: "step" }))).toBe(minicpm);
    expect(router.select(selection({ phase: "seal" }))).toBe(gemma);
    expect(router.select(selection({ contextPressure: 0.9 }))).toBe(gemma);
    expect(router.select(selection({ inferenceFailures: 3 }))).toBe(gemma);
    expect(router.select(selection({ contextPressure: 0.7 }))).toBe(minicpm);
    expect(router.defaultBrain).toBe(minicpm);
  });

  it("objective matching: string substring (case-insensitive) and regex", () => {
    const router = new DeclarativeModelRouter({
      default: minicpm,
      rules: [
        { when: { objectiveMatches: "deploy" }, brain: gemma },
        { when: { objectiveMatches: /prod(uction)?\b/i }, brain: gemma },
      ],
    });
    expect(router.select(selection({ objective: "Please DEPLOY the service" }))).toBe(gemma);
    expect(router.select(selection({ objective: "push to production" }))).toBe(gemma);
    expect(router.select(selection({ objective: "read a file" }))).toBe(minicpm);
  });

  it("phase can be a list; numeric thresholds are exclusive/inclusive as documented", () => {
    const router = new DeclarativeModelRouter({
      default: minicpm,
      rules: [
        { when: { phase: ["seal", "summarize"] }, brain: gemma },
        { when: { minMountedTools: 10, stepIndexAbove: 4 }, brain: gemma },
      ],
    });
    expect(router.select(selection({ phase: "summarize" }))).toBe(gemma);
    expect(router.select(selection({ phase: "dispute" }))).toBe(minicpm);
    // minMountedTools 10 not met at mountedToolCount 9:
    expect(router.select(selection({ mountedToolCount: 9, stepIndex: 10 }))).toBe(minicpm);
    expect(router.select(selection({ mountedToolCount: 10, stepIndex: 5 }))).toBe(gemma);
    // stepIndexAbove 4 means strictly after step 4:
    expect(router.select(selection({ mountedToolCount: 20, stepIndex: 4 }))).toBe(minicpm);
  });

  it("routing is pure and deterministic across repeated calls", () => {
    const router = createDeclarativeModelRouter({
      default: minicpm,
      rules: [{ when: { contextPressureAbove: 0.5 }, brain: gemma }],
    });
    const request = selection({ contextPressure: 0.6 });
    expect(router.select(request)).toBe(router.select(request));
    expect(router.select(request)).toBe(gemma);
  });

  it("exposes a stable router tag for observability", () => {
    const router = new DeclarativeModelRouter({ default: minicpm, rules: [] });
    expect(router.routerTag).toContain("declarative:");
  });

  it("MODEL_SELECTION_PHASES enumerates the selection phases", () => {
    expect(MODEL_SELECTION_PHASES).toEqual(["step", "seal", "summarize", "dispute"]);
  });
});
