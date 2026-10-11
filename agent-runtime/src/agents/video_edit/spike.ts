/**
 * Local spike: cut a reel from clips on disk. Not imported by the worker.
 *
 *   npx tsx src/agents/video_edit/spike.ts --brief reel.json --out reel.mp4 \
 *     --font /path/DejaVuSans-Bold.ttf [--edl plan.json | --model claude-opus-5-5] \
 *     [--effort high] [--music track.m4a] [--fps 1] [--width 384]
 *
 * reel.json:
 *   { "title": "...", "brief_text": "...", "max_total_sec": 30,
 *     "banned_phrases": ["..."], "background_colour": "#101820", "text_colour": "#ffffff",
 *     "shots": [{ "shot": 1, "beat": "...", "file": "clips/shot-1.mp4" }] }
 *
 * --edl renders a hand-written plan and spends nothing. --model asks Claude
 * (needs ANTHROPIC_API_KEY), allows one revise if validation fails, and
 * prints tokens and cost. The plan used is written next to the output.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseEdl, totalDuration, validateEdl, type Edl, type EdlContext } from "./edl.js";
import { probeDurationSec, render, sampleFrames } from "./media.js";
import { planEdit, type PlanClip } from "./plan.js";
import { buildRenderPlan } from "./render.js";

interface ReelFile {
  title: string;
  brief_text: string;
  max_total_sec: number;
  banned_phrases?: string[];
  background_colour?: string;
  text_colour?: string;
  shots: Array<{ shot: number; beat: string; file: string; shot_source_kind?: string; caption?: string }>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      brief: { type: "string" },
      out: { type: "string" },
      font: { type: "string" },
      edl: { type: "string" },
      model: { type: "string" },
      effort: { type: "string", default: "high" },
      music: { type: "string" },
      fps: { type: "string", default: "1" },
      width: { type: "string", default: "384" },
    },
  });
  if (!values.brief || !values.out || !values.font || (!values.edl && !values.model)) {
    throw new Error("Needs --brief, --out, --font and one of --edl or --model.");
  }

  const briefPath = resolve(values.brief);
  const reel = JSON.parse(await readFile(briefPath, "utf8")) as ReelFile;
  const base = dirname(briefPath);
  const shots = await Promise.all(
    reel.shots.map(async (shot) => {
      const file = resolve(base, shot.file);
      return { ...shot, file, duration_sec: await probeDurationSec(file), kind: shot.shot_source_kind ?? "ai_generated" };
    }),
  );

  const context: EdlContext = {
    clips: shots.map((s) => ({
      shot: s.shot,
      duration_sec: s.duration_sec,
      shot_source_kind: s.kind,
      burned_in_text: s.caption ?? "",
    })),
    max_total_sec: reel.max_total_sec,
    brief_text: reel.brief_text,
    banned_phrases: reel.banned_phrases ?? [],
  };

  const work = await mkdtemp(join(tmpdir(), "video-edit-"));
  let edl: Edl;
  if (values.edl) {
    const parsed = parseEdl(JSON.parse(await readFile(resolve(values.edl), "utf8")));
    if (!parsed.ok) throw new Error(parsed.problem);
    edl = parsed.edl;
  } else {
    // These default to what agents/video_edit/index.ts actually samples at
    // (SAMPLE_FPS, SAMPLE_WIDTH). A spike that samples differently prices a
    // different job, which is how the 1 October cost estimate went wrong.
    const fps = Number.parseFloat(values.fps ?? "1");
    const width = Number.parseInt(values.width ?? "384", 10);
    const clips: PlanClip[] = [];
    for (const shot of shots) {
      clips.push({
        shot: shot.shot,
        beat: shot.beat,
        duration_sec: shot.duration_sec,
        shot_source_kind: shot.kind,
        burnedInText: shot.caption ?? "",
        frames: await sampleFrames(shot.file, join(work, `frames-${shot.shot}`), { fps, width }),
      });
    }
    const input = {
      title: reel.title,
      briefText: reel.brief_text,
      maxTotalSec: reel.max_total_sec,
      bannedPhrases: reel.banned_phrases ?? [],
      clips,
    };
    const effort = values.effort as "low" | "medium" | "high" | "xhigh" | "max";
    const started = Date.now();
    let result = await planEdit(input, { model: values.model!, effort });
    let cost = result.usage.costUsd;
    let tokens = { input: result.usage.inputTokens, output: result.usage.outputTokens };
    const firstProblems = validateEdl(result.edl, context);
    if (firstProblems.length > 0) {
      console.log(`First plan had ${firstProblems.length} problem(s). Revising once.`);
      result = await planEdit({ ...input, revise: { edl: result.edl, problems: firstProblems } }, { model: values.model!, effort });
      cost += result.usage.costUsd;
      tokens = { input: tokens.input + result.usage.inputTokens, output: tokens.output + result.usage.outputTokens };
    }
    console.log(
      `${result.model}: ${tokens.input} in / ${tokens.output} out, $${cost.toFixed(4)}, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s, ${clips.reduce((n, c) => n + c.frames.length, 0)} frames`,
    );
    edl = result.edl;
  }

  await writeFile(`${values.out}.plan.json`, JSON.stringify(edl, null, 2));
  const problems = validateEdl(edl, context);
  if (problems.length > 0) {
    console.log("Not rendered. The plan has problems:");
    for (const problem of problems) console.log(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  const plan = buildRenderPlan(edl, {
    clipPaths: new Map(shots.map((s) => [s.shot, s.file])),
    outputPath: resolve(values.out),
    fontFile: resolve(values.font),
    workDir: work,
    musicPath: values.music ? resolve(values.music) : null,
    backgroundColour: reel.background_colour,
    textColour: reel.text_colour,
  });
  await render(plan);
  console.log(`Rendered ${totalDuration(edl).toFixed(1)}s to ${values.out}`);
  if (edl.notes) console.log(`Notes: ${edl.notes}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
