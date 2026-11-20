import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "fixtures/ir/gold-01.json"), "utf8");
const fixture = JSON.parse(source);
const output = `// Generated from fixtures/ir/gold-01.json; edit the JSON source.\nexport const GOLD_FIXTURE = ${JSON.stringify(fixture, null, 2)};\n`;
await writeFile(resolve(root, "src/compositions/gold-fixture.generated.ts"), output);
