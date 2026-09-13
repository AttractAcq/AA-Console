import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import {
  groupFindings,
  isSelectable,
  readinessLine,
  reviseBlocker,
  revisionSourceLabel,
  selectableIds,
  usableSelection,
  type Finding,
  type Revision,
} from "./polish";

const SEVERITY_TONE: Record<string, string> = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-secondary text-secondary-foreground",
  low: "bg-muted text-muted-foreground",
};

/**
 * Audit, revise and revert, inside the page modal.
 *
 * The needs-person gaps are shown as outstanding work, never as failures —
 * "this page still needs a testimonial" is a true and useful statement about a
 * good page, not an error about a broken one.
 */
export function PagePolish({
  pageId,
  clientId,
  currentRevision,
  onChanged,
}: {
  pageId: string;
  clientId: string;
  currentRevision: number | null;
  onChanged: () => void;
}) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [f, r] = await Promise.all([
      supabase
        .from("client_page_findings")
        .select(
          "id, category, severity, title, explanation, suggested_direction, classification, status, revision_number",
        )
        .eq("page_id", pageId),
      supabase
        .from("client_page_revisions")
        .select("id, revision_number, source, summary, created_at")
        .eq("page_id", pageId)
        .order("revision_number", { ascending: false }),
    ]);
    setFindings((f.data as Finding[] | null) ?? []);
    setRevisions((r.data as Revision[] | null) ?? []);
  }, [pageId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = groupFindings(findings);
  const blocker = reviseBlocker(selected, findings);

  const run = async (agentKey: "page_audit" | "page_revise") => {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase.rpc("enqueue_agent_job", {
      p_agent_key: agentKey,
      p_client_id: clientId,
      p_input_table: "client_pages",
      p_input_id: pageId,
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    setNotice(
      agentKey === "page_audit"
        ? "Audit queued. Findings appear here when it finishes."
        : "Revision queued. A new version appears here when it finishes.",
    );
  };

  const applySelected = async () => {
    // Narrowed against what is actually selectable, so a tick left over from a
    // previous audit cannot be submitted.
    const usable = usableSelection(selected, findings);
    if (usable.length === 0) return;
    setBusy(true);
    setProblem(null);
    const { error } = await supabase
      .from("client_page_findings")
      .update({ status: "selected", updated_at: new Date().toISOString() })
      .in("id", usable);
    if (error) {
      setBusy(false);
      setProblem(error.message);
      return;
    }
    setBusy(false);
    await run("page_revise");
    setSelected([]);
    void refresh();
  };

  const revert = async (revisionNumber: number) => {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase.rpc("revert_page_to_revision", {
      p_page_id: pageId,
      p_revision_number: revisionNumber,
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    setNotice(`Reverted to revision ${revisionNumber}. Nothing newer was deleted.`);
    void refresh();
    onChanged();
  };

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const Card = ({ finding }: { finding: Finding }) => {
    const selectable = isSelectable(finding);
    return (
      <li className="rounded-lg border border-border p-3">
        <div className="flex items-start gap-2">
          {selectable && (
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(finding.id)}
              onChange={() => toggle(finding.id)}
              aria-label={`Select: ${finding.title}`}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-card-foreground">{finding.title}</p>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  SEVERITY_TONE[finding.severity] ?? SEVERITY_TONE.medium,
                )}
              >
                {finding.severity}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {finding.category.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{finding.explanation}</p>
            {finding.suggested_direction && (
              <p className="mt-1 text-xs text-muted-foreground">
                Direction: {finding.suggested_direction}
              </p>
            )}
          </div>
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Polish</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{readinessLine(grouped)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("page_audit")}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Audit page
          </button>
          {grouped.fixable.length > 0 && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setSelected(selectableIds(findings))}
                className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Select all fixable
              </button>
              <button
                type="button"
                disabled={busy || blocker !== null}
                title={blocker ?? undefined}
                onClick={() => void applySelected()}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Apply selected fixes
              </button>
            </>
          )}
        </div>
      </div>

      {notice && (
        <p role="status" className="text-xs text-brand-strong">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}

      {findings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Not audited yet. An audit reports what is wrong without changing anything.
        </p>
      ) : (
        <>
          {grouped.fixable.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-foreground">
                Fixable — the reviser can do these
              </h4>
              <ul className="mt-2 space-y-2">
                {grouped.fixable.map((f) => (
                  <Card key={f.id} finding={f} />
                ))}
              </ul>
            </section>
          )}

          {grouped.needsPerson.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-destructive">Needs a person</h4>
              {/* Stated as outstanding work, not as a failure. These are the
                  facts nobody has yet — an agent writing one would be inventing
                  proof, which is the failure this whole loop exists to avoid. */}
              <p className="mt-0.5 text-xs text-muted-foreground">
                These need a real testimonial, price, guarantee or credential. No agent can write
                them — someone has to supply the fact.
              </p>
              <ul className="mt-2 space-y-2">
                {grouped.needsPerson.map((f) => (
                  <Card key={f.id} finding={f} />
                ))}
              </ul>
            </section>
          )}

          {grouped.stale.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-muted-foreground">
                From an earlier revision
              </h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Found against an older version. They may still be true — nothing has re-checked.
              </p>
              <ul className="mt-2 space-y-2">
                {grouped.stale.map((f) => (
                  <Card key={f.id} finding={f} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="border-t border-border pt-4">
        <h4 className="text-xs font-semibold text-foreground">Version history</h4>
        {revisions.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No revisions recorded yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {revisions.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-card-foreground">
                    Revision {r.revision_number}
                    {r.revision_number === currentRevision && (
                      <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-brand-strong">
                        Current
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {revisionSourceLabel(r.source)} · {new Date(r.created_at).toLocaleString()}
                  </p>
                  {r.summary && <p className="mt-1 text-xs text-muted-foreground">{r.summary}</p>}
                </div>
                {r.revision_number !== currentRevision && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revert(r.revision_number)}
                    className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Revert to this
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
