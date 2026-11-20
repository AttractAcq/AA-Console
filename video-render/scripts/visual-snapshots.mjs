import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { getCompositions, openBrowser, renderStill } from "@remotion/renderer";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const update = process.argv.includes("--update");
const browserExecutable = process.env.AA_REMOTION_BROWSER || undefined;
const root = resolve(import.meta.dirname, "..");
const snapshotRoot = join(root, "tests", "__snapshots__");
const serveUrl = await bundle({
  entryPoint: join(root, "src", "index.ts"),
  webpackOverride: (config) => enableTailwind({ ...config, resolve: { ...config.resolve, extensionAlias: { ...config.resolve?.extensionAlias, ".js": [".tsx", ".ts", ".js"] } } }),
});
const browser = await openBrowser("chrome", { browserExecutable });
let checked = 0;
const failures = [];
try {
  const compositions = await getCompositions({ serveUrl, puppeteerInstance: browser });
  for (const composition of compositions) {
    if (composition.id.startsWith("Gold-")) continue;
    const [component, aspect] = composition.id.match(/^(.*)-(16x9|9x16|1x1)$/)?.slice(1) ?? [];
    if (!component || !aspect) throw new Error(`Unexpected composition ID: ${composition.id}`);
    const frames = composition.durationInFrames === 1 ? [["10", 0], ["50", 0], ["90", 0]] : [["10", 15], ["50", 75], ["90", 135]];
    for (const [percent, frame] of frames) {
      const path = join(snapshotRoot, component, `${aspect}-${percent}.png`);
      const result = await renderStill({ composition, serveUrl, puppeteerInstance: browser, frame, imageFormat: "png", output: null, logLevel: "error" });
      if (!result.buffer) throw new Error(`No image buffer for ${composition.id} frame ${frame}`);
      if (update) {
        await mkdir(join(snapshotRoot, component), { recursive: true });
        await writeFile(path, result.buffer);
      } else {
        let expected;
        try { expected = await readFile(path); } catch { failures.push(`Missing snapshot ${path}`); continue; }
        const actualPng = PNG.sync.read(result.buffer);
        const expectedPng = PNG.sync.read(expected);
        if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) {
          failures.push(`Dimension mismatch ${path}`);
          continue;
        }
        const pixels = actualPng.width * actualPng.height;
        const changed = pixelmatch(actualPng.data, expectedPng.data, null, actualPng.width, actualPng.height, { threshold: 0.1 });
        if (changed / pixels > 0.005) failures.push(`${path}: ${(changed / pixels * 100).toFixed(3)}% differing pixels`);
      }
      checked++;
    }
    process.stdout.write(`${composition.id}: ${checked} stills ${update ? "updated" : "checked"}\n`);
  }
} finally {
  await browser.close({ silent: true });
}
if (failures.length) {
  for (const message of failures) process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${checked} component snapshots ${update ? "written" : "within 0.5% pixel tolerance"}.\n`);
}
