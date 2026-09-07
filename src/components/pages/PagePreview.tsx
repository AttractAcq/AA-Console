import { useState } from "react";
import { Code2, ExternalLink, Monitor, Smartphone } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * A generated page: what it looks like, what it is made of, and where it lives.
 *
 * The preview is a sandboxed iframe with `srcDoc` and **no** allow-same-origin
 * and **no** allow-scripts. That combination matters more than it looks. This
 * console holds an admin session against every client's data, and the HTML
 * here was written by a model. Rendering it into the console document — or
 * into a frame that could reach back into it — would turn a bad generation
 * into a route to that session. The agent is told never to emit script and the
 * runtime rejects a page that does; this is the third line, and the only one
 * that holds if the other two are wrong.
 */
type View = "preview" | "code";

export function PagePreview({
  html,
  publishedUrl,
  builtAt,
  title,
}: {
  html: string | null;
  publishedUrl: string | null;
  builtAt: string | null;
  title: string;
}) {
  const [view, setView] = useState<View>("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");

  if (!html) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Not built yet. Build Page gathers this client's context, offer, brand, identity and
          cleared proof, and hands the lot to the page agent.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border">
          {(["preview", "code"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === v
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {v === "preview" ? (
                <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {v}
            </button>
          ))}
        </div>

        {view === "preview" && (
          <div className="flex overflow-hidden rounded-md border border-border">
            {(["desktop", "mobile"] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-label={`${d} width`}
                aria-pressed={device === d}
                onClick={() => setDevice(d)}
                className={cn(
                  "px-2.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  device === d
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {d === "desktop" ? (
                  <Monitor className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Smartphone className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        )}

        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {builtAt && <span>built {new Date(builtAt).toLocaleDateString()}</span>}
          {publishedUrl ? (
            <a
              href={publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {publishedUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <span>not published</span>
          )}
        </span>
      </div>

      {view === "preview" ? (
        <div className="flex justify-center rounded-lg border border-border bg-cool-surface p-3">
          <iframe
            sandbox=""
            srcDoc={html}
            title={`Preview of ${title}`}
            className={cn(
              "h-[70vh] rounded border border-border bg-white transition-all",
              device === "mobile" ? "w-[390px]" : "w-full",
            )}
          />
        </div>
      ) : (
        <pre className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed text-foreground">
          {html}
        </pre>
      )}
    </div>
  );
}
