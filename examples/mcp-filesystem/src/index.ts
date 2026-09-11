/**
 * MCP progressive discovery against the official filesystem reference
 * server - COMPILE-TESTED by `pnpm verify:package`; running it requires:
 *
 *   - a live Ollama daemon (any tool-calling model, e.g. qwen3:8b)
 *   - npx available (fetches @modelcontextprotocol/server-filesystem)
 *   - a workspace directory the server may access
 *
 * Demonstrates: MCP server registration with trust + side-effect
 * declarations, policy-gated dispatch, progressive discovery (the model
 * sees only the top-k relevant tools), and terminal sealing.
 */
import {
  createAgentRuntime,
  createOllamaThoughtProcess,
  createApprovalProvider,
} from "@nemesis-oss/agentic-runtime";

const WORKSPACE = "/tmp/agent-workspace";

const runtime = await createAgentRuntime({
  brain: createOllamaThoughtProcess("http://localhost:11434", "qwen3:8b"),

  // Native tools and MCP tools live in ONE governed catalogue.
  mcp: {
    servers: [
      {
        serverId: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", WORKSPACE],
        // Operator-declared trust and side effects drive policy routing:
        // filesystem tools gate through filesystem-read/-write Sentinel
        // classes, and destructive operations escalate to manual approval.
        trust: "verified",
        sideEffects: {
          network: false,
          filesystem: true,
          process: false,
          database: false,
          externalMutation: false,
        },
      },
    ],
    limit: 6, // top-k capabilities mounted per run (context efficiency)
    callTimeoutMs: 30_000,
  },

  // Human approval boundary: destructive tools (write/delete) ask first.
  approvals: createApprovalProvider(async (request) => {
    console.log(
      `\n[approval needed] ${request.capability.name} (${request.scope} scope)\n  reason: ${request.reason}\n`,
    );
    // Wire a real prompt (readline, web UI, pager) here. Auto-deny for the demo:
    return { approved: false, note: "Demo approvals are auto-denied." };
  }),

  budgets: { maxCogStepN: 12, wallTimeCeilMs: 300_000 },
});

console.log("registered capabilities:");
for (const capability of runtime.capabilities()) {
  console.log(`  - ${capability.id} [${capability.kind}] grant=${capability.grantLevel ?? "n/a"}`);
}

const result = await runtime.run(
  `List the files in ${WORKSPACE}, then write a one-line summary to summary.txt.`,
);

console.log("\nstatus: ", result.status);
console.log("report: ", result.finalReport.executiveSummary.slice(0, 160), "...");
console.log("tools dispatched:", result.intentsDispatched);

await runtime.close();
