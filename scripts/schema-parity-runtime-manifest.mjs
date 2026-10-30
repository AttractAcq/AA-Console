#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_QUERIES, HISTORY_SQL } from "./schema-parity.mjs";
import { localSummary, readLocalMigrations, sha256 } from "./schema-parity-core.mjs";
import { generatedSchemaBody } from "./schema-parity-read-only-api.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = resolve(root, "agent-runtime/src/readiness/schema-parity-manifest.json");
const local = await readLocalMigrations(root);
const typeSource = await readFile(resolve(root, "src/types/database.ts"), "utf8");
const schemaBody = generatedSchemaBody(typeSource);
if (schemaBody === null) throw new Error("Could not isolate the generated public/GraphQL type schema body");
const manifest = {
  schemaVersion: 1,
  migrationSourceDigest: localSummary(local).digest,
  generatedTypesSha256: sha256(typeSource),
  generatedSchemaBodySha256: sha256(schemaBody),
  localMigrations: local,
  historySql: HISTORY_SQL,
  catalogQueries: CATALOG_QUERIES,
};
const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv[2] === "--check") {
  const existing = await readFile(target, "utf8").catch(() => "");
  if (existing !== json) {
    process.stderr.write("Schema parity runtime manifest is stale. Run node scripts/schema-parity-runtime-manifest.mjs and commit the generated file.\n");
    process.exitCode = 1;
  } else process.stdout.write("Schema parity runtime manifest matches migrations, generated types and catalog queries.\n");
} else if (process.argv.length === 2) {
  await writeFile(target, json);
  process.stdout.write(`Wrote ${target}\n`);
} else {
  process.stderr.write("Usage: node scripts/schema-parity-runtime-manifest.mjs [--check]\n");
  process.exitCode = 2;
}
