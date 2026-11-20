import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [irPath, brandPath] = process.argv.slice(2);
if (!irPath) throw new Error("Usage: npm run render:thumbnail -- <ir.json> [brand-snapshot.json]");
const ir = JSON.parse(await readFile(resolve(root, irPath), "utf8"));
const brandSnapshot = brandPath
  ? JSON.parse(await readFile(resolve(root, brandPath), "utf8")) : {};
const outDir = resolve(process.env.AA_VIDEO_OUT_DIR ?? resolve(root, "out"));
await mkdir(outDir, { recursive: true });
const tempDir = await mkdtemp(resolve(tmpdir(), "aa-video-thumbnail-"));

try {
  const propsPath = resolve(tempDir, "props.json");
  await writeFile(propsPath, JSON.stringify({ ir, brandSnapshot }));
  const title = String(ir.title ?? "thumbnail").replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "").slice(0, 80) || "thumbnail";
  const output = resolve(outDir, `${title}-thumbnail.jpg`);
  const args = ["still", "src/index.ts", "VideoThumbnail", output,
    `--props=${propsPath}`, "--log=error"];
  if (process.env.AA_REMOTION_BROWSER) {
    args.push("--browser-executable", process.env.AA_REMOTION_BROWSER);
  }
  process.stdout.write(`Rendering reviewed thumbnail to ${output}\n`);
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(resolve(root, "node_modules/.bin/remotion"), args,
      { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", done);
  });
  if (exitCode !== 0) throw new Error(`Thumbnail render failed with exit ${exitCode}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
