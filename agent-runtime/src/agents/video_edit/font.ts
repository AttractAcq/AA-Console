import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The font drawtext burns captions with.
 *
 * Resolved from the dejavu-fonts-ttf package rather than an OS path. The
 * render tests used to skip on `existsSync("/usr/share/fonts/truetype/dejavu/
 * DejaVuSans-Bold.ttf")`, a Debian layout that exists on neither macOS nor
 * the Alpine image this runs in — so they skipped everywhere, silently, and
 * the render path went untested on every machine that has ever run them.
 *
 * VIDEO_EDIT_FONT still overrides it, for a brand that licenses its own face.
 */
export function fontSource(): string {
  const override = process.env.VIDEO_EDIT_FONT?.trim();
  if (override) return override;
  return createRequire(import.meta.url).resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
}

/**
 * Put the font where the filtergraph can name it, and return that path.
 *
 * ffmpeg's drawtext takes `fontfile=` inside a filtergraph, where a space or
 * a colon in the path changes what the filter means. buildRenderPlan refuses
 * such a path rather than emit one — correctly — but the resolved package
 * path is wherever the checkout happens to live, and this one is under
 * "/Users/alex/Projects/AA Console": a space, and an immediate refusal.
 *
 * So the font is copied into the work directory, which is a mkdtemp path the
 * render already controls and already validates, under a name chosen here.
 * The guard keeps its teeth and the render stops depending on where the
 * repository was cloned.
 */
export async function installFont(workDir: string): Promise<string> {
  const destination = join(workDir, "caption.ttf");
  await copyFile(fontSource(), destination);
  return destination;
}
