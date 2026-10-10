/** FFmpeg plan for a single supplied video. Every selected span keeps its audio. */
import { CAPTION_LINE_CHARS, LINE_SPACING, OUTPUT_FPS, wrapLines } from "../video_edit/render.js";
import { segmentsDuration, type Edl } from "../video_edit/edl.js";
import type { RenderPlan } from "../video_edit/render.js";

export type Aspect = "vertical" | "square" | "horizontal";
export const DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  horizontal: { width: 1920, height: 1080 },
};

export interface SourceRenderOptions {
  sourcePath: string;
  outputPath: string;
  workDir: string;
  fontFile: string;
  aspect: Aspect;
  hasAudio: boolean;
  animatedTitle?: string | null;
  textColour?: string | null;
}

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;
function safePath(path: string): string {
  if (!SAFE_PATH.test(path) || path.includes("..")) throw new Error("Unsafe media path.");
  return path;
}
const sec = (value: number) => (Math.round(value * 1000) / 1000).toString();

export function buildSourceRenderPlan(edl: Edl, options: SourceRenderOptions): RenderPlan {
  if (edl.segments.length === 0) throw new Error("The source edit has no selected footage.");
  if (edl.segments.some((segment) => segment.shot !== 1 || segment.transition !== "cut")) {
    throw new Error("Source footage supports cuts from one video, not shot joins or crossfades.");
  }
  if (edl.end_card_text) throw new Error("An end card is not supported on a source edit.");
  const { width, height } = DIMENSIONS[options.aspect];
  const font = safePath(options.fontFile);
  const dir = safePath(options.workDir.replace(/\/+$/, ""));
  const textColour = /^#?[0-9a-f]{6}$/i.test(options.textColour ?? "")
    ? `0x${options.textColour!.replace(/^#/, "")}` : "white";
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const filters: string[] = [];
  const textFiles: RenderPlan["textFiles"] = [];
  edl.segments.forEach((segment, index) => {
    const length = segment.out_sec - segment.in_sec;
    if (segment.in_sec < 0 || length < 0.5) throw new Error("A source cut has an invalid time range.");
    args.push("-ss", sec(segment.in_sec), "-t", sec(length), "-i", options.sourcePath);
    filters.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${OUTPUT_FPS},format=yuv420p,` +
      `setpts=PTS-STARTPTS[v${index}]`);
    if (options.hasAudio) {
      filters.push(`[${index}:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a${index}]`);
    }
  });
  const inputs = edl.segments.map((_, i) => `[v${i}]${options.hasAudio ? `[a${i}]` : ""}`).join("");
  filters.push(`${inputs}concat=n=${edl.segments.length}:v=1:a=${options.hasAudio ? 1 : 0}` +
    `[joined]${options.hasAudio ? "[audio]" : ""}`);

  const overlays: string[] = [];
  if (options.animatedTitle?.trim()) {
    const file = `${dir}/source-title.txt`;
    textFiles.push({ path: file, content: options.animatedTitle.trim().slice(0, 80) });
    overlays.push(`drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=64:` +
      `fontcolor=${textColour}:box=1:boxcolor=black@0.55:boxborderw=20:` +
      `x=(w-text_w)/2:y=h*0.12+max(0\\,(0.5-t)*h*0.2):enable='between(t,0,3)'`);
  }
  edl.captions.forEach((caption, i) => {
    const lines = wrapLines(caption.text, CAPTION_LINE_CHARS);
    lines.forEach((line, j) => {
      const file = `${dir}/source-caption-${i + 1}-${j + 1}.txt`;
      textFiles.push({ path: file, content: line });
      overlays.push(`drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=64:` +
        `fontcolor=${textColour}:borderw=5:bordercolor=black@0.85:x=(w-text_w)/2:` +
        `y=h*0.70+${j * (64 + LINE_SPACING)}:` +
        `enable='between(t,${sec(caption.start_sec)},${sec(caption.end_sec)})'`);
    });
  });
  filters.push(`[joined]${overlays.length ? overlays.join(",") : "null"}[video]`);
  const durationSec = segmentsDuration(edl.segments);
  args.push("-filter_complex", filters.join(";"), "-map", "[video]");
  if (options.hasAudio) args.push("-map", "[audio]", "-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-r", String(OUTPUT_FPS), "-movflags", "+faststart", "-t", sec(durationSec), options.outputPath);
  return { args, textFiles, durationSec };
}
