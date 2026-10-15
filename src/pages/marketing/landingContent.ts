/**
 * Copy for the public AA landing page.
 *
 * Kept out of the layout file because this is the half that changes: the
 * positioning gets rewritten far more often than the grid it sits in, and
 * a reviewer arguing about a sentence should not have to read JSX to find
 * it. The layout imports these and owns nothing but presentation.
 *
 * Every number shown on the page is either a property of the offer (how
 * many days onboarding takes) or labelled on screen as sample workspace
 * data. Nothing here claims a client result, because no cleared proof has
 * been supplied for this page yet — the same rule the Proof Bank applies
 * to client content applies to our own.
 */

export const POSITIONING =
  "The proof-based content machine for service businesses.";

export const HERO = {
  eyebrow: "Proof-based content for service businesses",
  /** Split so the layout can draw the brand underline under the last part. */
  headlineLead: "Content that can",
  headlineAccent: "prove it.",
  subhead:
    "AA turns the reviews, results and case studies you already have into a content engine — then runs it. Every brief cites real proof, every asset ships on a schedule, and every lead traces back to the post that made it.",
  primaryCta: "Book a proof audit",
  secondaryCta: "See how the machine works",
} as const;

/** The risk-reversal row under the hero buttons. */
export const HERO_ASSURANCES = [
  "Proof cleared before it is used",
  "Published daily, not batched monthly",
  "Attribution down to the post",
] as const;

/**
 * The contrast the whole offer rests on. Stated as a concession first,
 * because a service owner who has already paid an agency for content has
 * heard the promise and not the admission.
 */
export const PREMISE = {
  eyebrow: "Why proof",
  headline: "Most agencies make content. Content is not the asset.",
  body: "Volume is easy to buy and easy to ignore. What moves a stranger toward a service they cannot inspect in advance is evidence: a named review, a before-and-after, a number someone will stand behind. AA is built around that evidence — we file it, clear it, and refuse to publish a claim without it.",
  columns: [
    {
      title: "Claims get a receipt",
      body: "Each proof is filed with its claim, its evidence, where it came from, and whether you have cleared it for advertising. Nothing uncleared reaches a brief.",
    },
    {
      title: "Briefs cite, they do not invent",
      body: "A concept is written against the proof bank. If the evidence for an angle is missing, the brief says so instead of writing around it.",
    },
    {
      title: "The engine keeps running",
      body: "Production, approvals, scheduling and reporting are one system, so a month of content does not depend on anyone remembering to start it.",
    },
  ],
} as const;

/** The pipeline, named the way it is named inside the console. */
export const STEPS = [
  {
    n: "01",
    label: "Intelligence",
    body: "We learn the business before we write for it: market, ideal client, competitors, the words your buyers actually use.",
  },
  {
    n: "02",
    label: "Proof Bank",
    body: "We sweep what you have already published — reviews, ratings, press, case studies — file each with its source, and put it in front of you to clear.",
  },
  {
    n: "03",
    label: "Strategy & briefs",
    body: "Content pillars and offers, then briefs built on cleared proof. Each one names the claim it is making and the evidence behind it.",
  },
  {
    n: "04",
    label: "Production",
    body: "Video, stills, carousels, stories and copy, cut to each platform's limits rather than reposted at the wrong ratio.",
  },
  {
    n: "05",
    label: "Approvals",
    body: "One queue, your decision. Nothing publishes that you have not seen, and a rejection comes back as a re-cut, not an argument.",
  },
  {
    n: "06",
    label: "Distribution",
    body: "Organic and paid run off the same approved assets on a standing schedule, with the engine refilling slots as they empty.",
  },
  {
    n: "07",
    label: "Pages & sales agents",
    body: "Landing and offer pages built to carry the same proof the ads promised, with enquiries answered fast enough to still be warm.",
  },
  {
    n: "08",
    label: "Reporting",
    body: "Organic, paid, pages and attribution in one place, with written commentary on what moved and what we are changing.",
  },
] as const;

/**
 * Sample workspace figures for the console mockup. Labelled as a sample on
 * screen — see the `Sample workspace` chrome in the layout — so the page
 * never reads as a claim about a real account.
 */
export const CONSOLE_SAMPLE = {
  greeting: "Good morning, Alex.",
  summary: "AA filed 23 things overnight.",
  summaryEmphasis: "6 need you.",
  queueLabel: "Needs you",
  queue: [
    { title: "3 proofs awaiting clearance", meta: "Proof Bank · 2 named reviews, 1 result" },
    { title: "4 briefs ready to approve", meta: "Ideation · each cites cleared proof" },
    { title: "1 reel re-cut after a drop in holds", meta: "Media · new hook, same proof" },
  ],
  stats: [
    { value: "31", label: "posts live this month" },
    { value: "17 of 24", label: "proofs cleared for use" },
    { value: "9 min", label: "median enquiry reply" },
  ],
} as const;

/** An example proof record, in the shape the Proof Bank actually files one. */
export const PROOF_EXAMPLE = {
  ref: "HD-0019",
  type: "Named review",
  claim: "Four implants placed in a single visit",
  evidence: "Google review, named patient, March 2026",
  relevance: "Full-arch patients",
  strength: "High",
  rights: "Cleared for use",
} as const;

export const DELIVERABLES = [
  { title: "Proof bank", body: "Built, sourced and kept current, with clearance tracked per item." },
  { title: "Content pillars & offers", body: "A strategy you can read in a page, not a deck nobody opens." },
  { title: "Daily organic publishing", body: "Short-form video, stills, carousels and stories across your platforms." },
  { title: "Paid creative", body: "Ads cut from the same proof, tested as angles rather than guesses." },
  { title: "Landing & offer pages", body: "Pages that carry the proof the ad promised, so the click is not wasted." },
  { title: "Enquiry follow-up", body: "Fast first replies and a tracked pipeline, so leads stop going cold in an inbox." },
  { title: "Approvals in one queue", body: "Your sign-off on everything, in one place, with context attached." },
  { title: "Monthly reporting", body: "Attribution plus written commentary on what we changed and why." },
] as const;

export const AUDIENCES = [
  "Dental & medical practices",
  "Clinics & aesthetics",
  "Legal & financial advice",
  "Trades & home services",
  "Fitness & studios",
  "B2B service firms",
] as const;

/**
 * Objections, answered with the concession first. An FAQ that only says
 * yes is read as sales copy and skipped.
 */
export const FAQ = [
  {
    q: "How fast does this show up?",
    a: "Enquiry follow-up improves in the first week, because it is a process change. Proof-led content compounds instead: expect a visible engine inside 30 days, and expect to be judging cost per booked call around month three, not month one.",
  },
  {
    q: "We do not have many testimonials yet. Is that a problem?",
    a: "It is the first job, not a blocker. Most businesses have more proof than they think — reviews, ratings, directory listings, press, registrations, results sitting in a practice management system. We sweep for it, file what exists, and tell you plainly where the gaps are so you can collect against them.",
  },
  {
    q: "Who clears what we are allowed to say?",
    a: "You do. Each proof is filed with its usage rights and nothing uncleared reaches a brief. If an angle has no cleared evidence behind it, the brief says there is no proof to cite rather than writing the claim anyway.",
  },
  {
    q: "Do we have to replace the tools we already use?",
    a: "No. AA runs alongside your booking, practice management and CRM tools. We need read access to the places proof and enquiries already live; we do not ask you to migrate.",
  },
  {
    q: "Who owns the content and the accounts?",
    a: "You do, including the proof bank, the assets and the pages. Access, consent, retention and integration permissions are written down during onboarding, and your team controls who can reach the workspace.",
  },
  {
    q: "What do you need from us each month?",
    a: "Approvals, and the odd filming window. Everything upstream of the approval queue is our work, and the queue is built so a decision takes minutes rather than a meeting.",
  },
] as const;

/**
 * Privacy policy and terms are deliberately absent: neither page exists
 * yet, and a footer link that lands a visitor on the admin login is worse
 * than no link. Both belong here before this page is pointed at a public
 * domain.
 */
export const FOOTER_LINKS = [
  { label: "Client console", href: "/client/login" },
  { label: "Employee console", href: "/employee/login" },
  { label: "Contact", href: "mailto:hello@attractacq.com" },
] as const;
