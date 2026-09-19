// Where to spend a search.
//
// The Proof Finder already knows how to judge evidence — what counts, what is
// marketing dressed as proof, when a same-name business has to be discarded.
// None of that is touched here. What this does is stop it spending searches
// working out WHERE to look, which is the part that costs money and produces
// nothing.
//
// The first production run cost $0.53. Most of that is not the per-search
// charge; it is the tokens of every result page coming back into context. So
// the lever is fewer, better-aimed searches, not a weaker model.
//
// A second run used to cost the same as the first. It was told not to submit
// proof already on file, which stops duplicate ROWS, but nothing stopped it
// searching the same four platforms again to rediscover them.

/** A search budget somebody chose, rather than a library default nobody read. */
export const SEARCH_BUDGET = 8;

/**
 * Where proof actually lives, by sector.
 *
 * Sector-specific because a dentist's evidence is on a professional register
 * and a health directory, and a builder's is on a trade body and a job-review
 * site. Searching "reviews" generically finds the aggregator that lists
 * everybody and proves nothing.
 */
const SECTOR_PLATFORMS: Record<string, string[]> = {
  dentistry: ["Google Business reviews", "the professional dental register", "health directories", "Facebook page reviews"],
  healthcare: ["Google Business reviews", "the professional register for the discipline", "health directories"],
  aesthetics: ["Google Business reviews", "Instagram", "treatment directories"],
  agency: ["Google Business reviews", "Clutch or similar B2B review sites", "LinkedIn", "case studies on their own site"],
  trades: ["Google Business reviews", "trade body membership registers", "job-review sites"],
  hospitality: ["Google Business reviews", "TripAdvisor", "Facebook page reviews"],
};

const DEFAULT_PLATFORMS = [
  "Google Business reviews",
  "Facebook page reviews",
  "the trade or professional register for their sector",
  "directory listings carrying a rating",
];

/** The platforms worth searching, minus the ones a previous run already mined. */
export function platformsToSearch(sector: string | null, alreadyCovered: string[]): string[] {
  const key = (sector ?? "").trim().toLowerCase();
  const all = SECTOR_PLATFORMS[key] ?? DEFAULT_PLATFORMS;
  const covered = alreadyCovered.map((s) => s.toLowerCase());
  const remaining = all.filter(
    (platform) => !covered.some((c) => c.includes(platform.split(" ")[0]!.toLowerCase())),
  );
  // Everything already mined is still worth one look for what is new, but it
  // is not where the budget should go first.
  return remaining.length > 0 ? remaining : all;
}

/**
 * Which platforms a previous run already found something on.
 *
 * Read from the source URLs on file, because that is the only honest record of
 * where the last run actually got to.
 */
export function coveredPlatforms(sources: (string | null)[]): string[] {
  const hosts = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const match = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(source.trim());
    if (match?.[1]) hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
}
