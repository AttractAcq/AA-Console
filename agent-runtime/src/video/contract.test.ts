import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("video IR contract copies", () => {
  for (const file of ["ir.schema.json", "catalogue.md", "semantic.ts"]) {
    it(`keeps the runtime ${file} identical to the renderer export`, () => {
      const runtime = readFileSync(resolve(import.meta.dirname, file));
      const renderer = readFileSync(resolve(repoRoot, "video-render", file === "semantic.ts"
        ? "src/ir/semantic.ts" : `generated/${file}`));
      expect(runtime.equals(renderer)).toBe(true);
    });
  }
});
