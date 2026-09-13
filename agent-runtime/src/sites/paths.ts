// Where a page lands inside a site repository, and how the widget gets onto it.
//
// Pure and tested directly because every function here writes into a public
// website. A wrong path publishes a client's offer at the wrong URL or, worse,
// over the top of another one; a wrong injection ships a page with no agent on
// it, or two.

/** Pages live under the repo root, because GitHub Pages branch publishing only accepts / or /docs. */
export const MAX_SLUG_LENGTH = 60;

/**
 * A page title into a URL segment.
 *
 * Everything that is not a letter, digit or hyphen goes, which is what makes
 * this safe rather than merely tidy: `../../.github/workflows` and
 * `index.html?x=1` both reduce to something that cannot escape its directory
 * or collide with repo machinery.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug;
}

/**
 * The repository path for a page, or null if the request cannot be honoured.
 *
 * Returns a directory with an index.html inside it rather than `slug.html`, so
 * the public URL is `/winter-offer/` — no extension, and a trailing slash that
 * GitHub Pages serves without a redirect.
 *
 * An empty slug is refused rather than defaulted. A page called "???" landing
 * silently at the site root would overwrite the homepage.
 */
export function pagePath(slugOrTitle: string, asHomepage = false): string | null {
  if (asHomepage) return "index.html";
  const slug = slugify(slugOrTitle);
  if (!slug) return null;
  if (RESERVED.has(slug)) return null;
  return `${slug}/index.html`;
}

/**
 * Names a page may not take.
 *
 * `aa` holds the site's own runtime configuration and `assets` holds shared
 * files; a page published over either would break every other page on the site.
 */
const RESERVED = new Set(["aa", "assets", "api", "docs"]);

/** The public URL a path will be served at, given the Pages base. */
export function publicUrl(pagesUrl: string, path: string): string {
  const base = pagesUrl.replace(/\/+$/, "");
  if (path === "index.html") return `${base}/`;
  return `${base}/${path.replace(/\/index\.html$/, "/")}`;
}

/**
 * The one line that puts an agent on a page.
 *
 * Points at the canonical runtime hostname, never at the implementation host,
 * so moving the runtime to its own service later does not strand every page
 * already published.
 */
export function embedSnippet(publicId: string, runtimeBase: string): string {
  const base = runtimeBase.replace(/\/+$/, "");
  return `<script src="${base}/public/sales/v1/widget.js" data-agent="${publicId}" defer></script>`;
}

/** The marker that makes injection idempotent and removal possible. */
const MARKER = "<!-- aa-sales-agent -->";

/**
 * Put the widget on a page, exactly once.
 *
 * Re-publishing a page is the normal case, not the exception, so this has to be
 * idempotent: a second call replaces the existing snippet rather than adding a
 * second one, which would open two chat buttons on one page.
 */
export function injectWidget(html: string, snippet: string): string {
  const block = `${MARKER}\n${snippet}\n`;
  const stripped = removeWidget(html);
  const closing = stripped.search(/<\/body\s*>/i);
  if (closing === -1) {
    // No body to close. Appending is still correct — a browser puts trailing
    // script into the body anyway — and refusing would mean a fragment could
    // never carry an agent.
    return `${stripped}\n${block}`;
  }
  return `${stripped.slice(0, closing)}${block}${stripped.slice(closing)}`;
}

/** Take the widget off a page, leaving the page otherwise untouched. */
export function removeWidget(html: string): string {
  const pattern = new RegExp(
    `\\n?${MARKER}\\s*<script[^>]*data-agent=[^>]*>\\s*</script>\\s*`,
    "gi",
  );
  return html.replace(pattern, "");
}

/** Whether a page already carries an agent. */
export function hasWidget(html: string): boolean {
  return html.includes(MARKER);
}
