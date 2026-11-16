import { describe, expect, it } from "vitest";
import { isTeamCategory } from "./team";

describe("isTeamCategory", () => {
  it("accepts creative_director along with the other roster categories", () => {
    expect(isTeamCategory("creative_director")).toBe(true);
    expect(isTeamCategory("avatars")).toBe(true);
    expect(isTeamCategory("editors")).toBe(true);
    expect(isTeamCategory("smm")).toBe(true);
  });

  it("rejects team tabs and values that are not a roster category", () => {
    expect(isTeamCategory("chat")).toBe(false);
    expect(isTeamCategory("agents")).toBe(false);
    expect(isTeamCategory("recruitment")).toBe(false);
    expect(isTeamCategory("recruitment-pages")).toBe(false);
    expect(isTeamCategory(undefined)).toBe(false);
    expect(isTeamCategory("")).toBe(false);
  });
});
