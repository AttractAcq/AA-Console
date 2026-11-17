import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Review = Pick<Database["public"]["Tables"]["google_reviews"]["Row"],
  "id" | "author_name" | "comment" | "review_url" | "reviewed_at" |
  "star_rating" | "gone_at" | "captured_proof_id">;

export function ProofIntegrationCapture({ clientId }: { clientId: string }) {
  const request = useRef(0);
  const [result, setResult] = useState<{
    clientId: string; reviews: Review[]; loading: boolean; error: string | null;
  }>({ clientId, reviews: [], loading: true, error: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ clientId: string; text: string } | null>(null);
  const visible = result.clientId === clientId
    ? result : { clientId, reviews: [] as Review[], loading: true, error: null };

  const refresh = useCallback(async () => {
    const version = ++request.current;
    setResult({ clientId, reviews: [], loading: true, error: null });
    const { data, error: queryError } = await supabase.from("google_reviews")
      .select("id,author_name,comment,review_url,reviewed_at,star_rating,gone_at,captured_proof_id")
      .eq("client_id", clientId).order("reviewed_at", { ascending: false }).limit(100);
    if (version !== request.current) return;
    setResult({ clientId, reviews: queryError ? [] : data ?? [], loading: false,
      error: queryError?.message ?? null });
  }, [clientId]);

  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [refresh]);

  async function capture(reviewId: string) {
    setBusy(reviewId);
    setResult((current) => current.clientId === clientId
      ? { ...current, error: null } : current);
    const { error: captureError } = await supabase.rpc("capture_google_review_as_proof_v6", {
      p_review_id: reviewId,
    });
    setBusy(null);
    if (captureError) {
      setResult((current) => current.clientId === clientId
        ? { ...current, error: captureError.message } : current);
      return;
    }
    setNotice({ clientId, text: "Review captured as raw proof. Clear its rights before using it." });
    await refresh();
  }

  return <section className="space-y-4">
    <p className="text-sm text-muted-foreground">
      Google Business Profile reviews can enter the Proof Bank with their original URL,
      author, date and text. A captured review starts uncleared. Other provider imports
      require a verified connector.
    </p>
    <Link className="text-sm text-brand-strong underline-offset-2 hover:underline"
      to={`/clients/${clientId}/delivery/google-profile?tab=reviews`}>
      Check Google profile connection and reviews
    </Link>
    {visible.error && <p role="alert" className="text-sm text-destructive">{visible.error}</p>}
    {notice?.clientId === clientId && <p role="status" className="text-sm text-brand-strong">{notice.text}</p>}
    {visible.loading ? <p className="text-sm text-muted-foreground">Loading reviews…</p>
      : visible.reviews.length === 0 ? <p className="text-sm text-muted-foreground">
        No ingested Google reviews are available. Verify the location and review ingest in Google Studio.
      </p> : <div className="space-y-3">{visible.reviews.map((review) => {
        const blocker = review.captured_proof_id && review.gone_at
          ? "Captured; source removed — rights held"
          : review.captured_proof_id ? "Already captured"
          : review.gone_at ? "Removed from Google"
          : !review.comment?.trim() ? "No review text"
          : !review.review_url?.trim() ? "No source URL"
          : !review.reviewed_at ? "No review date" : null;
        return <article key={review.id} className="rounded-lg border border-border bg-card p-4 text-sm">
          <p className="font-medium">{review.author_name || "Unknown reviewer"}
            {review.star_rating ? ` · ${review.star_rating} stars` : ""}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {review.reviewed_at ? new Date(review.reviewed_at).toLocaleDateString() : "Date unknown"}
            {review.review_url && <> · <a className="underline" href={review.review_url}
              target="_blank" rel="noreferrer">Original review</a></>}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{review.comment || "No review text"}</p>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={busy !== null || blocker !== null}
              onClick={() => void capture(review.id)}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
              {busy === review.id ? "Capturing…" : "Capture as raw proof"}
            </button>
            {blocker && <span className="text-xs text-muted-foreground">{blocker}</span>}
          </div>
        </article>;
      })}</div>}
  </section>;
}
