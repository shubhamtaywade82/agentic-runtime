#!/usr/bin/env node
/**
 * Tarball consumer verification - protects the npm package contract.
 *
 * Flow:
 *   1. build (tsup + api-extractor) unless dist/ is already current
 *   2. npm pack
 *   3. fresh consumer project inside .verify-tmp/consumer
 *   4. npm install <tarball> + peers (zod, @nemesis-oss/ollama-sdk)
 *   5. compile every examples source against the INSTALLED package (strict,
 *      exactOptionalPropertyTypes - the README quickstart is compile-tested
 *      via examples/basic)
 *   6. RUN the offline custom-tools example against the installed package
 *      (proves the artifact executes, not just type-checks)
 *
 * Catches: missing dist files, wrong exports map, bad module paths,
 * missing peer deps, broken README snippets, runtime-only import failures.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tmp = resolve(root, ".verify-tmp");
const consumer = resolve(tmp, "consumer");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

console.log("==> 1/6 ensuring fresh build");
if (!existsSync(resolve(root, "dist/index.js"))) {
  run("pnpm", ["build"]);
}

console.log("==> 2/6 npm pack");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
run("npm", ["pack", "--pack-destination", tmp]);
const tarball = resolve(tmp, `${pkg.name.replace(/^@/, "").replace(/\//, "-")}-${pkg.version}.tgz`);
if (!existsSync(tarball)) {
  console.error(`tarball not found at ${tarball}`);
  process.exit(1);
}

console.log("==> 3/6 consumer project");
mkdirSync(consumer, { recursive: true });
writeFileSync(
  resolve(consumer, "package.json"),
  JSON.stringify(
    {
      name: "agentic-runtime-consumer-verify",
      private: true,
      type: "module",
    },
    null,
    2,
  ),
);

console.log("==> 4/6 installing tarball + peers");
run("npm", [
  "install",
  "--no-audit",
  "--no-fund",
  `--prefix`,
  consumer,
  tarball,
  "zod@^3.24",
  "@nemesis-oss/ollama-sdk@^1.3.0",
  "typescript@~5.9",
]);

// The tarball installs under the scoped name; npm --prefix puts it in
// consumer/node_modules.
const installed = resolve(consumer, "node_modules", pkg.name);
if (!existsSync(resolve(installed, "dist/index.js"))) {
  console.error(`installed package missing dist: ${installed}`);
  process.exit(1);
}

console.log("==> 5/6 compiling examples against the installed package");
const examples = ["basic", "custom-tools", "mcp-filesystem"];
for (const example of examples) {
  cpSync(resolve(root, "examples", example, "src"), resolve(consumer, "src", example), {
    recursive: true,
  });
}
writeFileSync(
  resolve(consumer, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: false,
        outDir: "dist-verify",
        rootDir: "src",
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  ),
);
run("npx", ["--prefix", consumer, "tsc", "-p", resolve(consumer, "tsconfig.json")], {
  cwd: consumer,
});

console.log("==> 6/6 executing the offline example against the installed package");
run(process.execPath, [resolve(consumer, "dist-verify/custom-tools/index.js")], { cwd: consumer });

// Import smoke: every public subpath must resolve from the tarball.
const subpaths = [
  ".",
  "./core",
  "./capability",
  "./policy",
  "./mcp",
  "./router",
  "./session",
  "./brain",
  "./hands",
  "./memory",
  "./loop",
  "./dispute",
  "./sentinel",
  "./observability",
  "./synthesis",
];
const specifiers = subpaths
  .map((s) => {
    const specifier = s === "." ? pkg.name : `${pkg.name}/${s.slice(2)}`;
    return `import(${JSON.stringify(specifier)})`;
  })
  .join(",\n  ");
writeFileSync(
  resolve(consumer, "import-smoke.mjs"),
  `const modules = await Promise.all([${specifiers}]);\n` +
    `if (modules.length !== ${subpaths.length}) throw new Error("missing exports");\n` +
    `console.log("import smoke ok: " + modules.length + " entrypoints");\n`,
);
run(process.execPath, [resolve(consumer, "import-smoke.mjs")], { cwd: consumer });

console.log("\nverify:package PASSED");
rmSync(tmp, { recursive: true, force: true });
