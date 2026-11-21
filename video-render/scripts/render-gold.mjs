import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const aspects = process.argv.slice(2);
const selected = aspects.length ? aspects : ["16:9", "9:16", "1:1"];
if (selected.some((aspect) => !["16:9", "9:16", "1:1"].includes(aspect))) throw new Error("Use aspects 16:9, 9:16, or 1:1");
const fixturePath = resolve(root, "fixtures/ir/gold-01.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
if (fixture.scenes?.length !== 9) throw new Error("Gold fixture must contain nine scenes");
const outDir = resolve(process.env.AA_VIDEO_OUT_DIR ?? resolve(root, "out"));
await mkdir(outDir, { recursive: true });

for (const aspect of selected) {
  const id = `Gold-${aspect.replace(":", "x")}`;
  const output = resolve(outDir, `${id}.mp4`);
  const args = ["render", "src/index.ts", id, output, `--props=${fixturePath}`, "--concurrency=4"];
  if (process.env.AA_REMOTION_BROWSER) args.push("--browser-executable", process.env.AA_REMOTION_BROWSER);
  process.stdout.write(`Rendering ${id} to ${output}\n`);
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(resolve(root, "node_modules/.bin/remotion"), args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => done(code));
  });
  if (exitCode !== 0) throw new Error(`${id} failed with exit ${exitCode}`);
}
