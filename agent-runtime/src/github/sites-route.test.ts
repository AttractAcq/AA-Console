import { describe, expect, it } from "vitest";
import { repoNameProblem } from "./sites-route.js";

// The name becomes part of every published URL for the life of the site, and a
// client cannot be asked to live with a typo in it. GitHub would accept more
// than this; we deliberately do not.
describe("repoNameProblem", () => {
  it("accepts the shape a client site uses", () => {
    expect(repoNameProblem("attract-acquisition-site")).toBeNull();
    expect(repoNameProblem("harbour-dental")).toBeNull();
    expect(repoNameProblem("site2")).toBeNull();
  });

  it("refuses anything that would not survive a URL", () => {
    expect(repoNameProblem("Attract Acquisition")).toMatch(/lowercase/i);
    expect(repoNameProblem("site_name")).toMatch(/lowercase/i);
    expect(repoNameProblem("../escape")).toMatch(/lowercase/i);
    expect(repoNameProblem("site.com")).toMatch(/lowercase/i);
  });

  it("refuses names that start or end with a hyphen", () => {
    expect(repoNameProblem("-site")).toMatch(/lowercase/i);
    expect(repoNameProblem("site-")).toMatch(/lowercase/i);
  });

  it("refuses a double hyphen, which reads as a typo in a public URL", () => {
    expect(repoNameProblem("attract--acquisition")).toMatch(/single hyphens/i);
  });

  it("refuses an empty name and an over-long one", () => {
    expect(repoNameProblem("")).toMatch(/required/i);
    expect(repoNameProblem("a".repeat(81))).toMatch(/too long/i);
  });

  it("accepts a single character, which GitHub does", () => {
    expect(repoNameProblem("a")).toBeNull();
  });
});
