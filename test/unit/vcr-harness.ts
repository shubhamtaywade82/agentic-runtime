import { describe, it, expect, vi } from "vitest";
import type { ThoughtProcess, ChatMsg, RequestSchedule, AssistantTurn } from "../../src/core/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface VCROptions {
  /** Directory where recordings are stored */
  recordingDir: string;
  /** 
   * Mode of operation:
   * - 'record': Use real LLM and save responses.
   * - 'replay': Use recorded responses, throw if missing.
   * - 'passthrough': Always use real LLM, do not record/replay.
   */
  mode: "record" | "replay" | "passthrough";
}

/**
 * VCRThoughtProcess wraps any ThoughtProcess to record and replay its interactions.
 * This ensures deterministic tests while allowing real LLM execution for initial setup.
 */
export class VCRThoughtProcess implements ThoughtProcess {
  constructor(
    private inner: ThoughtProcess,
    private options: VCROptions
  ) {}

  get identityTag(): string {
    return `vcr(${this.inner.identityTag})`;
  }

  private async getRequestHash(messages: ChatMsg[], schedule: RequestSchedule): Promise<string> {
    const payload = JSON.stringify({
      messages,
      schedule: {
        entropyOverride: schedule.entropyOverride,
        upperBoundTokenCount: schedule.upperBoundTokenCount,
        mounting: schedule.mounting,
        constrain: schedule.constrain,
      },
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
    if (this.options.mode === "passthrough") {
      return this.inner.digest(messages, schedule);
    }

    // VCR must also respect the kill switch even when replaying
    if (schedule.killSwitch?.aborted) {
      throw new Error("Inference aborted by kill switch");
    }

    const hash = await this.getRequestHash(messages, schedule);
    const filePath = path.join(this.options.recordingDir, `${hash}.json`);

    if (this.options.mode === "replay") {
      try {
        const content = await fs.readFile(filePath, "utf8");
        return JSON.parse(content) as AssistantTurn;
      } catch (err: any) {
        // If the request was aborted, prioritize that error over the "No recording found" error
        if (schedule.killSwitch?.aborted) {
          throw new Error("Inference aborted by kill switch");
        }
        throw new Error(`VCR: No recording found for request hash ${hash} at ${filePath}. Run with mode="record" to capture it.`);
      }
    }

    if (this.options.mode === "record") {
      // Try to load existing first to avoid redundant calls if already recorded
      try {
        const content = await fs.readFile(filePath, "utf8");
        return JSON.parse(content) as AssistantTurn;
      } catch {
        // Not recorded yet, execute and record
        const response = await this.inner.digest(messages, schedule);
        
        await fs.mkdir(this.options.recordingDir, { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(response, null, 2));
        
        return response;
      }
    }

    return this.inner.digest(messages, schedule);
  }
}

/**
 * Factory to create a VCR-wrapped process.
 */
export function createVCRProcess(
  inner: ThoughtProcess,
  recordingDir: string = "test/fixtures/vcr",
): VCRThoughtProcess {
  const mode = (process.env.VCR_MODE as VCROptions["mode"]) || "replay";
  return new VCRThoughtProcess(inner, { recordingDir, mode });
}
