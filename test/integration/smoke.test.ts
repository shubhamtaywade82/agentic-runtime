/**
 * LIVE-DAEMON SMOKE TESTS (opt-in).
 *
 * Skipped unless OLLAMA_SMOKE=1 so the default `pnpm test` never needs a
 * daemon:
 *
 *   OLLAMA_SMOKE=1 pnpm test:smoke
 *
 * With UPDATE_GOLDEN=1 the capture test additionally overwrites
 * test/fixtures/chat-response.sample.json with a LIVE ChatResponse, which
 * is the pre-freeze replacement path for the synthetic golden fixture:
 *
 *   OLLAMA_SMOKE=1 UPDATE_GOLDEN=1 pnpm test:smoke
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createOllamaThoughtProcess } from "../../src/brain/adapter.js";
import { SynthesisEngine } from "../../src/synthesis/sealer.js";
import { FinalReportSchema } from "../../src/core/types.js";
import type { SealMetrics } from "../../src/synthesis/sealer.js";

const SMOKE = process.env.OLLAMA_SMOKE === "1";
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";
const BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";

const smokeMetrics: SealMetrics = {
  totalSteps: 1,
  totalToolCalls: 0,
  totalWallTimeMs: 1,
  totalTokensIn: 1,
  totalTokensOut: 1,
  sentinelAcquisitions: 0,
  sentinelRejections: 0,
};

describe.skipIf(!SMOKE)("Ollama live smoke (OLLAMA_SMOKE=1)", () => {
  it(
    "digests a live chat round-trip",
    async () => {
      const brain = createOllamaThoughtProcess(BASE_URL, MODEL);
      const turn = await brain.digest(
        [{ role: "user", content: "Reply with exactly: ok" }],
        { killSwitch: new AbortController().signal, entropyOverride: 0 },
      );
      expect(typeof turn.content).toBe("string");
      expect(["stop", "tool_calls", "length_truncated"]).toContain(turn.finishTag);
    },
    120_000,
  );

  it(
    "seals a schema-valid FinalReport via the live daemon",
    async () => {
      const brain = createOllamaThoughtProcess(BASE_URL, MODEL);
      const sealer = new SynthesisEngine(brain);
      const report = await sealer.seal({
        lane: [
          {
            role: "user",
            content:
              "Smoke run: the daemon answered a trivial probe. Summarize this fact.",
          },
        ],
        status: "ACHIEVED",
        objective: "smoke-test the live daemon",
        baseSchedule: { killSwitch: new AbortController().signal },
        metrics: smokeMetrics,
      });
      expect(FinalReportSchema.safeParse(report).success).toBe(true);
      expect(report.status).toBe("ACHIEVED");
    },
    120_000,
  );

  it(
    "captures a live ChatResponse golden fixture (UPDATE_GOLDEN=1 to persist)",
    async () => {
      const brain = createOllamaThoughtProcess(BASE_URL, MODEL);
      // The adapter's SDK client is private; the smoke test reaches it to
      // persist the RAW ChatResponse (the adapter itself only exposes the
      // parsed AssistantTurn).
      const remote = (brain as unknown as {
        remote: { chat: (req: unknown) => Promise<unknown> };
      }).remote;
      const response = (await remote.chat({
        model: MODEL,
        messages: [{ role: "user", content: "Fetch weather for Tokyo" }],
        stream: false,
      })) as Record<string, unknown>;

      // Sanity: the live response must be SDK ChatResponse-shaped.
      expect(response.message).toBeDefined();
      expect(typeof response.total_duration).toBe("number");

      if (UPDATE_GOLDEN) {
        const fixturePath = path.join(
          process.cwd(),
          "test/fixtures/chat-response.sample.json",
        );
        const payload = {
          _provenance: `LIVE capture from ${BASE_URL} (${new Date().toISOString()}) via OLLAMA_SMOKE=1 UPDATE_GOLDEN=1.`,
          ...response,
        };
        await fs.writeFile(fixturePath, JSON.stringify(payload, null, 2) + "\n");
      }
    },
    120_000,
  );
});
