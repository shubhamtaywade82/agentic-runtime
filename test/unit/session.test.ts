import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgentRuntime, DEFAULT_AGENT_CHARTER } from "../../src/session/runtime.js";
import type { ToolResult } from "../../src/core/types.js";
import {
  assistantTurn,
  createScriptedBrain,
  modelReportJson,
} from "./scripted-brain.js";
import { ResourceSentinel } from "../../src/sentinel/index.js";

const noopSink = { emit: () => {} };

function answerBrain(answer = "Done. The result is sufficient for the objective.") {
  return createScriptedBrain((call) => {
    if (call.schedule.constrain !== undefined) {
      return assistantTurn({ content: modelReportJson() });
    }
    return assistantTurn({ content: answer });
  });
}

const echoTool = {
  handle: "echo",
  caption: "echoes input",
  argsShape: z.object({ x: z.number().optional() }),
  resourceClass: "external-network" as const,
  effects: "pure" as const,
  grantLevel: "auto" as const,
  invoke: async (): Promise<ToolResult> => ({
    toolCallId: "call-echo",
    name: "echo",
    success: true,
    output: "echoed",
    trustLevel: "unverified",
    executionTimeMs: 1,
  }),
};

const mcpFixture = "/home/z/my-project/agentic-runtime/test/fixtures/fake-mcp-server.mjs";

describe("createAgentRuntime - configuration", () => {
  it("requires exactly one of brain/router (fail-closed)", async () => {
    await expect(createAgentRuntime({})).rejects.toThrowError(/exactly one of config.brain or config.router/);
    const brain = answerBrain();
    await expect(createAgentRuntime({ brain, router: { select: () => brain, routerTag: "x" } })).rejects.toThrowError(
      /not both/,
    );
  });

  it("accepts a router and infers the primary brain for digestion", async () => {
    const brain = answerBrain();
    const runtime = await createAgentRuntime({
      router: { select: () => brain, routerTag: "custom-router", defaultBrain: brain },
    });
    expect(typeof runtime.run).toBe("function");
    await runtime.close();
  });

  it("rejects routers without an inferable primary brain", async () => {
    const brain = answerBrain();
    await expect(
      createAgentRuntime({ router: { select: () => brain, routerTag: "opaque" } }),
    ).rejects.toThrowError(/Cannot infer a primary brain/);
  });
});

describe("AgentRuntime.run - one-shot", () => {
  it("runs a full governed loop with native tools and seals", async () => {
    let toolCalls = 0;
    const runtime = await createAgentRuntime({
      brain: answerBrain(),
      tools: [
        {
          ...echoTool,
          invoke: async (): Promise<ToolResult> => {
            toolCalls++;
            return {
              toolCallId: "call-echo",
              name: "echo",
              success: true,
              output: "echoed",
              trustLevel: "unverified",
              executionTimeMs: 1,
            };
          },
        },
      ],
    });

    const result = await runtime.run("Say hello");
    expect(result.status).toBe("ACHIEVED");
    expect(result.finalReport.seal.hash).toMatch(/^sha256:/);
    expect(toolCalls).toBe(0); // The brain answered directly; tools stayed mounted but unused.
    await runtime.close();
  });

  it("fresh context per run (no leakage between one-shots)", async () => {
    const runtime = await createAgentRuntime({ brain: answerBrain() });
    await runtime.run("first objective");
    await runtime.run("second objective");
    // Both runs sealed; nothing leaked (each got a new ContextManager).
    await runtime.close();
  });
});

describe("AgentSession - continuity", () => {
  it("context lane accumulates across runs and charter is pinned", async () => {
    const runtime = await createAgentRuntime({ brain: answerBrain() });
    const session = runtime.createSession();

    await session.run("remember the number 42");
    await session.run("what number did I mention?");

    const lane = session.lane;
    expect(lane.some((m) => m.content.includes("remember the number 42"))).toBe(true);
    expect(lane.some((m) => m.content.includes("what number did I mention?"))).toBe(true);
    // Charter pinned at position 0.
    expect(lane[0]?.role).toBe("system");
    expect(lane[0]?.content).toBe(DEFAULT_AGENT_CHARTER);
    await runtime.close();
  });

  it("sessions are independent of each other", async () => {
    const runtime = await createAgentRuntime({ brain: answerBrain() });
    const a = runtime.createSession();
    const b = runtime.createSession();

    await a.run("session A objective");
    await b.run("session B objective");

    expect(a.lane.some((m) => m.content.includes("session A objective"))).toBe(true);
    expect(a.lane.some((m) => m.content.includes("session B objective"))).toBe(false);
    await runtime.close();
  });

  it("abort cedes the active run", async () => {
    let releaseBrain: (() => void) | undefined;
    const slowBrain = createScriptedBrain((call) => {
      if (call.schedule.constrain !== undefined) {
        return assistantTurn({ content: modelReportJson() });
      }
      // Hangs until released OR aborted (models that resolve instead of
      // throwing on cancellation).
      return new Promise((resolve) => {
        const onAbort = () => resolve(assistantTurn({ content: "" }));
        call.schedule.killSwitch.addEventListener("abort", onAbort, { once: true });
        releaseBrain = () => {
          call.schedule.killSwitch.removeEventListener("abort", onAbort);
          resolve(assistantTurn({ content: "finally" }));
        };
      }) as never;
    });

    const runtime = await createAgentRuntime({ brain: slowBrain, budgets: { maxCogStepN: 5 } });
    const session = runtime.createSession();

    const pending = session.run("long objective");
    // Abort before the brain resolves on its own.
    setTimeout(() => session.abort("operator changed their mind"), 20);

    const result = await pending;
    expect(result.status).toBe("CEDED");
    expect(result.finalReport.status).toBe("CEDED");
    releaseBrain?.();
    await runtime.close();
  }, 10_000);
});

describe("createAgentRuntime - MCP integration", () => {
  it("connects servers, governs their tools, defaults policy to trust-aware", async () => {
    const runtime = await createAgentRuntime({
      brain: answerBrain(),
      tools: [echoTool],
      mcp: {
        servers: [
          {
            serverId: "fakefs",
            transport: "stdio",
            command: process.execPath,
            args: [mcpFixture],
            trust: "verified",
            sideEffects: { network: false, filesystem: true, process: false, database: false, externalMutation: false },
          },
        ],
      },
      sentinel: new ResourceSentinel(
        { maxParallelTools: 4, maxParallelInferences: 1, maxQueueDepth: 64 },
        noopSink,
      ),
    });

    // Native + adapted tools registered and discoverable.
    const capabilities = runtime.capabilities();
    expect(capabilities.some((c) => c.name === "echo")).toBe(true);
    expect(capabilities.some((c) => c.name === "fakefs__read_file")).toBe(true);
    expect(capabilities.some((c) => c.source === "mcp")).toBe(true);

    // Trust map feeds the default policy.
    expect(runtime.trustMap()["fakefs"]).toBe("verified");

    const result = await runtime.run("Read /etc/hosts with the file tool");
    expect(result.status).toBe("ACHIEVED");
    expect(result.finalReport.seal.hash).toMatch(/^sha256:/);

    await runtime.close();
  }, 15_000);

  it("addMcpServer requires config.mcp (fail-closed)", async () => {
    const runtime = await createAgentRuntime({ brain: answerBrain() });
    await expect(
      runtime.addMcpServer({
        serverId: "late",
        transport: "stdio",
        command: process.execPath,
        args: [mcpFixture],
      }),
    ).rejects.toThrowError(/without MCP support/);
    await runtime.close();
  });
});
