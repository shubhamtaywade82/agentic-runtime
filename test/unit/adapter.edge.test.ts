import { describe, it, expect } from "vitest";
import { createOllamaThoughtProcess } from "../../src/brain/adapter.js";
import {
  InferenceQualityError,
  RunAbortedError,
  TransportFailure,
} from "../../src/core/types.js";
import { vi } from "vitest";
import goldenFixture from "../fixtures/chat-response.sample.json";

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

  it("should throw InferenceQualityError on malformed tool arguments, preserving the violations list", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    vi.spyOn((tp as any).remote, "chat").mockResolvedValue({
      message: { 
        role: "assistant", 
        tool_calls: [{ function: { name: "test", arguments: "not-json" } }] 
      },
      done: true,
    });

    // Audit fix: coerce()'s InferenceQualityError used to be re-wrapped by
    // the catch block, destroying its violations and relabelling the root
    // cause as upstream_error.
    const err = await tp.digest([{ role: "user", content: "hi" }], { killSwitch: new AbortController().signal } as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InferenceQualityError);
    expect((err as InferenceQualityError).violations).toEqual(["malformed_json"]);
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

  it("should throw a typed RunAbortedError when aborted during call", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const controller = new AbortController();

    vi.spyOn((tp as any).remote, "chat").mockImplementation(async () => {
      controller.abort();
      throw new Error("SDK Abort");
    });

    // Audit fix: aborts are now typed RunAbortedError so downstream
    // classification is structural, not message-regex based.
    const err = await tp
      .digest([{ role: "user", content: "hi" }], { killSwitch: controller.signal } as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect((err as Error).message).toContain("Inference aborted by kill switch");
  });

  it("should forward the kill switch into the SDK request so in-flight calls are cancellable", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const controller = new AbortController();
    const sdkSpy = vi.spyOn((tp as any).remote, "chat").mockResolvedValue({
      message: { role: "assistant", content: "ok" },
      done: true,
    });

    await tp.digest([{ role: "user", content: "hi" }], {
      killSwitch: controller.signal,
    } as any);

    // Audit fix: the schedule kill switch is propagated as the SDK request
    // signal - previously it was only observed after the response arrived.
    const callArgs = sdkSpy.mock.calls[0][0];
    expect(callArgs.signal).toBe(controller.signal);
    sdkSpy.mockRestore();
  });

  it("should parse the SDK-shaped golden fixture (tool calls + ns->ms usage)", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, goldenFixture.model);
    vi.spyOn((tp as any).remote, "chat").mockResolvedValue(goldenFixture);

    const turn = await tp.digest(
      [{ role: "user", content: "Fetch weather for Tokyo" }],
      { killSwitch: new AbortController().signal } as any,
    );

    // The fixture's assistant message carries the tool call.
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({
      name: "get_weather",
      arguments: { city: "Tokyo" },
    });
    expect(turn.finishTag).toBe("tool_calls");
    // Durations are stored in nanoseconds and converted to milliseconds.
    expect(turn.usage).toMatchObject({
      promptTokens: 15,
      evalTokens: 10,
      totalDurationMs: 1500,
      loadDurationMs: 50,
    });
  });

  it("should throw abort error if signal is already aborted", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const controller = new AbortController();
    controller.abort();

    await expect(tp.digest([{ role: "user", content: "hi" }], { killSwitch: controller.signal } as any))
      .rejects.toThrow("Inference aborted by kill switch");
  });

  it("should stream tokens via onToken callback", async () => {
    const tp = createOllamaThoughtProcess(baseUrl, model);
    const fakeEvents = [
      { type: "token", data: { delta: "Hello" } },
      { type: "token", data: { delta: " world" } },
    ];
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        for (const evt of fakeEvents) {
          yield evt;
        }
      },
      finalResult: Promise.resolve({
        message: { role: "assistant", content: "Hello world" },
        done: true,
        doneReason: "stop",
        usage: { promptTokens: 5, completionTokens: 2 },
      }),
    };

    vi.spyOn((tp as any).remote, "chat").mockResolvedValue(fakeStream);

    const receivedTokens: string[] = [];
    const turn = await tp.digest([{ role: "user", content: "hi" }], {
      killSwitch: new AbortController().signal,
      onToken: (delta: string) => receivedTokens.push(delta),
    } as any);

    expect(receivedTokens).toEqual(["Hello", " world"]);
    expect(turn.content).toBe("Hello world");
    expect(turn.finishTag).toBe("stop");
  });
});
