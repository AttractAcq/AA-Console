import { describe, expect, it } from "vitest";
import {
  carriedFrameDestination,
  frameRemakeBrief,
  frameRemakeFromParams,
  frameRemakeProblem,
  framesToCarry,
  remadeSet,
} from "./frameRemake.js";
import type { StoredFrame } from "./frames.js";

const set = (n: number): StoredFrame[] =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    storage_path: `c1/generated/r1/0${i + 1}.png`,
    caption: `frame ${i + 1}`,
  }));

describe("frameRemakeFromParams", () => {
  it("reads a remake off the job", () => {
    expect(frameRemakeFromParams({ render_id: "r", source_asset_id: "a1", frame_position: 3 })).toEqual({
      sourceAssetId: "a1",
      position: 3,
    });
  });

  it("is null for an ordinary build", () => {
    expect(frameRemakeFromParams({ render_id: "r" })).toBeNull();
  });

  // A position with no asset is not a remake of anything, and treating it as
  // one would rebuild a set from frames that were never loaded.
  it("is null when either half is missing", () => {
    expect(frameRemakeFromParams({ frame_position: 3 })).toBeNull();
    expect(frameRemakeFromParams({ source_asset_id: "a1" })).toBeNull();
  });

  it("is null for a position that is not a frame number", () => {
    expect(frameRemakeFromParams({ source_asset_id: "a1", frame_position: 0 })).toBeNull();
    expect(frameRemakeFromParams({ source_asset_id: "a1", frame_position: -2 })).toBeNull();
    expect(frameRemakeFromParams({ source_asset_id: "a1", frame_position: "3" })).toBeNull();
  });
});

describe("frameRemakeProblem", () => {
  it("accepts a frame that exists", () => {
    expect(frameRemakeProblem(set(5), 3)).toBeNull();
  });

  it("refuses a frame the set does not have", () => {
    expect(frameRemakeProblem(set(5), 6)).toBe("This set runs 1 to 5; there is no frame 6.");
  });

  it("refuses an asset that is not a set", () => {
    expect(frameRemakeProblem(set(1), 1)).toContain("no set to rebuild part of");
    expect(frameRemakeProblem([], 1)).toContain("no set to rebuild part of");
  });
});

describe("framesToCarry", () => {
  // The entire point: four storage copies instead of four image calls.
  it("is every frame but the one being replaced", () => {
    expect(framesToCarry(set(5), 3).map((f) => f.position)).toEqual([1, 2, 4, 5]);
  });

  it("carries everything when the position is not in the set", () => {
    expect(framesToCarry(set(3), 9)).toHaveLength(3);
  });
});

describe("remadeSet", () => {
  const replacement: StoredFrame = {
    position: 3,
    storage_path: "c1/generated/r2/03.png",
    caption: "new",
  };

  it("puts the replacement back in its own slot", () => {
    const out = remadeSet(framesToCarry(set(5), 3), replacement);
    expect(out.map((f) => f.position)).toEqual([1, 2, 3, 4, 5]);
    expect(out[2]).toEqual(replacement);
  });

  // A set filed in whatever order the rows came back reads as a shuffled
  // argument, and nothing downstream re-sorts it.
  it("runs in order even when the carried frames arrive shuffled", () => {
    const shuffled = [set(5)[4]!, set(5)[0]!, set(5)[3]!, set(5)[1]!];
    expect(remadeSet(shuffled, replacement).map((f) => f.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never leaves two frames in one slot", () => {
    const out = remadeSet(set(5), replacement);
    expect(out.filter((f) => f.position === 3)).toEqual([replacement]);
    expect(out).toHaveLength(5);
  });
});

describe("carriedFrameDestination", () => {
  const pathFor = (position: number, extension: string) =>
    `c1/generated/r2/${String(position).padStart(2, "0")}.${extension}`;

  // A copy that renames .jpg to .png produces a file whose bytes and name
  // disagree, and storage will serve it with the wrong content type.
  it("keeps the extension of the file it copies", () => {
    expect(carriedFrameDestination("c1/generated/r1/02.jpg", pathFor, 2)).toBe(
      "c1/generated/r2/02.jpg",
    );
    expect(carriedFrameDestination("c1/generated/r1/02.webp", pathFor, 2)).toBe(
      "c1/generated/r2/02.webp",
    );
  });

  it("falls back to png when the path carries no extension", () => {
    expect(carriedFrameDestination("c1/generated/r1/02", pathFor, 2)).toBe("c1/generated/r2/02.png");
  });
});

describe("frameRemakeBrief", () => {
  const siblings = [
    { position: 1, purpose: "earn the swipe", headline: "Stop overpaying" },
    { position: 2, purpose: "name the objection", headline: "" },
    { position: 3, purpose: "the one being replaced", headline: "Old" },
  ];

  it("lists the frames that are staying, so the replacement does not repeat one", () => {
    const text = frameRemakeBrief(3, 3, siblings, "the photo is too dark");
    expect(text).toContain("Frame 1: earn the swipe");
    expect(text).toContain("Frame 2: name the objection");
    expect(text).toContain("the photo is too dark");
  });

  it("leaves the frame being replaced out of the list of what is staying", () => {
    const text = frameRemakeBrief(3, 3, siblings, "x");
    expect(text).not.toContain("Frame 3: the one being replaced");
  });

  it("says which frame and how many, so the model places it", () => {
    const text = frameRemakeBrief(2, 5, siblings, "x");
    expect(text).toContain("5-frame set");
    expect(text).toContain("Rewrite frame 2 only");
  });

  it("still reads as an instruction when the set carries no descriptions", () => {
    expect(frameRemakeBrief(1, 2, [], "x")).toContain("carries no description");
  });
});
