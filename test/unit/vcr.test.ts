import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { VCRThoughtProcess, VCROptions } from "./vcr-harness.js";
import type { ThoughtProcess, ChatMsg, RequestSchedule, AssistantTurn } from "../../src/core/types.js";

describe("VCRThoughtProcess", () => {
  const recordingDir = path.join(process.cwd(), "test/fixtures/vcr_test");
  
  // Mock ThoughtProcess
  const mockInner: ThoughtProcess = {
    identityTag: "mock-llm",
    async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
      return {
        content: `Response to ${messages[0]?.content}`,
        toolCalls: [],
        finishTag: "stop",
        usage: { promptTokens: 10, evalTokens: 20, totalDurationMs: 100, loadDurationMs: 50 },
      };
    },
  };

  beforeEach(async () => {
    await fs.rm(recordingDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(recordingDir, { recursive: true, force: true });
  });

  it("should record the response in 'record' mode", async () => {
    const vcr = new VCRThoughtProcess(mockInner, {
      recordingDir,
      mode: "record",
    });

    const messages: ChatMsg[] = [{ role: "user", content: "Hello" }];
    const schedule: RequestSchedule = { killSwitch: new AbortController().signal };

    const response = await vcr.digest(messages, schedule);
    
    expect(response.content).toBe("Response to Hello");
    
    const files = await fs.readdir(recordingDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it("should replay the response in 'replay' mode", async () => {
    // 1. First record it
    const recordVcr = new VCRThoughtProcess(mockInner, {
      recordingDir,
      mode: "record",
    });
    const messages: ChatMsg[] = [{ role: "user", content: "Hello" }];
    const schedule: RequestSchedule = { killSwitch: new AbortController().signal };
    await recordVcr.digest(messages, schedule);

    // 2. Now replay it with a spy on the inner process
    const spy = vi.spyOn(mockInner, "digest");
    const replayVcr = new VCRThoughtProcess(mockInner, {
      recordingDir,
      mode: "replay",
    });

    const response = await replayVcr.digest(messages, schedule);
    
    expect(response.content).toBe("Response to Hello");
    expect(spy).not.toHaveBeenCalled();
  });

  it("should throw error in 'replay' mode when recording is missing", async () => {
    const vcr = new VCRThoughtProcess(mockInner, {
      recordingDir,
      mode: "replay",
    });

    const messages: ChatMsg[] = [{ role: "user", content: "Hello" }];
    const schedule: RequestSchedule = { killSwitch: new AbortController().signal };

    await expect(vcr.digest(messages, schedule)).rejects.toThrow(/No recording found/);
  });

  it("should always call inner in 'passthrough' mode", async () => {
    const vcr = new VCRThoughtProcess(mockInner, {
      recordingDir,
      mode: "passthrough",
    });

    const spy = vi.spyOn(mockInner, "digest");
    const messages: ChatMsg[] = [{ role: "user", content: "Hello" }];
    const schedule: RequestSchedule = { killSwitch: new AbortController().signal };

    await vcr.digest(messages, schedule);
    expect(spy).toHaveBeenCalled();
    
    const files = await fs.readdir(recordingDir).catch(() => []);
    expect(files.length).toBe(0);
  });
});
