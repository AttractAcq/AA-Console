import { useState } from "react";
import { callRuntime } from "../../lib/callRuntime";
import { publishBlocker, type PublishablePage, type SiteRepo } from "../../pages/sites/readiness";

export type PublishResult = { url: string; commit: string; changed: boolean };

/**
 * Put a page live, or say why it cannot go.
 *
 * Shared between the Page Builder and the Sites tab because they were about to
 * be two implementations of the same button, and two implementations of a
 * button that publishes to the open internet will not stay the same for long.
 *
 * The runtime does the work and re-checks everything; the blocker here only
 * spares somebody a round trip to find out what they already could have been
 * told.
 */
export function PublishButton({
  page,
  repos,
  onPublished,
}: {
  page: PublishablePage & { publish_status: string };
  repos: SiteRepo[];
  onPublished: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const blocker = publishBlocker(page, repos);
  const live = page.publish_status === "published" && page.published_url;

  const publish = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await callRuntime<PublishResult>("/admin/sites/publish", { pageId: page.id });
      // "Nothing changed" is the common case when republishing and would read
      // as a failure if the button simply went quiet.
      setNotice(
        result.changed
          ? `Published. Live at ${result.url}`
          : `Already live at ${result.url} — nothing had changed.`,
      );
      onPublished();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Publishing failed.");
    }
    setBusy(false);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || blocker !== null}
          onClick={() => void publish()}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {busy ? "Publishing…" : live ? "Republish" : "Publish"}
        </button>

        {live && (
          <a
            href={page.published_url as string}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate text-xs text-brand-strong hover:underline"
          >
            {page.published_url}
          </a>
        )}

        {page.publish_status === "publishing" && !busy && (
          <span className="text-xs text-muted-foreground">Publishing…</span>
        )}
      </div>

      {/* A disabled button with no stated reason is the most annoying thing a
          tool can do, so the reason is always on screen. */}
      {blocker && <p className="mt-1 text-xs text-muted-foreground">{blocker}</p>}
      {notice && <p role="status" className="mt-1 text-xs text-brand-strong">{notice}</p>}
      {problem && <p role="alert" className="mt-1 text-xs text-destructive">{problem}</p>}
    </div>
  );
}
