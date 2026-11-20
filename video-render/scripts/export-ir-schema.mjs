import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const repoRoot = resolve(root, "..");
const tempDir = await mkdtemp(resolve(root, ".ir-schema-export-"));

async function writeOrCheck(path, content) {
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== content) throw new Error(`${path} differs from generated IR contract`);
  } else {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

try {
  const bundle = resolve(tempDir, "schema.mjs");
  await build({
    entryPoints: [resolve(root, "src/ir/schema.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle,
    packages: "external",
    plugins: [{
      name: "empty-component-css",
      setup(api) {
        api.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-component-css" }));
        api.onLoad({ filter: /.*/, namespace: "empty-component-css" }, () => ({ contents: "", loader: "js" }));
      },
    }],
  });
  const { VideoIRSchema, registry } = await import(pathToFileURL(bundle).href);
  const schema = z.toJSONSchema(VideoIRSchema, { target: "draft-2020-12", io: "input" });
  const sceneItems = schema.properties?.scenes?.items;
  if (!sceneItems || typeof sceneItems !== "object") throw new Error("Generated IR schema has no scene items");
  sceneItems.properties.component.enum = sceneItems.properties.component.enum.filter((name) => name !== "ThumbnailCard");
  sceneItems.allOf = Object.entries(registry)
    .filter(([name]) => name !== "ThumbnailCard")
    .map(([name, entry]) => ({
      if: { properties: { component: { const: name } }, required: ["component"] },
      then: { properties: { props: z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" }) } },
    }));
  const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
  const catalogueText = `# AA video component catalogue\n\n${Object.entries(registry)
    .filter(([name]) => name !== "ThumbnailCard")
    .map(([name, entry]) => `## ${name}\n\n${entry.catalogueText}\n`)
    .join("\n")}\n`;
  for (const [name, content] of [["ir.schema.json", schemaText], ["catalogue.md", catalogueText]]) {
    await writeOrCheck(resolve(root, "generated", name), content);
    await writeOrCheck(resolve(repoRoot, "agent-runtime/src/video", name), content);
    await mkdir(resolve(root, "dist"), { recursive: true });
    await writeFile(resolve(root, "dist", name), content);
  }
  await writeOrCheck(resolve(repoRoot, "agent-runtime/src/video/semantic.ts"),
    await readFile(resolve(root, "src/ir/semantic.ts"), "utf8"));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
