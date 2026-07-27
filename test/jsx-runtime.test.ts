import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import * as ts from "typescript";

const JSX_PRAGMA = "/** @jsxImportSource @opentui/solid */";
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function findTsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findTsxFiles(path);
      return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
    }),
  );
  return files.flat().sort();
}

describe("raw TSX JSX runtime", () => {
  it("uses the OpenTUI JSX runtime in every source file", async () => {
    const files = await findTsxFiles(sourceRoot);
    assert.ok(files.length > 0, "expected at least one TSX source file");

    for (const file of files) {
      const source = await readFile(file, "utf8");
      assert.equal(source.split(/\r?\n/, 1)[0], JSX_PRAGMA, file);

      const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
        },
        fileName: file,
      });

      assert.match(outputText, /@opentui\/solid\/jsx-runtime/, file);
      assert.doesNotMatch(outputText, /react\/jsx-runtime/, file);
    }
  });
});
