import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Conservative source fingerprint for the paid storyboard/review evaluation.
// Both URLs resolve to src/video from src/eval and from compiled dist/eval.
export async function videoScriptSourceSha256(): Promise<string> {
  const parts = await Promise.all([
    new URL("../../src/video/storyboard.ts", import.meta.url),
    new URL("../../src/video/review.ts", import.meta.url),
  ].map((url) => readFile(url, "utf8")));
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
