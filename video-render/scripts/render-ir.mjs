import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [irPath, timingsPath, ...requestedAspects] = process.argv.slice(2);
if (!irPath || !timingsPath) throw new Error("Usage: npm run render:ir -- <ir.json> <timings.json> [16:9 9:16 1:1]");
const ir = JSON.parse(await readFile(resolve(root, irPath), "utf8"));
const timings = JSON.parse(await readFile(resolve(root, timingsPath), "utf8"));
const aspects = requestedAspects.length ? requestedAspects : ir.aspects;
if (!Array.isArray(ir.aspects) || aspects.some((aspect) => !["16:9", "9:16", "1:1"].includes(aspect) || !ir.aspects.includes(aspect))) {
  throw new Error("Requested aspect is invalid or absent from the IR");
}
const outDir = resolve(process.env.AA_VIDEO_OUT_DIR ?? resolve(root, "out"));
await mkdir(outDir, { recursive: true });
const tempDir = await mkdtemp(resolve(tmpdir(), "aa-video-ir-"));

try {
  for (const aspect of aspects) {
    const id = `VideoIR-${aspect.replace(":", "x")}`;
    const propsPath = resolve(tempDir, "props.json");
    const output = resolve(outDir, `${ir.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${aspect.replace(":", "x")}.mp4`);
    await writeFile(propsPath, JSON.stringify({ ir, timings, aspect }));
    const args = ["render", "src/index.ts", id, output, `--props=${propsPath}`, "--concurrency=4", "--log=error"];
    if (process.env.AA_REMOTION_BROWSER) args.push("--browser-executable", process.env.AA_REMOTION_BROWSER);
    process.stdout.write(`Rendering ${id} to ${output}\n`);
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(resolve(root, "node_modules/.bin/remotion"), args, { cwd: root, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", done);
    });
    if (exitCode !== 0) throw new Error(`${id} failed with exit ${exitCode}`);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
