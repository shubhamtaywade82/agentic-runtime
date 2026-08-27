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
        { type: "loop", pattern: "src/loop/*" }
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
            { from: "loop", allow: ["core", "brain", "hands", "memory", "dispute", "observability", "sentinel", "synthesis"] }
          ]
        }
      ]
    }
  }
);