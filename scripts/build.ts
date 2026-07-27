import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import solidPlugin from "@opentui/solid/bun-plugin";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

await rm(dist, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/plugin.tsx", import.meta.url))],
  outdir: dist,
  naming: "plugin.js",
  target: "bun",
  format: "esm",
  packages: "external",
  sourcemap: "linked",
  plugins: [solidPlugin],
});

if (!result.success) {
  const logs = result.logs.map((log) => log.message).join("\n");
  throw new Error(`Build failed${logs ? `:\n${logs}` : "."}`);
}
