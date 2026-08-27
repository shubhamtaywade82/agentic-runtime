import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMsg, RequestSchedule, AssistantTurn, ToolCallRequest } from "../src/core/types.js";
import type { ThoughtProcess } from "../src/brain/adapter.js";

// Replay harness types
export interface ReplayFixture {
  model: string;
  created_at: string;
  message: { role: string; content: string; tool_calls?: any[] };
  messages: Array<{ role: string; content: string; tool_calls?: any[] }>;
  done: boolean;
  done_reason: string;
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
  eval_count: number;
}

export interface MockOllamaClient {
  chat: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  verifyOrPullModel: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock OllamaClient that replays a golden fixture.
 * This allows testing the Brain seam without a live GPU.
 */
export function createMockOllamaClient(fixture: ReplayFixture): MockOllamaClient {
  return {
    chat: vi.fn().mockResolvedValue({
      model: fixture.model,
      created_at: fixture.created_at,
      messages: fixture.messages,
      done: fixture.done,
      done_reason: fixture.done_reason,
      total_duration: fixture.total_duration,
      load_duration: fixture.load_duration,
      prompt_eval_count: fixture.prompt_eval_count,
      eval_count: fixture.eval_count,
    }),
    list: vi.fn().mockResolvedValue({ models: [{ name: fixture.model }] }),
    pull: vi.fn().mockResolvedValue({ status: "success" }),
    verifyOrPullModel: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a ThoughtProcess that uses a mock client for testing.
 * This wraps the real OllamaThoughtProcess but injects the mock.
 */
export function createReplayThoughtProcess(fixture: ReplayFixture): ThoughtProcess {
  const mockClient = createMockOllamaClient(fixture);
  
  return {
    identityTag: `replay:${fixture.model}`,
    async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
      // Call the mock client directly (bypasses real SDK)
      const response = await mockClient.chat({
        model: fixture.model,
        messages,
        stream: false,
      });

      const assistantMsg = response.messages
        ?.filter((m: any) => m.role === "assistant")
        .pop() ?? response.messages?.[response.messages.length - 1];

      if (!assistantMsg) {
        throw new Error("No assistant message in replay fixture");
      }

      const toolCalls = assistantMsg.tool_calls ?? [];
      const finishReason = response.done_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
      
      let finishTag: AssistantTurn["finishTag"] = "stop";
      if (toolCalls.length > 0) {
        finishTag = "tool_calls";
      } else if (finishReason === "length") {
        finishTag = "length_truncated";
      }

      return {
        content: assistantMsg.content ?? "",
        toolCalls: toolCalls.map((tc: any, i: number) => ({
          id: tc.id ?? `${i}-${crypto.randomUUID()}`,
          name: tc.function?.name ?? `unknown_${i}`,
          arguments: typeof tc.function?.arguments === "string" 
            ? JSON.parse(tc.function.arguments) 
            : tc.function?.arguments ?? {},
        })),
        finishTag,
        usage: {
          promptTokens: response.prompt_eval_count ?? -1,
          evalTokens: response.eval_count ?? -1,
          totalDurationMs: response.total_duration ?? -1,
          loadDurationMs: response.load_duration ?? -1,
        },
      };
    },
  };
}

/**
 * Load the golden fixture from disk.
 */
export async function loadGoldenFixture(): Promise<ReplayFixture> {
  const fixtureModule = await import("../../test/fixtures/chat-response.sample.json", {
    assert: { type: "json" },
  });
  return fixtureModule.default as ReplayFixture;
}

/**
 * Test helper: Create a standard request schedule for testing.
 */
export function createTestSchedule(overrides: Partial<RequestSchedule> = {}): RequestSchedule {
  const controller = new AbortController();
  return {
    killSwitch: controller.signal,
    idleLiveSeconds: 1800,
    entropyOverride: 0.1,
    upperBoundTokenCount: 8000,
    ...overrides,
  };
}

/**
 * Test helper: Assert that a tool call matches expected structure.
 */
export function assertToolCall(
  actual: ToolCallRequest,
  expected: { name: string; arguments: Record<string, unknown> },
): void {
  expect(actual.name).toBe(expected.name);
  expect(actual.arguments).toEqual(expected.arguments);
  expect(actual.id).toBeDefined();
  expect(typeof actual.id).toBe("string");
}