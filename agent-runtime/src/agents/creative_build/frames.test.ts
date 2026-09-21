import { describe, expect, it } from "vitest";
import {
  MAX_FRAMES,
  MIN_FRAMES,
  NO_FRAME_ASK,
  buildRoute,
  frameAskInstruction,
  framePath,
  framePlanProblem,
  framesConceptProblem,
  framesToRender,
  normaliseFrames,
  positionFromPath,
  renderFrames,
  requiredFrameCount,
  type FrameConcept,
} from "./frames.js";

const frame = (position: number, over: Partial<FrameConcept> = {}): FrameConcept => ({
  position,
  purpose: "Earns the swipe",
  headline: "H",
  subhead: "S",
  call_to_action: "",
  subject: "A dentist at a chair",
  background: "The practice, morning light",
  visual_treatment: "photographic",
  composition: "Centre",
  art_direction: "Warm",
  avoid: "Stock handshake",
  ...over,
});

const plan = (n: number) => Array.from({ length: n }, (_, i) => frame(i + 1));

describe("where a frame lives", () => {
  // Derived, not random: a retry can only skip what it can find.
  it("derives the path from the render and the position", () => {
    expect(framePath("c1", "r1", 1, "png")).toBe("c1/generated/r1/01.png");
    expect(framePath("c1", "r1", 10, "png")).toBe("c1/generated/r1/10.png");
  });

  it("pads so ten frames sort after two", () => {
    const paths = [2, 10].map((p) => framePath("c1", "r1", p, "png"));
    expect([...paths].sort()).toEqual(paths);
  });

  it("reads the position back out of a path", () => {
    expect(positionFromPath("c1/generated/r1/03.png")).toBe(3);
    expect(positionFromPath("c1/generated/r1/10.webp")).toBe(10);
  });

  it("returns nothing for a path that is not a frame", () => {
    expect(positionFromPath("c1/generated/r1.png")).toBeNull();
    expect(positionFromPath("c1/generated/r1/cover.png")).toBeNull();
    expect(positionFromPath("")).toBeNull();
  });
});

describe("what a retry still has to pay for", () => {
  it("renders everything on a first run", () => {
    expect(framesToRender(plan(5), new Set()).map((f) => f.position)).toEqual([1, 2, 3, 4, 5]);
  });

  // The whole point: a 429 on frame four must not re-buy frames one to three.
  it("skips the frames already in storage", () => {
    expect(framesToRender(plan(5), new Set([1, 2, 3])).map((f) => f.position)).toEqual([4, 5]);
  });

  it("does nothing when every frame is already there", () => {
    expect(framesToRender(plan(3), new Set([1, 2, 3]))).toEqual([]);
  });

  it("fills a hole in the middle rather than appending", () => {
    expect(framesToRender(plan(4), new Set([1, 2, 4])).map((f) => f.position)).toEqual([3]);
  });
});

describe("framePlanProblem", () => {
  it("accepts a plan that can be built", () => {
    expect(framePlanProblem(plan(MIN_FRAMES))).toBeNull();
    expect(framePlanProblem(plan(5))).toBeNull();
    expect(framePlanProblem(plan(MAX_FRAMES))).toBeNull();
  });

  it("refuses too few and too many", () => {
    expect(framePlanProblem(plan(1))).toContain(`at least ${MIN_FRAMES}`);
    expect(framePlanProblem(plan(MAX_FRAMES + 1))).toContain(`${MAX_FRAMES} frames is the limit`);
  });

  it("refuses two frames claiming one position", () => {
    expect(framePlanProblem([frame(1), frame(1)])).toContain("both claim position 1");
  });

  // A gap means the frames would run in an order nobody chose.
  it("refuses a gap in the order", () => {
    expect(framePlanProblem([frame(1), frame(3)])).toContain("Frame 2 is missing");
  });

  it("refuses a position that is not a position", () => {
    expect(framePlanProblem([frame(0), frame(1)])).toContain("start at 1");
    expect(framePlanProblem([frame(Number.NaN), frame(1)])).toContain("start at 1");
  });

  it("refuses a frame with nothing in it", () => {
    expect(framePlanProblem([frame(1, { subject: "" }), frame(2)])).toContain("no subject");
    expect(framePlanProblem([frame(1, { background: "" }), frame(2)])).toContain("no background");
    expect(framePlanProblem([frame(1, { purpose: "" }), frame(2)])).toContain("what job it does");
  });
});

describe("normaliseFrames", () => {
  it("returns nothing for anything that is not a list", () => {
    expect(normaliseFrames(null)).toEqual([]);
    expect(normaliseFrames({})).toEqual([]);
  });

  it("puts them in order whatever order they arrived in", () => {
    const out = normaliseFrames([
      { position: 3, subject: "c" },
      { position: 1, subject: "a" },
      { position: 2, subject: "b" },
    ]);
    expect(out.map((f) => f.position)).toEqual([1, 2, 3]);
    expect(out.map((f) => f.subject)).toEqual(["a", "b", "c"]);
  });

  it("trims, so a frame of spaces reads as empty to the check", () => {
    const [f] = normaliseFrames([{ position: 1, subject: "   ", purpose: " x " }]);
    expect(f!.subject).toBe("");
    expect(f!.purpose).toBe("x");
  });

  it("keeps a non-numeric position so the check can refuse it by name", () => {
    const [f] = normaliseFrames([{ position: "two", subject: "a" }]);
    expect(Number.isNaN(f!.position)).toBe(true);
  });
});

describe("renderFrames", () => {
  const rendered = { bytes: Buffer.from("x"), contentType: "image/png", extension: "png" };

  function harness(over: Record<string, unknown> = {}) {
    const calls: number[] = [];
    const stored: number[] = [];
    const notes: string[] = [];
    return {
      calls,
      stored,
      notes,
      opts: {
        planned: plan(4),
        done: new Set<number>(),
        renderOne: async (f: FrameConcept) => {
          calls.push(f.position);
          return rendered;
        },
        store: async (f: FrameConcept) => {
          stored.push(f.position);
          return framePath("c1", "r1", f.position, "png");
        },
        pathFor: (f: FrameConcept) => framePath("c1", "r1", f.position, "png"),
        onProgress: (n: string) => notes.push(n),
        sleep: async () => {},
        ...over,
      },
    };
  }

  it("renders every frame in order on a first run", async () => {
    const h = harness();
    const out = await renderFrames(h.opts as never);
    expect(h.calls).toEqual([1, 2, 3, 4]);
    expect(out.map((f) => f.position)).toEqual([1, 2, 3, 4]);
  });

  // The failure this whole design exists for.
  it("pays only for the frames that are missing", async () => {
    const h = harness({ done: new Set([1, 2, 3]) });
    await renderFrames(h.opts as never);
    expect(h.calls).toEqual([4]);
    expect(h.notes[0]).toContain("3 of 4 frames already rendered");
  });

  it("renders nothing when a retry finds them all", async () => {
    const h = harness({ done: new Set([1, 2, 3, 4]) });
    const out = await renderFrames(h.opts as never);
    expect(h.calls).toEqual([]);
    expect(out).toHaveLength(4);
  });

  it("still returns every frame's path, including the ones it skipped", async () => {
    const h = harness({ done: new Set([1, 2]) });
    const out = await renderFrames(h.opts as never);
    expect(out.map((f) => f.storage_path)).toEqual([
      "c1/generated/r1/01.png",
      "c1/generated/r1/02.png",
      "c1/generated/r1/03.png",
      "c1/generated/r1/04.png",
    ]);
  });

  it("leaves the frames it finished on disk when a later one fails", async () => {
    const h = harness({
      renderOne: async (f: FrameConcept) => {
        if (f.position === 3) throw new Error("429");
        return rendered;
      },
    });
    (h.opts as { store: (f: FrameConcept) => Promise<string> }).store = async (f) => {
      h.stored.push(f.position);
      return framePath("c1", "r1", f.position, "png");
    };
    await expect(renderFrames(h.opts as never)).rejects.toThrow("429");
    expect(h.stored).toEqual([1, 2]);
  });

  it("waits between frames but not after the last", async () => {
    const waits: number[] = [];
    const h = harness({ sleep: async (ms: number) => void waits.push(ms) });
    await renderFrames(h.opts as never);
    expect(waits).toHaveLength(3);
  });
});

describe("buildRoute", () => {
  it("sends a plain image brief to the single-image route", () => {
    expect(buildRoute("image", "single")).toBe("image");
  });

  it("sends a carousel and a story to the frame route", () => {
    expect(buildRoute("image", "carousel")).toBe("frames");
    expect(buildRoute("image", "story")).toBe("frames");
  });

  // Text has no frames, whatever a brief claims its format is.
  it("keeps text on the text route regardless of format", () => {
    expect(buildRoute("text", "single")).toBe("text");
    expect(buildRoute("text", "carousel")).toBe("text");
  });
});

describe("framesConceptProblem", () => {
  const never = () => null;
  const always = () => "contains no imagery";

  it("accepts a set where every frame passes", () => {
    expect(framesConceptProblem(plan(3), never)).toBeNull();
  });

  it("reports a bad plan before looking at any frame", () => {
    let looked = false;
    expect(
      framesConceptProblem(plan(1), () => {
        looked = true;
        return null;
      }),
    ).toContain(`at least ${MIN_FRAMES}`);
    expect(looked).toBe(false);
  });

  // Finding this once the whole set is paid for is five times as expensive.
  it("names the frame that failed the image check", () => {
    expect(framesConceptProblem(plan(3), always)).toBe("Frame 1: contains no imagery");
  });

  it("checks every frame, not only the first", () => {
    const seen: number[] = [];
    framesConceptProblem(plan(4), (c) => {
      seen.push(Number((c as { position: number }).position));
      return null;
    });
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

describe("what the brief asks of the set", () => {
  const frames = (n: number): FrameConcept[] =>
    Array.from({ length: n }, (_, i) => ({
      position: i + 1,
      purpose: `job ${i + 1}`,
      headline: "h",
      subhead: "s",
      call_to_action: "",
      subject: "a dentist at a chair",
      background: "a surgery with window light",
      visual_treatment: "photographic",
      composition: "centred",
      art_direction: "warm",
      avoid: "stock cliche",
    }));

  describe("requiredFrameCount", () => {
    it("is null when the brief asks for nothing, as every brief before 113 does", () => {
      expect(requiredFrameCount(NO_FRAME_ASK)).toBeNull();
    });

    it("is the count when only a count is given", () => {
      expect(requiredFrameCount({ count: 5, plan: null })).toBe(5);
    });

    // The database refuses a count and a plan that disagree, so this only
    // has to pick a side for the halves that can legally arrive together.
    it("is the plan's length, which is the count when both are set", () => {
      expect(requiredFrameCount({ count: null, plan: ["a", "b", "c"] })).toBe(3);
      expect(requiredFrameCount({ count: 3, plan: ["a", "b", "c"] })).toBe(3);
    });

    it("ignores a count that asks for nothing", () => {
      expect(requiredFrameCount({ count: 0, plan: null })).toBeNull();
      expect(requiredFrameCount({ count: null, plan: [] })).toBeNull();
    });
  });

  describe("frameAskInstruction", () => {
    it("leaves the choice open when the brief made none", () => {
      const text = frameAskInstruction(NO_FRAME_ASK);
      expect(text).toContain("Choose how many");
      expect(text).toContain(String(MIN_FRAMES));
      expect(text).toContain(String(MAX_FRAMES));
    });

    it("names the exact count when the brief set one", () => {
      expect(frameAskInstruction({ count: 5, plan: null })).toContain("exactly 5 frames");
    });

    // An instruction the model cannot follow line by line is one it
    // approximates — the pillar brief made exactly this mistake.
    it("lists the plan frame by frame rather than summarising it", () => {
      const text = frameAskInstruction({ count: null, plan: ["hook", "the objection", "proof"] });
      expect(text).toContain("Frame 1: hook");
      expect(text).toContain("Frame 2: the objection");
      expect(text).toContain("Frame 3: proof");
      expect(text).toContain("exactly 3 frames");
    });
  });

  describe("framePlanProblem against the brief's count", () => {
    it("accepts a set that matches what was asked for", () => {
      expect(framePlanProblem(frames(5), 5)).toBeNull();
    });

    // Four frames for a five-frame brief is not a smaller carousel, it is a
    // dropped beat of an argument somebody wrote down.
    it("refuses a set short of what the brief asked for", () => {
      expect(framePlanProblem(frames(4), 5)).toBe("The brief asks for 5 frames; this set has 4.");
    });

    it("refuses a set longer than what the brief asked for", () => {
      expect(framePlanProblem(frames(6), 5)).toBe("The brief asks for 5 frames; this set has 6.");
    });

    it("still applies the floor and ceiling when the brief asked for nothing", () => {
      expect(framePlanProblem(frames(1), null)).toContain("at least");
      expect(framePlanProblem(frames(11), null)).toContain("limit");
      expect(framePlanProblem(frames(4), null)).toBeNull();
    });
  });

  describe("framesConceptProblem", () => {
    it("carries the brief's count through to the plan check", () => {
      expect(framesConceptProblem(frames(3), () => null, 5)).toBe(
        "The brief asks for 5 frames; this set has 3.",
      );
    });

    it("still checks each frame is renderable", () => {
      expect(
        framesConceptProblem(frames(3), (c) => (c.headline === "h" ? "no good" : null), 3),
      ).toBe("Frame 1: no good");
    });
  });
});
