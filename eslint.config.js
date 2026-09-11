import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "test/"] },
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "core", pattern: "src/core/*" },
        { type: "brain", pattern: "src/brain/*" },
        { type: "hands", pattern: "src/hands/*" },
        { type: "loop", pattern: "src/loop/*" },
        { type: "capability", pattern: "src/capability/*" },
        { type: "policy", pattern: "src/policy/*" },
        { type: "mcp", pattern: "src/mcp/*" },
        { type: "router", pattern: "src/router/*" },
        { type: "session", pattern: "src/session/*" }
      ]
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            { from: "core", allow: ["core"] },
            { from: "brain", allow: ["core", "observability", "sentinel"] },
            { from: "hands", allow: ["core", "observability", "sentinel"] },
            { from: "capability", allow: ["core", "hands", "observability", "sentinel"] },
            { from: "policy", allow: ["core", "capability", "observability"] },
            { from: "mcp", allow: ["core", "hands", "capability", "policy", "observability", "sentinel"] },
            { from: "router", allow: ["core"] },
            { from: "session", allow: ["core", "brain", "hands", "memory", "loop", "capability", "policy", "mcp", "router", "sentinel", "observability"] },
            { from: "loop", allow: ["core", "brain", "hands", "memory", "dispute", "observability", "sentinel", "synthesis", "capability", "policy", "router"] }
          ]
        }
      ]
    }
  }
);