import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "capability/index": "src/capability/index.ts",
    "brain/index": "src/brain/index.ts",
    "hands/index": "src/hands/index.ts",
    "memory/index": "src/memory/index.ts",
    "loop/index": "src/loop/index.ts",
    "dispute/index": "src/dispute/index.ts",
    "sentinel/index": "src/sentinel/index.ts",
    "observability/index": "src/observability/index.ts",
    "synthesis/index": "src/synthesis/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "node",
});