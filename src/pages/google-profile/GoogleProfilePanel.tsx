import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { PROFILE_FIELD_PATCH_HOLD } from "../../../agent-runtime/src/profiles/prewrite-gate.js";

type Location = Database["public"]["Tables"]["client_google_locations"]["Row"];
type ProfileDue = Database["public"]["Views"]["google_profile_due"]["Row"];
type ProfileChange = Pick<Database["public"]["Tables"]["google_profile_changes"]["Row"],
  "id" | "location_id" | "field" | "current_value" | "proposed_value" | "status">;
type Review = Database["public"]["Tables"]["google_reviews"]["Row"];
type Reply = Database["public"]["Tables"]["google_review_replies"]["Row"];
type Placement = Database["public"]["Tables"]["proof_placements"]["Row"];

type Tab = "location" | "reviews" | "posts" | "metrics";

/**
 * Google Profile.
 *
 * The transport arrived before the page: migration 231 brought up the proof
 * placement sweep and the local-posts adapter, so a cleared proof derivative
 * can already reach a real profile. What never existed was any record of the
 * profile itself.
 *
 * Reviews are the reason this page matters more than it looks. Proof Bank's
 * first named source is "online reviews", and until now they were retyped
 * from a browser tab — so the author, the url and the date were whatever
 * somebody copied, and a deleted review left a proof asset quoting something
 * that no longer exists. Capturing one from here carries the thing itself.
 *
 * Posts is a mirror, deliberately. Placements are made in Proof Distribution
 * and performed by the sweep; a second publisher on this page would be two
 * things that can post to one profile.
 */
export function GoogleProfilePanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  // The router reuses this page between clients. Remount the client-owned
  // state, including open forms and notices, before rendering another client.
  return <GoogleProfileClientPanel key={clientId ?? "no-client"} clientId={clientId} tab={tab} />;
}

function GoogleProfileClientPanel({ clientId, tab }: { clientId?: string; tab: Tab }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [due, setDue] = useState<ReadonlyMap<string, ProfileDue>>(new Map());
  const [changes, setChanges] = useState<ProfileChange[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectOpening, setConnectOpening] = useState<number | null>(null);
  const [replyOpening, setReplyOpening] = useState<{ id: number; review: Review } | null>(null);
  const nextOpeningId = useRef(0);
  const connectOpeningRef = useRef<number | null>(null);
  const replyOpeningRef = useRef<number | null>(null);
  const requestGeneration = useRef(0);
  const activeVisit = useRef(true);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => activeVisit.current && requestGeneration.current === generation;
    if (!clientId) {
      if (isCurrent()) setLoading(false);
      return;
    }
    try {
      const [locs, board, proposed, revs, reps, place] = await Promise.all([
        supabase
          .from("client_google_locations")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase.from("google_profile_due").select("*").eq("client_id", clientId),
        supabase.from("google_profile_changes")
          .select("id,location_id,field,current_value,proposed_value,status")
          .eq("client_id", clientId).order("created_at", { ascending: false }).limit(100),
        supabase
          .from("google_reviews")
          .select("*")
          .eq("client_id", clientId)
          .order("reviewed_at", { ascending: false })
          .limit(100),
        supabase.from("google_review_replies").select("*").eq("client_id", clientId),
        supabase
          .from("proof_placements")
          .select("*")
          .eq("client_id", clientId)
          .eq("destination_key", "google_business_profile")
          .order("created_at", { ascending: false }),
      ]);
      for (const result of [locs, board, proposed, revs, reps, place]) {
        if (result.error) throw new Error(result.error.message);
      }
      if (!isCurrent()) return;
      setLocations(locs.data ?? []);
      setDue(new Map((board.data ?? []).map((r) => [String(r.location_id), r])));
      setChanges(proposed.data ?? []);
      setReviews(revs.data ?? []);
      setReplies(reps.data ?? []);
      setPlacements(place.data ?? []);
      setError(null);
    } catch (cause) {
      if (isCurrent()) {
        setError(cause instanceof Error ? cause.message : "Could not load the profile.");
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    activeVisit.current = true;
    void refresh();
    return () => {
      activeVisit.current = false;
      requestGeneration.current += 1;
    };
  }, [refresh]);

  function openConnect() {
    if (!activeVisit.current) return;
    const opening = ++nextOpeningId.current;
    connectOpeningRef.current = opening;
    setConnectOpening(opening);
  }

  function closeConnect(opening: number | null) {
    if (!activeVisit.current || opening === null || connectOpeningRef.current !== opening) return;
    connectOpeningRef.current = null;
    setConnectOpening(null);
  }

  function openReply(review: Review) {
    if (!activeVisit.current || review.client_id !== clientId) return;
    const opening = ++nextOpeningId.current;
    replyOpeningRef.current = opening;
    setReplyOpening({ id: opening, review });
  }

  function closeReply(opening: number | null) {
    if (!activeVisit.current || opening === null || replyOpeningRef.current !== opening) return;
    replyOpeningRef.current = null;
    setReplyOpening(null);
  }

  async function act(key: string, work: () => Promise<void>, said: string) {
    if (!activeVisit.current || busy) return;
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await work();
      if (!activeVisit.current) return;
      setNotice(said);
      await refresh();
    } catch (cause) {
      if (activeVisit.current) {
        setError(cause instanceof Error ? cause.message : "Something went wrong.");
      }
    } finally {
      if (activeVisit.current) setBusy(null);
    }
  }

  const replyFor = (reviewId: string) =>
    replies.find((r) => r.review_id === reviewId && r.status !== "rejected");

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {tab === "location" && (
        <div className="space-y-4">
          <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {PROFILE_FIELD_PATCH_HOLD}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
            <div>
              <p className="text-sm font-medium">
                {locations.length === 0
                  ? "No location is connected"
                  : `${locations.length} location${locations.length === 1 ? "" : "s"} connected`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Reading a profile is not changing one. Profile field proposals stay recorded
                under the hold above. Review replies require their own decision, and proof
                reaches the profile through Proof Distribution.
              </p>
            </div>
            <Button onClick={openConnect}>
              Connect a location
            </Button>
          </div>

          {locations.length === 0 && !loading ? (
            <EmptyState label="Connect the client's Business Profile location to read it" />
          ) : (
            locations.map((location) => {
              const board = due.get(location.id);
              return (
                <section key={location.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold">{location.title}</h3>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {location.location_ref}
                      </p>
                    </div>
                    <span
                      className={
                        location.verification_state === "verified"
                          ? "text-xs text-brand-strong"
                          : "text-xs text-destructive"
                      }
                    >
                      {location.verification_state.replace(/_/g, " ")}
                    </span>
                  </div>

                  <p
                    className={
                      board?.blocker
                        ? "mt-3 text-sm text-destructive"
                        : "mt-3 text-sm text-brand-strong"
                    }
                  >
                    {board?.blocker ?? "No location-read blocker was reported."}
                  </p>

                  <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">Reviews</dt>
                      <dd className="text-lg">{board?.reviews ?? 0}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Unanswered</dt>
                      <dd className={Number(board?.unanswered ?? 0) > 0 ? "text-lg text-destructive" : "text-lg"}>
                        {board?.unanswered ?? 0}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Captured as proof</dt>
                      <dd className="text-lg">{board?.captured_as_proof ?? 0}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Gone but cited</dt>
                      <dd
                        className={
                          Number(board?.gone_but_cited ?? 0) > 0 ? "text-lg text-destructive" : "text-lg"
                        }
                        title="Reviews that have left the profile while a proof asset still rests on them"
                      >
                        {board?.gone_but_cited ?? 0}
                      </dd>
                    </div>
                  </dl>

                  {(location.missing_fields ?? []).length > 0 && (
                    <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                      Missing from the profile: {(location.missing_fields ?? []).join(", ")}. A
                      field proposal is recorded for review; automatic field PATCH is held.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last read {dayOrDash(location.last_read_at)}
                  </p>
                </section>
              );
            })
          )}
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div>
              <h3 className="font-semibold">Recent recorded field proposals</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Approval in the older profile-change table does not authorize a provider PATCH.
                These records need an exact Approval Inbox decision and prewrite verification.
              </p>
            </div>
            <DataTable
              columns={["Location", "Field", "Current", "Proposed", "Record status", "Execution"]}
              emptyLabel={loading ? "Loading…" : "No profile field proposal has been recorded"}
              rows={changes.map((change) => [
                <span key="location" className="text-xs">
                  {locations.find((location) => location.id === change.location_id)?.title ?? "Unknown location"}
                </span>,
                <span key="field">{change.field.replace(/_/g, " ")}</span>,
                <span key="current" className="text-xs">{change.current_value ?? "empty"}</span>,
                <span key="proposed" className="text-xs">{change.proposed_value}</span>,
                <span key="status">{change.status.replace(/_/g, " ")}</span>,
                <span key="execution" className={change.status === "applied"
                  ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                  {change.status === "applied"
                    ? "Recorded as applied; external readback remains separate."
                    : change.status === "rejected"
                      ? "Rejected; no field PATCH."
                      : "Held; no field PATCH will be claimed."}
                </span>,
              ])}
            />
          </section>
        </div>
      )}

      {tab === "reviews" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Capturing a review brings its author, its url and its date with it, and it arrives in
            the Proof Bank uncleared — a public review is not a blanket permission to republish
            it.
          </p>
          <DataTable
            columns={["Review", "Rating", "When", "Proof", "Reply", "Actions"]}
            emptyLabel={loading ? "Loading reviews…" : "No reviews have been read yet"}
            rows={reviews.map((r) => {
              const reply = replyFor(r.id);
              return [
                <span key="r">
                  {r.author_name ?? "A Google reviewer"}
                  <span className="block text-xs text-muted-foreground">
                    {(r.comment ?? "No words").slice(0, 80)}
                    {(r.comment ?? "").length > 80 ? "…" : ""}
                  </span>
                  {r.gone_at && (
                    <span className="block text-xs text-destructive">
                      No longer on the profile
                    </span>
                  )}
                </span>,
                <span key="s">{r.star_rating ?? "—"}</span>,
                <span key="w">{dayOrDash(r.reviewed_at)}</span>,
                <span key="p" className={r.captured_proof_id ? "text-brand-strong" : "text-muted-foreground"}>
                  {r.captured_proof_id ? "captured" : "not captured"}
                </span>,
                <span key="y" className="text-xs">
                  {reply ? reply.status.replace(/_/g, " ") : "none"}
                  {reply && (reply.status === "drafted" || reply.status === "awaiting_approval")
                    && clientId && (
                      <Link className="mt-1 block text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        to={`/clients/${encodeURIComponent(clientId)}/delivery/approval-inbox?tab=unified`}>
                        Review in Approval Inbox
                      </Link>
                    )}
                </span>,
                <ActionMenu
                  key="a"
                  name={r.author_name ?? "this review"}
                  busy={busy === r.id}
                  items={[
                    ...(!r.captured_proof_id && r.comment
                      ? [{
                          label: "Capture as proof",
                          onSelect: () =>
                            void act(
                              r.id,
                              async () => {
                                const { error: rpcError } = await supabase.rpc(
                                  "capture_google_review_as_proof_v6",
                                  { p_review_id: r.id },
                                );
                                if (rpcError) throw new Error(rpcError.message);
                              },
                              "Captured into the Proof Bank, uncleared.",
                            ),
                        }]
                      : []),
                    ...(!reply && !r.gone_at
                      ? [{ label: "Draft a reply", onSelect: () => openReply(r) }]
                      : []),
                  ]}
                />,
              ];
            })}
          />
        </div>
      )}

      {tab === "posts" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A mirror, not a second publisher. These placements are made in Proof Distribution and
            performed by the proof placement sweep; two things able to post to one profile is how
            a client gets the same testimonial twice.
          </p>
          <DataTable
            columns={["Status", "External record", "Attempts", "When"]}
            emptyLabel={loading ? "Loading…" : "No proof has been placed on this profile"}
            rows={placements.map((p) => [
              <span key="s">{p.status.replace(/_/g, " ")}</span>,
              <span key="e" className="font-mono text-xs">
                {p.external_url ? (
                  <a href={p.external_url} target="_blank" rel="noreferrer" className="underline">
                    {p.external_id ?? "view"}
                  </a>
                ) : (
                  (p.external_id ?? "—")
                )}
              </span>,
              <span key="a">{p.attempts}</span>,
              <span key="w">{dayOrDash(p.placed_at ?? p.created_at)}</span>,
            ])}
          />
        </div>
      )}

      {tab === "metrics" && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="font-semibold">Profile metrics</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Views, searches and actions come from the Business Profile performance API, which
            nothing in this runtime calls yet. Rather than show zeroes that look like data, this
            says so: the ingest is the next slice, and it needs the same{" "}
            <code className="text-xs">google_business</code> credential the rest of this page is
            waiting on.
          </p>
        </div>
      )}

      <FormModal
        key={`connect-${connectOpening ?? "closed"}`}
        open={connectOpening !== null}
        onClose={() => closeConnect(connectOpening)}
        title="Connect a Business Profile location"
        submitLabel="Connect"
        intro="The location as Google addresses it. Connecting records it; it reads nothing until a google_business credential exists on the Integrations page."
        fields={[
          {
            name: "location_ref", label: "Location", kind: "text", required: true,
            placeholder: "accounts/1184772/locations/7730991",
            hint: "Copy it from the Business Profile API or the profile URL. The same handle proof placement uses.",
          },
          { name: "title", label: "What it is called", kind: "text", required: true },
          { name: "address", label: "Address", kind: "text" },
        ]}
        onSubmit={async (values) => {
          if (!activeVisit.current || !clientId) {
            throw new Error("Client selection changed. Reopen the form.");
          }
          if (connectOpening === null || connectOpeningRef.current !== connectOpening) {
            throw new Error("This form has been replaced. Reopen it.");
          }
          const { error: insertError } = await supabase.from("client_google_locations").insert({
            client_id: clientId,
            location_ref: String(values.location_ref).trim(),
            title: String(values.title).trim(),
            address: values.address ? String(values.address).trim() : null,
          });
          if (insertError) throw new Error(insertError.message);
          if (activeVisit.current && connectOpeningRef.current === connectOpening) {
            setNotice("Connected. Nothing is read until a credential exists.");
          }
        }}
        onSaved={() => {
          if (!activeVisit.current || connectOpeningRef.current !== connectOpening) return;
          closeConnect(connectOpening);
          void refresh();
        }}
      />

      <FormModal
        key={`reply-${replyOpening?.id ?? "closed"}`}
        open={replyOpening !== null}
        onClose={() => closeReply(replyOpening?.id ?? null)}
        title={replyOpening ? `Reply to ${replyOpening.review.author_name ?? "a review"}` : "Draft a reply"}
        submitLabel="Save the draft"
        intro="A reply is an external effect on somebody else's profile, so it waits for approval. The exact words are hashed: editing them afterwards means asking again."
        fields={[
          { name: "body", label: "Reply", kind: "textarea", required: true, rows: 5 },
        ]}
        onSubmit={async (values) => {
          if (!activeVisit.current || !clientId || !replyOpening || replyOpening.review.client_id !== clientId) {
            throw new Error("Client selection changed. Reopen the form.");
          }
          if (replyOpeningRef.current !== replyOpening.id) {
            throw new Error("This form has been replaced. Reopen it.");
          }
          const { error: rpcError } = await supabase.rpc("draft_google_review_reply_v6", {
            p_review_id: replyOpening.review.id,
            p_body: String(values.body),
          });
          if (rpcError) throw new Error(rpcError.message);
          if (activeVisit.current && replyOpeningRef.current === replyOpening.id) {
            setNotice("Drafted. It waits for a person.");
          }
        }}
        onSaved={() => {
          if (!activeVisit.current || !replyOpening || replyOpeningRef.current !== replyOpening.id) return;
          closeReply(replyOpening.id);
          void refresh();
        }}
      />
    </div>
  );
}
