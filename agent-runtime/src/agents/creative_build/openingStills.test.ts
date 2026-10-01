import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";
import { ZOOM_IN_MOTION_ID } from "../video_build/motions.js";
import { runCreativeBuildJob } from "./index.js";
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
      expect(route.frameAsk.plan).toEqual(["Name the mechanism", "Show the step"]);
      expect(route.frameAsk.count).toBe(2);
      expect(route.frameAsk.plan?.join(" ")).not.toContain("{");
    }
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
