// The AA site shell: what a freshly provisioned repository contains.
//
// A repo is never an empty GitHub Pages site. It starts already knowing how to
// host pages, carry a widget, and hold shared assets — so no repository is ever
// retrofitted later, and the oldest site AA published has the same shape as the
// newest.
//
// Nothing secret goes in here. The repository is public by definition: it is
// served to the internet by GitHub Pages. Prompts, keys, client knowledge and
// credentials stay server-side; the only AA identifier that reaches a repo is a
// deployment's public id, which is an identifier and not a credential.

export interface ShellFile {
  path: string;
  content: string;
}

export interface ShellOptions {
  clientName: string;
  repo: string;
  /** Canonical public runtime host, never the implementation host. */
  runtimeBase: string;
}

/**
 * Disables Jekyll.
 *
 * Branch-based GitHub Pages runs every push through Jekyll by default, which
 * ignores files and directories beginning with an underscore and rewrites some
 * content. Generated pages are raw HTML and must be served byte for byte. The
 * file is empty; its existence is the instruction.
 */
const NOJEKYLL = ".nojekyll";

export function shellFiles(opts: ShellOptions): ShellFile[] {
  const { clientName, repo, runtimeBase } = opts;

  return [
    { path: NOJEKYLL, content: "" },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(clientName)}</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #f8fafc; color: #1f2937 }
  main { max-width: 32rem; padding: 2rem; text-align: center }
  p { color: #6b7280 }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(clientName)}</h1>
  <p>This site is ready. Pages published from AA Console will appear here.</p>
</main>
</body>
</html>
`,
    },
    {
      // Non-secret site identity. Deliberately holds no agent id: a deployment
      // is attached to one page, not to the whole site, so the id lives in that
      // page's own script tag.
      path: "aa/config.json",
      content: `${JSON.stringify(
        {
          managed_by: "AA Console",
          client: clientName,
          repo,
          runtime: runtimeBase.replace(/\/+$/, ""),
          shell_version: 1,
        },
        null,
        2,
      )}\n`,
    },
    { path: "assets/.gitkeep", content: "" },
    {
      path: "README.md",
      content: `# ${clientName} — website

Managed by AA Console. Pages are published here from the Conversion tab; the
sales agent widget is loaded from ${runtimeBase.replace(/\/+$/, "")} and
configured per page.

Do not hand-edit published pages — the next publish overwrites them.

Layout:

- \`index.html\` — homepage
- \`<page-slug>/index.html\` — one directory per published page
- \`assets/\` — shared files
- \`aa/config.json\` — non-secret site identity
- \`.nojekyll\` — keeps GitHub Pages from running generated HTML through Jekyll

Nothing secret belongs in this repository. It is served publicly.
`,
    },
  ];
}

/** The paths the shell owns, which a published page may never take. */
export function shellPaths(): string[] {
  return shellFiles({ clientName: "x", repo: "x", runtimeBase: "https://x" }).map((f) => f.path);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
