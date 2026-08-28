import { describe, it, expect } from "vitest";
import { createOllamaThoughtProcess } from "../../src/brain/adapter.js";
import { InferenceQualityError, TransportFailure } from "../../src/core/types.js";
import { vi } from "vitest";

// Since internal utilities are not exported, we can test them via the public API
// or by using a trick to access them if they were exported.
// Looking at adapter.ts, they are not exported.
// To test them, I will create a new test file that focuses on the OllamaThoughtProcess
// and triggers the paths that use these utilities.

describe("OllamaThoughtProcess - Edge Cases & Internal Logic", () => {
  const baseUrl = "http://localhost:11434";
  const model = "llama3.2:3b";

  it("should initialize with default configuration", () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    expect(tp.identityTag).toBe(`ollama:${model}`);
  });

  it("should initialize with custom defaults", () => {
    const tp = createOllamaThoughtProcess(baseUrl, model, {
      timeoutMs: 10000,
      retries: 5,
      numCtx: 4096,
      idleLiveSeconds: 300,
    });
    expect(tp.identityTag).toBe(`ollama:${model}`);
    // Internal properties are private, but we can verify it doesn't throw
  });

  it("should handle tool mounting in payload", async () => {
    // We use a mock to verify the payload sent to the SDK
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const sdkSpy = vi.spyOn((tp as any).remote, "chat").mockResolvedValue({
      message: { role: "assistant", content: "ok" },
      done: true,
    });

    const schedule = {
      killSwitch: new AbortController().signal,
      mounting: {
        manifests: [{
          name: "test_tool",
          description: "desc",
          parametersJsonSchema: { type: "object", properties: {} },
        }],
      },
    };

    await tp.digest([{ role: "user", content: "hi" }], schedule as any);

    const callArgs = sdkSpy.mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools[0].function.name).toBe("test_tool");
    
    sdkSpy.mockRestore();
  });

  it("should handle output constraints when no tools are mounted", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const sdkSpy = vi.spyOn((tp as any).remote, "chat").mockResolvedValue({
      message: { role: "assistant", content: "ok" },
      done: true,
    });

    const schedule = {
      killSwitch: new AbortController().signal,
      constrain: {
        subjectOutputSchema: { type: "string" },
      },
    };

    await tp.digest([{ role: "user", content: "hi" }], schedule as any);

    const callArgs = sdkSpy.mock.calls[0][0];
    expect(callArgs.format).toEqual({ type: "string" });
    
    sdkSpy.mockRestore();
  });

  it("should throw InferenceQualityError when no assistant message is returned", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    vi.spyOn((tp as any).remote, "chat").mockResolvedValue({
      messages: [{ role: "user", content: "hi" }], // No assistant msg
      done: true,
    });

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: new AbortController().signal } as any))
      .rejects.toThrow(InferenceQualityError);
  });

  it("should throw InferenceQualityError on malformed tool arguments", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    vi.spyOn((tp as any).remote, "chat").mockResolvedValue({
      message: { 
        role: "assistant", 
        tool_calls: [{ function: { name: "test", arguments: "not-json" } }] 
      },
      done: true,
    });

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: new AbortController().signal } as any))
      .rejects.toThrow(InferenceQualityError);
  });

  it("should wrap transient transport errors as TransportFailure", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    vi.spyOn((tp as any).remote, "chat").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: new AbortController().signal } as any))
      .rejects.toThrow(TransportFailure);
  });

  it("should wrap non-transient errors as InferenceQualityError", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    vi.spyOn((tp as any).remote, "chat").mockRejectedValue(new Error("Some random critical error"));

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: new AbortController().signal } as any))
      .rejects.toThrow(InferenceQualityError);
  });

  it("should throw abort error when aborted during call", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const controller = new AbortController();
    
    vi.spyOn((tp as any).remote, "chat").mockImplementation(async () => {
      controller.abort();
      throw new Error("SDK Abort");
    });

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: controller.signal } as any))
      .rejects.toThrow("Inference aborted by kill switch");
  });

  it("should throw abort error if signal is already aborted", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const controller = new AbortController();
    controller.abort();

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: controller.signal } as any))
      .rejects.toThrow("Inference aborted by kill switch");
  });
});
