import solid from "@opentui/solid/bun-plugin";
import dts from "bun-plugin-dts";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import zodCompiler from "zod-compiler/bun";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

await rm(dist, { force: true, recursive: true });

try {
  const result = await Bun.build({
    entrypoints: [resolve(root, "src/plugin.tsx")],
    external: [
      "@opencode-ai",
      "@opencode-ai/*",
      "@opentui",
      "@opentui/*",
      "solid-js",
      "solid-js/*",
      "zod",
      "zod/*",
    ],
    format: "esm",
    minify: true,
    naming: "plugin.mjs",
    outdir: dist,
    plugins: [
      zodCompiler({ include: [resolve(root, "src/config.ts")], output: "schema" }),
      solid,
      dts({
        compilationOptions: { preferredConfigPath: resolve(root, "tsconfig.json") },
      }),
    ],
    sourcemap: "none",
    target: "bun",
  });

  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
