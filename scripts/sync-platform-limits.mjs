#!/usr/bin/env node
/**
 * Copy the shared region of the platform limits into the browser's mirror.
 *
 * The limits live once, in agent-runtime. The browser needs them too and the
 * two projects do not share a tsconfig, so the mirror is a real file rather
 * than an import. This script is what keeps it honest, and
 * platformLimits.mirror.test.ts is what notices when someone forgets to run it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const MARK = "// ---- shared region: byte-identical with the mirror; a test enforces it ----";
const SOURCE = "agent-runtime/src/content/platform-limits.ts";
const MIRROR = "src/lib/platformLimits.ts";

const source = readFileSync(SOURCE, "utf8");
const mirror = readFileSync(MIRROR, "utf8");
for (const [path, text] of [[SOURCE, source], [MIRROR, mirror]]) {
  if (!text.includes(MARK)) {
    console.error(`${path} has no shared-region marker.`);
    process.exit(1);
  }
}

const updated = mirror.slice(0, mirror.indexOf(MARK)) + source.slice(source.indexOf(MARK));
if (updated === mirror) {
  console.log("platform limits already in sync");
} else {
  writeFileSync(MIRROR, updated);
  console.log(`synced ${MIRROR} from ${SOURCE}`);
}
