import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Edl } from "./edl.js";
import { probeDurationSec, render } from "./media.js";
import { buildRenderPlan, RenderPlanError, wrapText } from "./render.js";

const edl: Edl = {
  segments: [
    { shot: 2, in_sec: 1, out_sec: 3, transition: "cut" },
    { shot: 1, in_sec: 0, out_sec: 2, transition: "crossfade" },
    { shot: 2, in_sec: 0, out_sec: 1.5, transition: "cut" },
  ],
  captions: [{ text: "Here's the fix: 100% of it", start_sec: 0.2, end_sec: 2, position: "bottom" }],
  end_card_text: "Book a call",
  end_card_sec: 1.5,
  notes: "",
};

const options = {
  clipPaths: new Map([
    [1, "/clips/shot-1.mp4"],
    [2, "/clips/shot-2.mp4"],
  ]),
  outputPath: "/out/reel.mp4",
  fontFile: "/fonts/Bold.ttf",
  workDir: "/work/",
};

function filterOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1]!;
}

describe("wrapText", () => {
  it("breaks on words and never splits one", () => {
    expect(wrapText("Most gyms lose 30% of members by March", 22)).toBe("Most gyms lose 30% of\nmembers by March");
    expect(wrapText("supercalifragilistic expialidocious", 10)).toBe("supercalifragilistic\nexpialidocious");
  });
});

describe("buildRenderPlan", () => {
  it("trims each segment at its input", () => {
    const { args } = buildRenderPlan(edl, options);
    expect(args.slice(4, 10)).toEqual(["-ss", "1", "-t", "2", "-i", "/clips/shot-2.mp4"]);
  });

  it("chains a crossfade at the right offset, then a cut", () => {
    const filter = filterOf(buildRenderPlan(edl, options).args);
    // First segment is 2s long, so a 0.4s fade starts at 1.6s.
    expect(filter).toContain("[s0][s1]xfade=transition=fade:duration=0.4:offset=1.6[j1]");
    expect(filter).toContain("[j1][s2]concat=n=2:v=1:a=0[j2]");
  });

  it("keeps caption text out of the filtergraph", () => {
    const plan = buildRenderPlan(edl, options);
    expect(filterOf(plan.args)).not.toContain("Here's");
    expect(filterOf(plan.args)).toContain("textfile=/work/caption-1.txt:expansion=none");
    expect(plan.textFiles).toEqual([
      { path: "/work/caption-1.txt", content: "Here's the fix: 100%\nof it" },
      { path: "/work/end-card.txt", content: "Book a call" },
    ]);
  });

  it("appends a brand-coloured end card and times its text after the cut", () => {
    const plan = buildRenderPlan(edl, { ...options, backgroundColour: "#1A2B3C", textColour: "nonsense" });
    expect(plan.args).toContain("color=c=0x1a2b3c:s=1080x1920:r=30");
    expect(filterOf(plan.args)).toContain("fontcolor=0xffffff");
    expect(filterOf(plan.args)).toContain("enable='between(t,5.1,6.6)'");
    expect(plan.durationSec).toBeCloseTo(6.6);
  });

  it("renders silent without music and mixes it in with", () => {
    expect(buildRenderPlan(edl, options).args).toContain("-an");
    const withMusic = buildRenderPlan(edl, { ...options, musicPath: "/m.m4a" });
    expect(withMusic.args).not.toContain("-an");
    expect(filterOf(withMusic.args)).toContain("[4:a]atrim=0:6.6,asetpts=PTS-STARTPTS,afade=t=out:st=5.6:d=1[aout]");
  });

  it("refuses a font or work path that the filtergraph would misread", () => {
    expect(() => buildRenderPlan(edl, { ...options, fontFile: "/fonts/My Font.ttf" })).toThrow(RenderPlanError);
    expect(() => buildRenderPlan(edl, { ...options, workDir: "/work:x" })).toThrow(RenderPlanError);
  });

  it("refuses a shot with no clip file", () => {
    expect(() => buildRenderPlan(edl, { ...options, clipPaths: new Map([[1, "/a.mp4"]]) })).toThrow(
      "Shot 2 has no clip file.",
    );
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Runs where ffmpeg and DejaVu are installed. CI runners may not have them.
describe.skipIf(!hasFfmpeg() || !existsSync(FONT))("render with ffmpeg", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("produces a 1080x1920 reel as long as the plan says", async () => {
    dir = await mkdtemp(join(tmpdir(), "video-edit-test-"));
    for (const shot of [1, 2]) {
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "testsrc2=s=360x640:r=24:d=3", "-pix_fmt", "yuv420p", join(dir, `shot-${shot}.mp4`),
      ]);
    }
    const output = join(dir, "reel.mp4");
    const plan = buildRenderPlan(edl, {
      clipPaths: new Map([
        [1, join(dir, "shot-1.mp4")],
        [2, join(dir, "shot-2.mp4")],
      ]),
      outputPath: output,
      fontFile: FONT,
      workDir: dir,
    });
    await render(plan);
    expect(await probeDurationSec(output)).toBeCloseTo(plan.durationSec, 1);
    const size = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", output,
    ]).toString().trim();
    expect(size).toBe("1080,1920");
  }, 60_000);
});
