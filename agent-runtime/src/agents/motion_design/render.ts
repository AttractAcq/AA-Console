import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const FPS = 24;
export type MotionAspect = "vertical" | "square" | "horizontal";
type LegacyScene = { duration_sec: number; headline: string; body: string;
  motif: "orbit" | "bars" | "cards"; motion: "rise" | "slide" | "pulse" };
export type MotionElement = {
  kind: "text" | "rect" | "circle" | "line";
  x?: number; y?: number; x2?: number; y2?: number;
  from_x?: number; from_y?: number; enter_duration_sec?: number;
  width?: number; height?: number; radius?: number; size?: number;
  text?: string; weight?: number; align?: "start" | "middle" | "end";
  color: string; stroke?: string; stroke_width?: number;
  at_sec: number; enter: "none" | "fade" | "rise" | "slide_left" | "slide_right" | "scale" | "draw" | "move";
  motion?: "still" | "float" | "pulse";
};
export type DesignedScene = { duration_sec: number; background: string; elements: MotionElement[] };
export type MotionScene = LegacyScene | DesignedScene;
export type MotionPlan = { scenes: MotionScene[] };
export type MotionPalette = { background: string; primary: string; accent: string; text: string };

const DIMENSIONS: Record<MotionAspect, { width: number; height: number }> = {
  vertical: { width: 720, height: 1280 }, square: { width: 1080, height: 1080 },
  horizontal: { width: 1280, height: 720 },
};
const DEFAULT: MotionPalette = { background: "#101827", primary: "#243858",
  accent: "#65D6CA", text: "#FFFFFF" };
export async function motionCapability(): Promise<string | null> {
  try {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"], { timeout: 20_000 });
    return /\blibx264\b/.test(stdout) ? null : "This renderer needs FFmpeg with libx264.";
  } catch {
    return "FFmpeg is unavailable for motion design rendering.";
  }
}
function colour(value: string | null | undefined, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : fallback;
}
export function motionPalette(input: Partial<Record<keyof MotionPalette, string | null>>): MotionPalette {
  return { background: colour(input.background, DEFAULT.background),
    primary: colour(input.primary, DEFAULT.primary), accent: colour(input.accent, DEFAULT.accent),
    text: colour(input.text, DEFAULT.text) };
}
function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
export function motionCanvas(aspect: MotionAspect): { width: number; height: number } {
  return aspect === "horizontal" ? { width: 1000, height: 563 }
    : aspect === "vertical" ? { width: 563, height: 1000 } : { width: 1000, height: 1000 };
}
function validColor(value: unknown): value is string {
  return typeof value === "string" &&
    (/^#[0-9a-f]{6}$/i.test(value) || ["background", "primary", "accent", "text", "surface"].includes(value));
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function validateElement(value: unknown, duration: number): asserts value is MotionElement {
  if (!value || typeof value !== "object") throw new Error("A motion element is missing.");
  const e = value as MotionElement;
  if (!["text", "rect", "circle", "line"].includes(e.kind)
    || !validColor(e.color) || !finite(e.at_sec, 0, duration)
    || !["none", "fade", "rise", "slide_left", "slide_right", "scale", "draw", "move"].includes(e.enter)
    || (e.motion !== undefined && !["still", "float", "pulse"].includes(e.motion))
    || (e.stroke !== undefined && !validColor(e.stroke))
    || (e.stroke_width !== undefined && !finite(e.stroke_width, 0, 30))) {
    throw new Error("A motion element has an unsupported colour, timing, or effect.");
  }
  if (!finite(e.x, -100, 1100) || !finite(e.y, -100, 1100)) {
    throw new Error("A motion element needs finite canvas coordinates.");
  }
  if ((e.from_x !== undefined && !finite(e.from_x, -100, 1100))
    || (e.from_y !== undefined && !finite(e.from_y, -100, 1100))
    || (e.enter_duration_sec !== undefined && !finite(e.enter_duration_sec, .1, duration))
    || (e.enter === "move" && (e.kind === "line" || e.from_x === undefined || e.from_y === undefined))) {
    throw new Error("A moving element needs valid starting coordinates and timing.");
  }
  if (e.kind === "text" && (typeof e.text !== "string" || e.text.length < 1 || e.text.length > 100
    || !finite(e.size, 12, 140) || (e.weight !== undefined && !finite(e.weight, 100, 900))
    || (e.align !== undefined && !["start", "middle", "end"].includes(e.align)))) {
    throw new Error("A text element has unsupported copy or typography.");
  }
  if (e.kind === "rect" && (!finite(e.width, 1, 1200) || !finite(e.height, 1, 1200)
    || (e.radius !== undefined && !finite(e.radius, 0, 200)))) {
    throw new Error("A rectangle needs valid dimensions.");
  }
  if (e.kind === "circle" && !finite(e.radius, 1, 800)) {
    throw new Error("A circle needs a valid radius.");
  }
  if (e.kind === "line" && (!finite(e.x2, -100, 1100) || !finite(e.y2, -100, 1100)
    || e.enter === "scale")) {
    throw new Error("A line needs valid endpoints.");
  }
  if (e.enter === "draw" && e.kind !== "line") throw new Error("Draw is only supported for lines.");
}
function lines(value: string, maxChars: number): string[] {
  const out: string[] = []; let line = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (`${line} ${word}`.trim().length > maxChars && line) { out.push(line); line = word; }
    else line = `${line} ${word}`.trim();
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}
export function validateMotionPlan(raw: unknown, targetSeconds: number, preset: string): MotionPlan {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as MotionPlan).scenes)) {
    throw new Error("Claude did not return motion scenes.");
  }
  const scenes = (raw as MotionPlan).scenes;
  if (scenes.length < 1 || scenes.length > 5 || (preset === "hero" && scenes.length !== 1)) {
    throw new Error("The motion plan has an invalid scene count.");
  }
  let total = 0;
  for (const scene of scenes) {
    if (!Number.isFinite(scene.duration_sec) || scene.duration_sec < 1 || scene.duration_sec > 12) {
      throw new Error("A motion scene has unsupported text, timing, or effects.");
    }
    if ("elements" in scene) {
      if (!validColor(scene.background) || !Array.isArray(scene.elements)
        || scene.elements.length < 1 || scene.elements.length > 40) {
        throw new Error("A designed scene needs a background and 1 to 40 elements.");
      }
      for (const element of scene.elements) validateElement(element, scene.duration_sec);
    } else if (typeof scene.headline !== "string" || scene.headline.length > 80
      || typeof scene.body !== "string" || scene.body.length > 180
      || !["orbit", "bars", "cards"].includes(scene.motif)
      || !["rise", "slide", "pulse"].includes(scene.motion)) {
      throw new Error("A motion scene has unsupported text, timing, or effects.");
    }
    total += scene.duration_sec;
  }
  if (total > targetSeconds + 0.1 || total < targetSeconds - 1.5) {
    throw new Error("The motion plan duration does not match the requested video length.");
  }
  if (preset === "hero" && scenes[0] && !("elements" in scenes[0]) && scenes[0].motion !== "pulse") {
    throw new Error("A looping hero needs a pulse scene.");
  }
  return { scenes };
}

export function motionFrame(scene: MotionScene, progress: number, aspect: MotionAspect,
  palette: MotionPalette, size = DIMENSIONS[aspect]): string {
  if ("elements" in scene) return designedFrame(scene, progress, aspect, palette, size);
  const { width: w, height: h } = size;
  const short = Math.min(w, h);
  const phase = Math.sin(Math.PI * 2 * progress);
  const arrival = Math.min(1, progress * 5);
  const opacity = scene.motion === "pulse" ? 0.86 + 0.14 * Math.cos(Math.PI * 2 * progress)
    : arrival;
  const dy = scene.motion === "rise" ? (1 - arrival) * h * 0.13 : 0;
  const dx = scene.motion === "slide" ? (1 - arrival) * w * 0.18 : 0;
  const motif = scene.motif === "orbit"
    ? `<circle cx="${w * .72}" cy="${h * .26}" r="${short * (.17 + .018 * phase)}" fill="none" stroke="${palette.accent}" stroke-width="${short * .018}" opacity=".55"/>
       <circle cx="${w * .72}" cy="${h * .26}" r="${short * .085}" fill="${palette.accent}" opacity=".8"/>`
    : scene.motif === "bars"
      ? Array.from({ length: 5 }, (_, i) => `<rect x="${w * (.48 + i * .09)}" y="${h * (.18 + i * .025)}" width="${w * .05}" height="${h * (.13 + .035 * i + .01 * phase)}" rx="${short * .018}" fill="${palette.accent}" opacity="${.45 + i * .1}"/>`).join("")
      : Array.from({ length: 3 }, (_, i) => `<rect x="${w * (.52 + i * .07)}" y="${h * (.17 + i * .055)}" width="${w * .28}" height="${h * .14}" rx="${short * .025}" fill="${i % 2 ? palette.primary : palette.accent}" opacity="${.45 + .12 * i}"/>`).join("");
  const textX = w * .085 + dx;
  const headingSize = Math.round(short * .072);
  const bodySize = Math.round(short * .034);
  const headLines = lines(scene.headline, aspect === "horizontal" ? 32 : 20);
  const bodyLines = lines(scene.body, aspect === "horizontal" ? 60 : 32);
  const baseline = h * (aspect === "horizontal" ? .49 : .56) + dy;
  const text = headLines.map((line, i) => `<text x="${textX}" y="${baseline + i * headingSize * 1.18}" font-size="${headingSize}" font-weight="700" fill="${palette.text}">${xml(line)}</text>`).join("")
    + bodyLines.map((line, i) => `<text x="${textX}" y="${baseline + headLines.length * headingSize * 1.18 + bodySize * (i + 1.4)}" font-size="${bodySize}" fill="${palette.text}" opacity=".82">${xml(line)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${palette.background}"/>
    <circle cx="${w * .76}" cy="${h * .23}" r="${short * .42}" fill="${palette.primary}" opacity=".52"/>
    ${motif}<g opacity="${opacity}" font-family="DejaVu Sans, sans-serif">${text}</g>
    <rect x="${w * .085}" y="${h * .11}" width="${short * .11}" height="${short * .012}" rx="5" fill="${palette.accent}"/>
  </svg>`;
}

function resolveColor(value: string, palette: MotionPalette): string {
  if (value === "surface") return "#FFFFFF";
  if (value in palette) return palette[value as keyof MotionPalette];
  return value;
}
function designedFrame(scene: DesignedScene, progress: number, aspect: MotionAspect,
  palette: MotionPalette, size: { width: number; height: number }): string {
  const canvas = motionCanvas(aspect);
  const t = Math.max(0, Math.min(1, progress)) * scene.duration_sec;
  const parts = scene.elements.map((e) => {
    const elapsed = t - e.at_sec;
    if (elapsed < 0) return "";
    const arrival = Math.min(1, elapsed / (e.enter_duration_sec ?? .45));
    const eased = 1 - (1 - arrival) ** 3;
    const opacity = e.enter === "none" || e.enter === "draw" || e.enter === "move" ? 1 : eased;
    const loop = Math.sin(2 * Math.PI * progress);
    const dx = e.enter === "move" ? (e.from_x! - e.x!) * (1 - eased)
      : e.enter === "slide_left" ? (1 - eased) * 48
      : e.enter === "slide_right" ? -(1 - eased) * 48 : 0;
    const dy = e.enter === "move" ? (e.from_y! - e.y!) * (1 - eased)
      : e.enter === "rise" ? (1 - eased) * 36
      : e.motion === "float" ? loop * 6 : 0;
    const scale = e.enter === "scale" ? .84 + .16 * eased
      : e.motion === "pulse" ? 1 + .025 * loop : 1;
    const cx = e.kind === "rect" ? e.x! + e.width! / 2 : e.x!;
    const cy = e.kind === "rect" ? e.y! + e.height! / 2 : e.y!;
    const transform = `translate(${dx} ${dy}) translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`;
    const fill = resolveColor(e.color, palette);
    let shape = "";
    if (e.kind === "text") shape = `<text x="${e.x}" y="${e.y}" font-size="${e.size}" font-weight="${e.weight ?? 600}"
      text-anchor="${e.align ?? "start"}" fill="${fill}" font-family="DejaVu Sans, sans-serif">${xml(e.text!)}</text>`;
    if (e.kind === "rect") shape = `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}"
      rx="${e.radius ?? 0}" fill="${fill}"${e.stroke ? ` stroke="${resolveColor(e.stroke, palette)}" stroke-width="${e.stroke_width ?? 1}"` : ""}/>`;
    if (e.kind === "circle") shape = `<circle cx="${e.x}" cy="${e.y}" r="${e.radius}" fill="${fill}"/>`;
    if (e.kind === "line") {
      const length = Math.hypot(e.x2! - e.x!, e.y2! - e.y!);
      const draw = e.enter === "draw" ? ` stroke-dasharray="${length}" stroke-dashoffset="${length * (1 - eased)}"` : "";
      shape = `<line x1="${e.x}" y1="${e.y}" x2="${e.x2}" y2="${e.y2}"
        stroke="${fill}" stroke-width="${e.stroke_width ?? 4}" stroke-linecap="round"${draw}/>`;
    }
    return `<g opacity="${opacity}" transform="${transform}">${shape}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"
    viewBox="0 0 ${canvas.width} ${canvas.height}"><rect width="100%" height="100%"
    fill="${resolveColor(scene.background, palette)}"/>${parts}</svg>`;
}

/** Render finite, validated SVG frames; no model-authored code reaches FFmpeg. */
export async function renderMotion(plan: MotionPlan, options: { aspect: MotionAspect;
  palette: MotionPalette; workDir: string; outputPath: string; posterPath: string;
  testSize?: { width: number; height: number } }): Promise<{ durationSec: number; width: number; height: number }> {
  const size = options.testSize ?? DIMENSIONS[options.aspect];
  const framesDir = join(options.workDir, "frames");
  await mkdir(framesDir, { recursive: true });
  let index = 0;
  for (const scene of plan.scenes) {
    const count = Math.round(scene.duration_sec * FPS);
    for (let i = 0; i < count; i++) {
      const svg = motionFrame(scene, i / count, options.aspect, options.palette, size);
      await sharp(Buffer.from(svg)).png().toFile(join(framesDir, `${String(index).padStart(5, "0")}.png`));
      index++;
    }
  }
  if (index === 0) throw new Error("The motion plan rendered no frames.");
  // A designed opening often deliberately starts empty. Pick a representative
  // frame after the first scene has established its composition for the poster.
  const posterIndex = Math.min(index - 1,
    Math.floor(Math.round(plan.scenes[0]!.duration_sec * FPS) * .65));
  const posterFrame = await readFile(join(framesDir, `${String(posterIndex).padStart(5, "0")}.png`));
  await sharp(posterFrame).jpeg({ quality: 88 }).toFile(options.posterPath);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS),
    "-i", join(framesDir, "%05d.png"), "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", options.outputPath],
  { timeout: 6 * 60_000, maxBuffer: 1024 * 1024 });
  return { durationSec: index / FPS, width: size.width, height: size.height };
}
