import { describe, expect, it } from "vitest";
import { framePlanLines } from "./framePlan";

describe("framePlanLines", () => {
  it("is one entry per typed line", () => {
    expect(framePlanLines("hook\nobjection\nproof")).toEqual(["hook", "objection", "proof"]);
  });

  // The normal way to finish typing four lines is to press return. Counting
  // that as a fifth frame would offer a build the check constraint refuses.
  it("drops the trailing newline rather than counting it as a frame", () => {
    expect(framePlanLines("hook\nobjection\n")).toEqual(["hook", "objection"]);
    expect(framePlanLines("hook\n\n\nobjection\n\n")).toEqual(["hook", "objection"]);
  });

  it("drops whitespace-only lines, which frame_plan_is_usable also refuses", () => {
    expect(framePlanLines("hook\n   \n\t\nproof")).toEqual(["hook", "proof"]);
  });

  it("trims each line the way the RPC does, so the stored text matches", () => {
    expect(framePlanLines("  hook  \n\tproof ")).toEqual(["hook", "proof"]);
  });

  it("is empty for an empty box, which means the agent decides", () => {
    expect(framePlanLines("")).toEqual([]);
    expect(framePlanLines("\n\n  \n")).toEqual([]);
  });
});
