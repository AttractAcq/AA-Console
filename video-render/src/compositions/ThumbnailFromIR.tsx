import { Stage } from "../components/primitives/Stage.js";
import { Component as ThumbnailCard } from "../components/explain/ThumbnailCard.js";
import { buildThemeFromSnapshot } from "../brand/theme.js";
import { parseIR } from "../ir/schema.js";

/** A fixed 16:9 cover built from the reviewed IR title and frozen project
 * brand. The published MP4 aspect may differ; the preview remains 1280×720.
 */
export function ThumbnailFromIR({ ir, brandSnapshot }: {
  ir: unknown; brandSnapshot: unknown;
}) {
  const parsed = parseIR(ir);
  const theme = buildThemeFromSnapshot(brandSnapshot);
  return <Stage aspect="16:9" theme={theme}>
    <ThumbnailCard hook={parsed.title} />
  </Stage>;
}
