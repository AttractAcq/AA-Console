import { useCallback, useEffect, useState } from "react";
import { RichText } from "../markdown/RichText";
import { ConceptWorkspace } from "./ConceptWorkspace";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

type Brief = {
  id: string;
  client_id?: string;
  title: string;
  body: string | null;
  media_type: "image" | "text" | "video";
  brief_ref: string | null;
  status: string;
  source_idea_id?: string | null;
  created_at?: string;
  // Structured brief. Null on the briefs written before Brief Studio existed,
  // which still carry their prose in `body`.
  hook?: string | null;
  premise?: string | null;
  argument?: string | null;
  proof?: string | null;
  script?: string | null;
  visual_direction?: string | null;
  shot_requirements?: string | null;
  b_roll?: string | null;
  call_to_action?: string | null;
  channel_intent?: string | null;
  production_method?: string | null;
  proof_asset_id?: string | null;
};

type LinkedProof = {
  ref_number: string | null;
  claim: string | null;
  strength: string;
  usage_rights: string;
  avatar_relevance: string | null;
};

/**
 * The order a maker reads them in, which is not the order they are stored in.
 * Video-only fields are simply absent on a still or a text piece — that is
 * correct, not a gap, so unlike the brand profile nothing is shown as unset.
 */
const BRIEF_FIELDS: Array<[keyof Brief, string]> = [
  ["hook", "Hook"],
  ["premise", "Premise"],
  ["argument", "Argument"],
  ["proof", "Proof"],
  ["script", "Script"],
  ["visual_direction", "Visual direction"],
  ["shot_requirements", "Shot requirements"],
  ["b_roll", "B-roll"],
  ["call_to_action", "Call to action"],
  ["channel_intent", "Channel"],
];

type Idea = {
  title: string;
  body: string | null;
  source_question: string | null;
  strategic_reason: string | null;
  content_territory: string | null;
  source: string | null;
};

import type { Generation } from "./ConceptWorkspace";

type Dispatch = {
  id: string;
  email_status: string;
  email_error: string | null;
  emailed_at: string | null;
  created_at: string;
  team_members: { name: string; category: string } | null;
};

const STAGE_TONE: Record<string, string> = {
  done: "bg-primary/10 text-brand-strong",
  failed: "bg-destructive/10 text-destructive",
  concept: "bg-secondary text-secondary-foreground",
  render: "bg-secondary text-secondary-foreground",
};

const EMAIL_TONE: Record<string, string> = {
  sent: "bg-primary/10 text-brand-strong",
  failed: "bg-destructive/10 text-destructive",
  skipped: "bg-secondary text-secondary-foreground",
  pending: "bg-secondary text-secondary-foreground",
};

/**
 * Everything known about one brief, in one place.
 *
 * The brief body is the agent's own structured markdown, so it is rendered
 * rather than dumped as plain text. Below it sits what the brief came from
 * and what has happened to it since — the concepts written, the assets
 * produced, and who it was sent to — because those were previously stored
 * and never shown anywhere.
 */
export function BriefDetailModal({
  brief,
  open,
  onClose,
}: {
  brief: Brief | null;
  open: boolean;
  onClose: () => void;
}) {
  const [idea, setIdea] = useState<Idea | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [linkedProof, setLinkedProof] = useState<LinkedProof | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!brief) return;
    setLoading(true);
    const [ideaRes, genRes, dispRes] = await Promise.all([
      brief.source_idea_id
        ? supabase
            .from("client_ideas")
            .select("title, body, source_question, strategic_reason, content_territory, source")
            .eq("id", brief.source_idea_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("creative_generations")
        .select("id, stage, concept, quality, size, reference_path, concept_model, image_model, concept_edited_at, cost_usd, error, created_at, media_type")
        .eq("brief_id", brief.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("brief_dispatches")
        .select("id, email_status, email_error, emailed_at, created_at, team_members(name, category)")
        .eq("brief_id", brief.id)
        .order("created_at", { ascending: false }),
    ]);

    setIdea((ideaRes.data ?? null) as Idea | null);

    // The proof record this brief actually relies on. Named in prose it is a
    // claim; linked it is checkable, and later answers which proof produced
    // revenue.
    if (brief.proof_asset_id) {
      const { data: proofRow } = await supabase
        .from("client_proof_assets")
        .select("ref_number, claim, strength, usage_rights, avatar_relevance")
        .eq("id", brief.proof_asset_id)
        .maybeSingle();
      setLinkedProof((proofRow as LinkedProof | null) ?? null);
    } else {
      setLinkedProof(null);
    }
    const gens = (genRes.data ?? []) as unknown as Generation[];
    setGenerations(gens);
    setDispatches((dispRes.data ?? []) as unknown as Dispatch[]);

    setLoading(false);
  }, [brief]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!open || !brief) return null;

  const structured = BRIEF_FIELDS.filter(([key]) => {
    const value = brief[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  const money = (v: number | null) => (v === null ? "—" : `$${Number(v).toFixed(3)}`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-foreground/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-card-foreground">{brief.title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {brief.brief_ref ? `${brief.brief_ref} · ` : ""}
              <span className="capitalize">{brief.media_type}</span> ·{" "}
              <span className="capitalize">{brief.status.replace(/_/g, " ")}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {idea && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Where this came from
              </h3>
              <dl className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm sm:grid-cols-2">
                {[
                  ["The idea", idea.title],
                  ["Buyer question it answers", idea.source_question],
                  ["Why it matters", idea.strategic_reason],
                  ["Content territory", idea.content_territory],
                ].map(([label, value]) =>
                  value ? (
                    <div key={label as string} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-sm text-foreground">{value}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </section>
          )}

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                The brief
              </h3>
              {brief.production_method && (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium capitalize text-secondary-foreground">
                  {brief.production_method}
                </span>
              )}
            </div>

            {linkedProof && (
              <div className="mb-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Backed by {linkedProof.ref_number ?? "a proof record"}
                </p>
                <p className="mt-1 text-sm text-foreground">
                  {linkedProof.claim ?? "No claim recorded on that proof."}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  strength {linkedProof.strength}
                  {linkedProof.avatar_relevance ? ` · ${linkedProof.avatar_relevance}` : ""}
                  {/* A brief can outlive the clearance that justified it. */}
                  {linkedProof.usage_rights !== "approved" && (
                    <span className="font-medium text-destructive">
                      {" "}· no longer cleared for use
                    </span>
                  )}
                </p>
              </div>
            )}

            {structured.length > 0 ? (
              <dl className="divide-y divide-border/60 rounded-lg border border-border">
                {structured.map(([key, label]) => (
                  <div key={key as string} className="px-4 py-3">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                      {String(brief[key])}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              // Briefs written before Brief Studio have prose and no fields.
              // Rendering the markdown keeps them readable rather than blank.
              <div className="rounded-lg border border-border p-4 text-sm text-foreground">
                {brief.body ? (
                  <RichText text={brief.body} />
                ) : (
                  <p className="text-muted-foreground">This brief has no detail beyond its title.</p>
                )}
              </div>
            )}
          </section>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading history…</p>
          ) : (
            <>
              {generations.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Builds ({generations.length})
                  </h3>
                  <ul className="space-y-2">
                    {generations.map((g) => (
                      <li key={g.id} className="rounded-lg border border-border">
                        <button
                          type="button"
                          onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                          className="flex w-full items-center gap-3 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                                STAGE_TONE[g.stage] ?? "bg-muted text-muted-foreground",
                              )}
                            >
                              {g.stage}
                            </span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {new Date(g.created_at).toLocaleString()} · {g.quality} · {g.size}
                              {g.reference_path ? " · from a reference image" : ""} · {money(g.cost_usd)}
                            </span>
                            {g.error && (
                              <span className="mt-1 block text-xs text-destructive">{g.error}</span>
                            )}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {expanded === g.id ? "Hide" : "Open"}
                          </span>
                        </button>

                        {expanded === g.id && (
                          <ConceptWorkspace generation={g} onChanged={() => void load()} />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {dispatches.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Sent to
                  </h3>
                  <ul className="space-y-1.5">
                    {dispatches.map((d) => (
                      <li key={d.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                        <span className="min-w-0 flex-1 text-sm text-foreground">
                          {d.team_members?.name ?? "Unknown"}
                          <span className="ml-2 text-xs capitalize text-muted-foreground">
                            {d.team_members?.category}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            EMAIL_TONE[d.email_status] ?? "bg-muted text-muted-foreground",
                          )}
                          title={d.email_error ?? undefined}
                        >
                          {d.email_status === "skipped" ? "no email configured" : `email ${d.email_status}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    The work is on their dashboard either way — the email is only the heads-up.
                  </p>
                </section>
              )}

              {generations.length === 0 && dispatches.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nothing has been built or sent from this brief yet.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
