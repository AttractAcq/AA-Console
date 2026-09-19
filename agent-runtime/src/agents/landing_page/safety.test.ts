import { describe, expect, it } from "vitest";
import { recruitmentPageProblem } from "./safety.js";


// The hiring ADS read as advertising for AA's services until creative_build
// was told which job it had. The page agent had the same blind spot: handed
// the offer strategy and the ICP, it writes a conversion page aimed at the
// businesses AA sells to.
describe("a hiring page has to read as one", () => {
  const page = (body: string) =>
    // Padded past MIN_USABLE_LENGTH, which every page must clear regardless.
    `<!doctype html><html><head><title>x</title></head><body>${body}${"<p>Filler paragraph for length.</p>".repeat(40)}</body></html>`;

  it("accepts a page that says so in the headline", () => {
    expect(
      recruitmentPageProblem(
        "We're hiring an editor",
        page("<h1>We're hiring an editor</h1><p>Vertical cutdowns, Durban hours.</p>"),
      ),
    ).toBeNull();
  });

  it("accepts the other ways a job page announces itself", () => {
    for (const opening of [
      "<h1>This role, in short</h1>",
      "<h1>Now hiring: social media manager</h1>",
      "<h1>Join the team</h1>",
      "<h1>Apply to be our on-camera avatar</h1>",
    ]) {
      expect(recruitmentPageProblem("x", page(opening)), opening).toBeNull();
    }
  });

  it("rejects a page that never says a job is open", () => {
    // What the agent produces when nobody tells it which job it has.
    expect(
      recruitmentPageProblem(
        "Turn what your business knows into qualified demand",
        page("<h1>Turn what your business knows into qualified demand</h1><p>Campaigns and content.</p>"),
      ),
    ).toMatch(/says a job is open/i);
  });

  it("rejects a page that buries it below the fold", () => {
    // Somebody who just clicked a job advert looks at the top of the page.
    // Far enough down to be past the first screen — at 300 short paragraphs
    // the line still landed inside the window, which is the bug this guards.
    const buried = page(
      `<h1>Marketing that works</h1>${"<p>Filler paragraph for length.</p>".repeat(200)}<p>We're hiring.</p>`,
    );
    expect(recruitmentPageProblem("Marketing that works", buried)).toMatch(/only mentions the job further down/i);
  });

  it("still applies every safety rule a page has", () => {
    // Recruitment does not get a relaxed version of the rules.
    expect(
      recruitmentPageProblem("We're hiring", page("<script>alert(1)</script><h1>We're hiring</h1>")),
    ).toMatch(/script/i);
    expect(recruitmentPageProblem("", page("<h1>We're hiring</h1>"))).toMatch(/no headline/i);
  });
});
