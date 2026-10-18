import { describe, expect, it } from "vitest";
import { resolveMotionPreset, ZOOM_IN_MOTION_ID, type MotionCatalogEntry } from "./motions.js";

const dolly: MotionCatalogEntry = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  name: "Dolly In",
  description: null,
  preview_url: null,
  start_end_frame: false,
};

describe("resolveMotionPreset", () => {
  it("maps pending and Zoom In onto the Cockpit catalog id", () => {
    expect(resolveMotionPreset("pending")).toEqual({ ok: true, id: ZOOM_IN_MOTION_ID, via: "phase1_default" });
    expect(resolveMotionPreset("  Pending  ")).toMatchObject({ ok: true, id: ZOOM_IN_MOTION_ID, via: "phase1_default" });
    expect(resolveMotionPreset("Zoom In")).toEqual({ ok: true, id: ZOOM_IN_MOTION_ID, via: "sot_name" });
    expect(resolveMotionPreset("zoom_in")).toMatchObject({ ok: true, id: ZOOM_IN_MOTION_ID, via: "sot_name" });
    expect(resolveMotionPreset(ZOOM_IN_MOTION_ID.toUpperCase())).toEqual({
      ok: true,
      id: ZOOM_IN_MOTION_ID,
      via: "sot_id",
    });
  });

  it("does not invent an id for any other preset", () => {
    expect(resolveMotionPreset("Orbit")).toEqual({ ok: false, preset: "Orbit" });
    expect(resolveMotionPreset("11111111-1111-4111-8111-111111111111")).toEqual({
      ok: false,
      preset: "11111111-1111-4111-8111-111111111111",
    });
    expect(resolveMotionPreset("   ")).toEqual({ ok: false, preset: "" });
  });

  it("accepts another preset only when the supplied catalog lists it", () => {
    expect(resolveMotionPreset("Dolly In", [dolly])).toEqual({ ok: true, id: dolly.id, via: "catalog" });
    expect(resolveMotionPreset(dolly.id.toUpperCase(), [dolly])).toMatchObject({ ok: true, id: dolly.id, via: "catalog" });
    expect(resolveMotionPreset("Orbit", [dolly])).toEqual({ ok: false, preset: "Orbit" });
    const conflicting: MotionCatalogEntry = { ...dolly, name: "Zoom In" };
    expect(resolveMotionPreset("Zoom In", [conflicting])).toMatchObject({
      ok: true,
      id: ZOOM_IN_MOTION_ID,
      via: "sot_name",
    });
  });
});
