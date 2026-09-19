// What may never appear in a generated page, whoever generated it.
//
// This was inline in the landing page agent, which was fine while one code path
// produced pages. It no longer is: the Page Reviser produces pages too, and a
// second copy of these rules would drift from this one the first time either
// was touched. A revision path that is weaker than the generation path is the
// same bug as having no checks at all, arriving later and harder to see.
//
// The console renders these pages in a sandboxed frame, and Phase 10 pushes
// them to GitHub Pages where they are served to the public with no sandbox at
// all. So this is not belt-and-braces around the sandbox — after publishing,
// it is the only thing standing between model output and a visitor's browser.

/** A page shorter than this has not been written, whatever it contains. */
const MIN_USABLE_LENGTH = 800;

/**
 * Why this HTML may not be stored or published, or null if it may.
 *
 * Applies to every path that writes client_pages.html. Take nothing out of here
 * without taking it out of the published-page threat model first.
 */
export function htmlSafetyProblem(html: string): string | null {
  if (html.length < MIN_USABLE_LENGTH) {
    return "The page came back too thin to be usable.";
  }
  if (/<script\b/i.test(html)) {
    return "The page came back containing a <script>, which is not allowed on a generated page.";
  }
  // An inline handler is script by another name, and would run in any context
  // that ever renders this without a sandbox — an email, a deploy, a preview
  // written later by someone who did not read this file, or GitHub Pages.
  if (/\son[a-z]+\s*=/i.test(html)) {
    return "The page came back with an inline event handler, which is script by another name.";
  }
  if (/<iframe\b/i.test(html)) {
    return "The page came back containing an iframe, which is not allowed on a generated page.";
  }
  return null;
}

/**
 * The generation path's check: everything above, plus a headline.
 *
 * A revision is not required to restate a headline it is not changing, which is
 * why that rule lives here rather than in htmlSafetyProblem.
 */
export function pageProblem(headline: string, html: string): string | null {
  if (!headline) return "The page came back with no headline.";
  return htmlSafetyProblem(html);
}


/**
 * Whether a hiring page reads as one.
 *
 * The same check the hiring ADS needed: a page that never says a job is open
 * is a page somebody clicked a job advert to reach and then could not place.
 * Read against the rendered text, because that is all a visitor sees.
 *
 * Deliberately generous about HOW it says it — "we're hiring", "this role",
 * "apply" in a heading — and strict only that it says it somewhere near the
 * top. A hiring page that buries the fact in a footer has the same problem.
 */
const HIRING_SIGNAL =
  /\b(hiring|we'?re hiring|now hiring|recruiting|vacancy|vacancies|this role|the role|join (?:the|our) team|apply (?:now|for|to))\b/i;

/** Roughly the first screen: enough to judge what the page announces itself as. */
const FIRST_SCREEN = 2500;

export function recruitmentPageProblem(headline: string, html: string): string | null {
  const safety = pageProblem(headline, html);
  if (safety) return safety;

  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (!HIRING_SIGNAL.test(text)) {
    return "Nothing on this page says a job is open. A visitor arriving from a hiring ad has to be able to tell within a screen that this is a job advert.";
  }
  if (!HIRING_SIGNAL.test(`${headline} ${text.slice(0, FIRST_SCREEN)}`)) {
    return "The page only mentions the job further down. Say it in the headline or the opening, where somebody who just clicked an ad will look.";
  }
  return null;
}
