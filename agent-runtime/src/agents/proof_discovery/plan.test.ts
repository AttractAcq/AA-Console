import { describe, expect, it } from "vitest";
import { coveredPlatforms, platformsToSearch, SEARCH_BUDGET } from "./plan.js";

describe("the search budget", () => {
  it("is a number somebody chose, not the library default", () => {
    // runAgentLoop defaults to 12 and nobody had picked it. Most of a run's
    // cost is result tokens re-entering context, so this is the lever.
    expect(SEARCH_BUDGET).toBeLessThan(12);
    expect(SEARCH_BUDGET).toBeGreaterThan(4);
  });
});

describe("where proof actually lives", () => {
  it("aims a dentist at registers and health directories", () => {
    const platforms = platformsToSearch("dentistry", []);
    expect(platforms.join(" ")).toMatch(/register/i);
    expect(platforms.join(" ")).toMatch(/Google Business/i);
  });

  it("aims an agency somewhere different from a dentist", () => {
    // A dentist's evidence is on a professional register; an agency's is on
    // B2B review sites. Searching "reviews" generically finds the aggregator
    // that lists everybody and proves nothing.
    const dentist = platformsToSearch("dentistry", []).join(" ");
    const agency = platformsToSearch("agency", []).join(" ");
    expect(agency).not.toBe(dentist);
    expect(agency).toMatch(/Clutch|LinkedIn|case stud/i);
  });

  it("falls back to somewhere sensible for a sector it does not know", () => {
    const platforms = platformsToSearch("llama grooming", []);
    expect(platforms.length).toBeGreaterThan(0);
    expect(platforms.join(" ")).toMatch(/Google Business/i);
  });

  it("is case and whitespace insensitive about the sector", () => {
    expect(platformsToSearch("  Dentistry  ", [])).toEqual(platformsToSearch("dentistry", []));
  });
});

// A second run used to cost the same as the first: it was told not to submit
// proof already on file, which stops duplicate rows, but nothing stopped it
// searching the same platforms again to rediscover them.
describe("not paying twice for the same platform", () => {
  it("drops a platform a previous run already mined", () => {
    const covered = coveredPlatforms(["https://www.google.com/maps/place/x"]);
    const platforms = platformsToSearch("dentistry", covered);
    expect(platforms.join(" ")).not.toMatch(/Google Business/i);
    expect(platforms.length).toBeGreaterThan(0);
  });

  it("still offers everything when a run covered all of them", () => {
    // Exhausting the list must not leave the agent with nowhere to look.
    const all = platformsToSearch("dentistry", []);
    const covered = all.map((p) => `https://${p.split(" ")[0]!.toLowerCase()}.example.com/x`);
    expect(platformsToSearch("dentistry", covered)).toEqual(all);
  });
});

describe("reading where the last run got to", () => {
  it("takes the host from each filed source", () => {
    expect(
      coveredPlatforms([
        "https://www.google.com/maps/place/x",
        "https://facebook.com/somepage",
        "https://www.google.com/maps/place/y",
      ]).sort(),
    ).toEqual(["facebook.com", "google.com"]);
  });

  it("ignores rows with no usable source", () => {
    // Proof added by hand often has no URL at all.
    expect(coveredPlatforms([null, "", "not a url", "  "])).toEqual([]);
  });
});
