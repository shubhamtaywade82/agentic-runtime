import { describe, it, expect, beforeEach } from "vitest";
import { createTestSchedule, assertToolCall } from "./brain-replay-harness.js";
import { createOllamaThoughtProcess } from "../../src/brain/adapter.js";
import { createVCRProcess } from "./vcr-harness.js";
import type { ChatMsg, RequestSchedule } from "../src/core/types.js";

describe("Brain Seam - VCR Integration Tests", () => {
  let thoughtProcess: any;

  beforeEach(async () => {
    const realProcess = createOllamaThoughtProcess(
      process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      process.env.OLLAMA_MODEL || "llama3.2:3b"
    );
    thoughtProcess = createVCRProcess(realProcess);
  });

  it("should digest a request and parse tool calls correctly", async () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "Fetch weather for Tokyo" },
    ];

    const schedule = createTestSchedule();
    const result = await thoughtProcess.digest(messages, schedule);

    // Verify basic structure
    expect(result).toBeDefined();
    expect(typeof result.content).toBe("string");
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.usage).toBeDefined();

    // If the model supports tools and we've recorded a tool call, verify it.
    if (result.toolCalls.length > 0) {
      expect(result.finishTag).toBe("tool_calls");
      assertToolCall(result.toolCalls[0], {
        name: expect.any(String),
        arguments: expect.any(Object),
      });
    } else {
      expect(result.finishTag).toBe("stop");
    }
  }, 30000);

  it("should handle standard stop reason", async () => {
    const result = await thoughtProcess.digest(
      [{ role: "user", content: "Hello" }],
      createTestSchedule(),
    );

    expect(result.finishTag).toBe("stop");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBeDefined();
  }, 30000);

  it("should handle potential length truncation", async () => {
    const schedule = { 
      ...createTestSchedule(), 
      upperBoundTokenCount: 1 
    };
    
    const result = await thoughtProcess.digest(
      [{ role: "user", content: "Write a very long story" }],
      schedule,
    );

    expect(["stop", "length_truncated"]).toContain(result.finishTag);
    expect(result.content).toBeDefined();
  }, 30000);

  it("should respect kill switch abort signal", async () => {
    const controller = new AbortController();
    const schedule = { ...createTestSchedule(), killSwitch: controller.signal };
    
    // We use a specific tag for abort tests to avoid recording these failures
    const promise = thoughtProcess.digest([{ role: "user", content: "Abort test" }], schedule);
    controller.abort();
    
    await expect(promise)
      .rejects.toThrow(/aborted|kill switch/i);
  }, 30000);

  it("should handle multi-turn conversation history", async () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "What's the weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Tokyo" } }] },
      { role: "tool", content: '{"temp": 22, "condition": "sunny"}', toolCallId: "call_1" },
    ];
    
    const result = await thoughtProcess.digest(
      messages,
      createTestSchedule(),
    );

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  }, 30000);

  it("should ensure tool arguments are coerced to objects", async () => {
    const result = await thoughtProcess.digest(
      [{ role: "user", content: "Search for the current stock price of AAPL" }],
      createTestSchedule(),
    );

    if (result.toolCalls.length > 0) {
      expect(typeof result.toolCalls[0].arguments).toBe("object");
      expect(result.toolCalls[0].arguments).not.toBeNull();
    }
  }, 30000);
});