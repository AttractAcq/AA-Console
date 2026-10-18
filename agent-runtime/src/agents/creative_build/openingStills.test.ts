import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";
import { ZOOM_IN_MOTION_ID } from "../video_build/motions.js";
import { framesConceptTool, reelKeyframePrompt, runCreativeBuildJob } from "./index.js";
import { openingStillsRoute, withOpeningShotFields } from "./openingStills.js";

function line(beat: string): string {
  return serializeShot({
    beat,
    duration_sec: 3,
    shot_source_kind: "ai_generated",
    motion_preset: MOTION_PRESET_PLACEHOLDER,
  });
}

const plan = [line("Name the mechanism"), line("Show the step")];

it("writes a filmed keyframe prompt without carrying concept headlines into the pixels", () => {
  const prompt = reelKeyframePrompt({
    position: 1,
    purpose: "Show the offer being diagnosed",
    subject: "A founder sorting real customer notes",
    background: "A sunlit workshop desk",
    visual_treatment: "photorealistic",
    composition: "Medium shot with depth",
    art_direction: "Natural morning light",
    headline: "BUY TRAFFIC NOW",
    call_to_action: "BOOK A CALL",
  }, 3, "Example Client", null, "Middle-aged Black workshop owner with closely cropped hair and navy work shirt");
  expect(prompt).toContain("A founder sorting real customer notes");
  expect(prompt).toContain("Middle-aged Black workshop owner with closely cropped hair");
  expect(prompt).toContain("No text, typography");
  expect(prompt).not.toContain("BUY TRAFFIC NOW");
  expect(prompt).not.toContain("BOOK A CALL");
});

it("uses the first reel shot as a visual identity reference while allowing a new action", () => {
  const prompt = reelKeyframePrompt({
    position: 2,
    purpose: "Show the founder reviewing a lead",
    subject: "The same founder at the desk",
    background: "The same workshop",
  }, 3, "Example Client", null, "Founder in a navy shirt", true);
  expect(prompt).toContain("attached first-shot image is the visual identity reference");
  expect(prompt).toContain("keep their face, age, hair");
  expect(prompt).toContain("do not add a person to an object-only sequence");
});

it("requires a stable cast anchor only for reel concepts", () => {
  const reel = framesConceptTool("reel").inputSchema;
  const carousel = framesConceptTool("carousel").inputSchema;
  expect(reel.required).toContain("cast_anchor");
  expect(carousel.required).not.toContain("cast_anchor");
});

describe("openingStillsRoute", () => {
  it("leaves a carousel, a story and a single on the standard route", () => {
    expect(openingStillsRoute({ media_type: "image", content_format: "carousel", format_code: null }, "image").kind).toBe(
      "standard",
    );
    expect(openingStillsRoute({ media_type: "image", content_format: "story", format_code: null }, "image").kind).toBe(
      "standard",
    );
    expect(openingStillsRoute({ media_type: "image", content_format: "single", format_code: null }, "image").kind).toBe(
      "standard",
    );
    expect(openingStillsRoute({ media_type: "text", content_format: "single", format_code: null }, "text").kind).toBe(
      "standard",
    );
  });

  it("refuses a video story and a later-phase reel", () => {
    expect(
      openingStillsRoute({ media_type: "video", content_format: "story", format_code: null }, "image"),
    ).toMatchObject({ kind: "refuse" });
    const later = openingStillsRoute(
      { media_type: "video", content_format: "reel", format_code: "F5" },
      "image",
    );
    expect(later.kind).toBe("refuse");
    if (later.kind !== "refuse") return;
    expect(later.message).toMatch(/F6 or F7/);
  });

  it("refuses a Phase 1 reel whose generation is not an image", () => {
    const route = openingStillsRoute(
      { media_type: "video", content_format: "reel", format_code: "F6", frame_plan: plan },
      "text",
    );
    expect(route.kind).toBe("refuse");
  });

  it("plans one opening still per shot for F6, F7 and an untagged reel", () => {
    for (const format_code of ["F6", "F7", null]) {
      const route = openingStillsRoute(
        { media_type: "video", content_format: "reel", format_code, frame_plan: plan },
        "image",
      );
      expect(route.kind).toBe("stills");
      if (route.kind !== "stills") continue;
      expect(route.frameAsk.plan).toEqual([
        "Opening frame before this action: Name the mechanism",
        "Opening frame before this action: Show the step",
      ]);
      expect(route.frameAsk.count).toBe(2);
      expect(route.frameAsk.plan?.join(" ")).not.toContain("{");
    }
  });

  it("directs the image model to draw the pre-action state from the shot plan", () => {
    const beat = "The sheet slides out of shadow and settles in the lit area.";
    const openingState = "The sheet is partly visible at the dark left edge; the lit area is empty.";
    const route = openingStillsRoute({
      media_type: "video", content_format: "reel", format_code: "F7",
      frame_plan: [serializeShot({ beat, opening_state: openingState, duration_sec: 3,
        shot_source_kind: "ai_generated", motion_preset: MOTION_PRESET_PLACEHOLDER }), line("Payoff")],
    }, "image");
    if (route.kind !== "stills") throw new Error("expected stills");
    expect(route.shots[0]?.opening_state).toBe(openingState);
    expect(route.frameAsk.plan?.[0]).toContain(openingState);
    const prompt = reelKeyframePrompt({ position: 1 }, 2, "Example Client", null, "", false, route.shots[0]);
    expect(prompt).toContain(`Exact frame-zero state to draw: ${openingState}`);
    expect(prompt).toContain(`Action that will happen AFTER this still: ${beat}`);
    expect(prompt).toContain("Do not add a hand, rig, lamp");
  });

  it("copies shot columns onto the filed frames", () => {
    const route = openingStillsRoute(
      { media_type: "video", content_format: "reel", format_code: "F7", frame_plan: plan },
      "image",
    );
    if (route.kind !== "stills") throw new Error("expected stills");
    const filed = withOpeningShotFields(
      [
        { position: 1, storage_path: "a/1.png", caption: null },
        { position: 2, storage_path: "a/2.png", caption: "step" },
      ],
      route.shots,
    );
    expect(filed[0]).toMatchObject({
      beat: "Name the mechanism",
      duration_sec: 3,
      motion_preset: ZOOM_IN_MOTION_ID,
      shot_source_kind: "ai_generated",
    });
    expect(filed[1]?.caption).toBe("step");
  });
});

function creativeHarness(brief: Record<string, unknown>, generationMedia = "image") {
  const sb = {
    from(table: string) {
      const row = {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "creative_renders") {
                return {
                  data: {
                    id: "render-1",
                    generation_id: "gen-1",
                    quality: "medium",
                    size: "1024x1536",
                    reference_path: null,
                  },
                  error: null,
                };
              }
              if (table === "creative_generations") {
                return {
                  data: {
                    id: "gen-1",
                    brief_id: "brief-1",
                    media_type: generationMedia,
                    quality: "medium",
                    size: "1024x1536",
                    concept: null,
                    stage: "concept",
                    reference_path: null,
                    remake_feedback: null,
                  },
                  error: null,
                };
              }
              if (table === "client_briefs") return { data: brief, error: null };
              throw new Error(`unexpected read ${table}`);
            },
          }),
        }),
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
      return row;
    },
  };
  return sb as unknown as SupabaseClient;
}

const job: AgentJobRow = {
  id: "job-1",
  agent_key: "creative_build",
  client_id: "client-1",
  input_table: "creative_renders",
  input_id: "render-1",
  params: { render_id: "render-1", opening_stills: true },
  status: "running",
  attempts: 1,
  max_attempts: 3,
  lease_owner: "worker",
  lease_until: null,
};

const agent = { agent_key: "creative_build", name: "Creative Build" } as AgentRow;
const runtime = {} as RuntimeConfig;

describe("creative_build reel stills gate", () => {
  it("still refuses a video story", async () => {
    const result = await runCreativeBuildJob(
      creativeHarness({
        id: "brief-1",
        client_id: "client-1",
        title: "A story",
        body: "Say it.",
        media_type: "video",
        brief_ref: null,
        purpose: "client",
        recruitment_role: null,
        content_format: "story",
        format_code: null,
        frame_count: null,
        frame_plan: null,
      }),
      runtime,
      agent,
      job,
      Date.now() + 10_000,
    );
    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/produced by people/);
  });

  it("treats an F6 reel image generation as an image build, not as a video refusal", async () => {
    const result = await runCreativeBuildJob(
      creativeHarness({
        id: "brief-1",
        client_id: "client-1",
        title: "How it works",
        body: "Explain the mechanism.",
        media_type: "video",
        brief_ref: null,
        purpose: "client",
        recruitment_role: null,
        content_format: "reel",
        format_code: "F6",
        frame_count: 2,
        frame_plan: plan,
      }),
      runtime,
      agent,
      job,
      Date.now() + 10_000,
    );
    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/No image renderer is configured/);
    expect(result.failureMessage).not.toMatch(/produced by people/);
  });

  it("still sends a carousel image brief down the image route", async () => {
    const result = await runCreativeBuildJob(
      creativeHarness({
        id: "brief-1",
        client_id: "client-1",
        title: "Five reasons",
        body: "List them.",
        media_type: "image",
        brief_ref: null,
        purpose: "client",
        recruitment_role: null,
        content_format: "carousel",
        format_code: null,
        frame_count: null,
        frame_plan: ["hook", "proof"],
      }),
      runtime,
      agent,
      { ...job, params: { render_id: "render-1" } },
      Date.now() + 10_000,
    );
    expect(result.failureMessage).toMatch(/No image renderer is configured/);
    expect(result.failureMessage).not.toMatch(/opening still/i);
  });
});
