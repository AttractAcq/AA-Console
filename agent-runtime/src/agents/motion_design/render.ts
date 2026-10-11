import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const FPS = 24;
export type MotionAspect = "vertical" | "square" | "horizontal";
export type MotionScene = { duration_sec: number; headline: string; body: string;
  motif: "orbit" | "bars" | "cards"; motion: "rise" | "slide" | "pulse" };
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
    if (!Number.isFinite(scene.duration_sec) || scene.duration_sec < 1 || scene.duration_sec > 12
      || typeof scene.headline !== "string" || scene.headline.length > 80
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
  if (preset === "hero" && scenes[0]?.motion !== "pulse") {
    throw new Error("A looping hero needs a pulse scene.");
  }
  return { scenes };
}

export function motionFrame(scene: MotionScene, progress: number, aspect: MotionAspect,
  palette: MotionPalette, size = DIMENSIONS[aspect]): string {
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
  const first = await readFile(join(framesDir, "00000.png"));
  await sharp(first).jpeg({ quality: 88 }).toFile(options.posterPath);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS),
    "-i", join(framesDir, "%05d.png"), "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", options.outputPath],
  { timeout: 6 * 60_000, maxBuffer: 1024 * 1024 });
  return { durationSec: index / FPS, width: size.width, height: size.height };
}
