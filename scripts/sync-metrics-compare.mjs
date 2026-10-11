#!/usr/bin/env node
/**
 * Copy the shared region of the period-over-period arithmetic into the
 * browser's mirror.
 *
 * Same argument as the platform limits, and the same mechanism. The totals
 * have lived in one place since migration 38 because a chart saying one thing
 * while the write-up says another is worse than having neither; the change is
 * no different, and a reader comparing a panel's "+25%" to a write-up's
 * "+30%" has no way to know which to believe.
 *
 * metricsCompare.mirror.test.ts is what notices when someone forgets to run
 * this.
 */
import { readFileSync, writeFileSync } from "node:fs";

const MARK = "// ---- shared region: byte-identical with the mirror; a test enforces it ----";
const SOURCE = "agent-runtime/src/agents/reporting/compare-shared.ts";
const MIRROR = "src/lib/metricsCompare.ts";

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
  console.log("metrics comparison already in sync");
} else {
  writeFileSync(MIRROR, updated);
  console.log(`synced ${MIRROR} from ${SOURCE}`);
}
